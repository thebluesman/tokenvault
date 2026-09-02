// The only module that calls a Figma **write** API — ADR-0005 §3.
//
// Same boundary precedent as `scan.ts` and `scanStyles.ts` in the other direction: every schema
// decision lives in `src/tokens/toFigma.ts` and `plan.ts`, and this file does nothing but turn a
// plain-data `FigmaWriteOp` into the call that performs it. Nothing here decides anything.
//
// Three properties the executor has to hold, all from ADR-0005 §6:
//
//   - **Per-entry, not transactional.** Figma plugin writes are not, and a rollback pass has the
//     same failure modes as the pass it is undoing — a failed rollback leaves a state neither side
//     modelled. So entries are applied in the plan's order, each succeeds or fails independently,
//     and every failure is named in the result.
//   - **Nothing is half-applied within one entry.** A text style's font is loaded before any of its
//     properties are touched, because `loadFontAsync` is the one call that fails for reasons
//     outside the data (the font may simply not be installed on this machine).
//   - **One undo step, where the runtime allows it.** See `commitUndoStep` — the behaviour was
//     verified against the current plugin API and against a live file, not assumed.

import type { FigmaWriteOp, GridWrite, UnitValue } from "../tokens/toFigma";

/** One entry's result, keyed back to the plan by ADR-0004's target key. */
export interface WriteOutcome {
  key: string;
  ok: boolean;
  /** Present on failure, verbatim from Figma where Figma is the one refusing. */
  message?: string;
}

export interface PlannedWrite {
  /** Row identity — the plan's target key plus its op, so a value and a description edit differ. */
  key: string;
  /**
   * ADR-0004's target key on its own.
   *
   * Carried separately from `key` because drift is keyed by target, and the next scan has to be
   * able to tell "the plugin just wrote this" from "someone else changed it". Figma's own
   * `documentchange` makes the same distinction — it never notifies a plugin about its own edits —
   * and drift would be a nuisance rather than a signal without it.
   */
  targetKey: string;
  write: FigmaWriteOp;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Brackets a batch so it lands as exactly one entry in Figma's undo history.
 *
 * **Verified against `@figma/plugin-typings` rather than assumed** — ADR-0005 §6 and UX §5.5 both
 * flagged this as an open question, and the answer is more specific than "yes":
 *
 *   > By default, plugin actions are **not committed to undo history**. Call `figma.commitUndo()`
 *   > so that triggered undos can revert a subset of plugin actions.
 *
 * So a plugin's writes do coalesce — but into whatever undo entry happens to be open, which may
 * include work the *user* did before running the plugin. Undoing an apply would then also undo
 * their last canvas edit, which is worse than either outcome the ADR considered.
 *
 * Committing on both sides fixes that exactly: the leading call closes off everything that came
 * before, the trailing call closes off the batch, and the apply is its own single undo step with
 * nothing else in it. That is what lets UX §5.5's footer copy be sharpened from the deliberately
 * non-committal *"⌘Z in Figma is the only undo"* to a definite one.
 *
 * **Guarded, because it is an optimisation and not a precondition.** `commitUndo` is absent from
 * some Figma script runtimes — it throws `"commitUndo" is not a supported API` in the MCP
 * sandbox — and an unguarded call would abort every apply before a single write, which is a far
 * worse failure than a slightly coarser undo entry. Losing it costs only the *isolation* of the
 * step: the writes still land in Figma's undo history, just grouped with whatever preceded them.
 * The footer copy is true either way, which is why it says "⌘Z" and not "one ⌘Z".
 */
function commitUndoStep(): void {
  try {
    figma.commitUndo();
  } catch {
    // Older or restricted runtimes. The apply proceeds; only undo granularity is affected.
  }
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Runs a plan's writes, in order, and reports every one of them.
 *
 * Deliberately returns outcomes instead of throwing: a plan is a list of independent writes, and
 * one unloadable font must not cost the other six their apply.
 */
export async function applyWrites(writes: PlannedWrite[]): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = [];
  if (writes.length === 0) return outcomes;

  // Fonts first, and outside the undo bracket: loading one changes nothing in the document, and a
  // font that fails to load should not have opened an undo entry.
  const fonts = await loadFonts(writes);

  commitUndoStep();
  try {
    for (const planned of writes) {
      const fontError = fontFailure(planned.write, fonts);
      if (fontError !== undefined) {
        outcomes.push({ key: planned.key, ok: false, message: fontError });
        continue;
      }
      try {
        await runWrite(planned.write);
        outcomes.push({ key: planned.key, ok: true });
      } catch (error) {
        outcomes.push({ key: planned.key, ok: false, message: reason(error) });
      }
    }
  } finally {
    commitUndoStep();
  }

  return outcomes;
}

function fontKey(family: string, style: string): string {
  return `${family}\u0000${style}`;
}

/**
 * Loads every font the batch's text styles need, once each.
 *
 * `loadFontAsync` caches, so the deduplication is about round trips rather than correctness — but
 * doing it up front is what makes the per-entry guard below possible: an entry can be refused for
 * a missing font *before* any of its properties are written, which is the "never partially
 * applied" half of ADR-0005 §3.
 */
async function loadFonts(writes: PlannedWrite[]): Promise<Map<string, string | null>> {
  const wanted = new Map<string, FontName>();
  for (const planned of writes) {
    if (planned.write.kind !== "text-style") continue;
    const { family, style } = planned.write.text;
    wanted.set(fontKey(family, style), { family, style });
  }

  const loaded = new Map<string, string | null>();
  await Promise.all(
    Array.from(wanted.entries()).map(async ([key, font]) => {
      try {
        await figma.loadFontAsync(font);
        loaded.set(key, null);
      } catch (error) {
        loaded.set(
          key,
          `Couldn't load the font ${font.family} ${font.style} — ${reason(error)}`
        );
      }
    })
  );
  return loaded;
}

function fontFailure(write: FigmaWriteOp, fonts: Map<string, string | null>): string | undefined {
  if (write.kind !== "text-style") return undefined;
  const failure = fonts.get(fontKey(write.text.family, write.text.style));
  return failure === null || failure === undefined ? undefined : failure;
}

async function runWrite(write: FigmaWriteOp): Promise<void> {
  switch (write.kind) {
    case "variable-value": {
      const variable = await requireVariable(write.variableId);
      variable.setValueForMode(write.modeId, toVariableValue(write.value));
      return;
    }
    case "variable-alias": {
      const variable = await requireVariable(write.variableId);
      // ADR-0005 §11's whole write. Figma models the pointer natively, so there is nothing to
      // synthesise and multi-hop chains resolve at render time without the plugin walking them.
      variable.setValueForMode(write.modeId, { type: "VARIABLE_ALIAS", id: write.targetId });
      return;
    }
    case "variable-description": {
      const variable = await requireVariable(write.variableId);
      variable.description = write.description;
      return;
    }
    case "variable-remove": {
      const variable = await requireVariable(write.variableId);
      variable.remove();
      return;
    }
    case "paint-style": {
      const style = (await requireStyle(write.styleId, "PAINT")) as PaintStyle;
      style.paints = [
        {
          type: "SOLID",
          color: { r: write.paint.color.r, g: write.paint.color.g, b: write.paint.color.b },
          opacity: write.paint.opacity,
        },
      ];
      return;
    }
    case "text-style": {
      const style = (await requireStyle(write.styleId, "TEXT")) as TextStyle;
      // The font is already loaded — `applyWrites` refused this entry otherwise — so the first
      // property assignment cannot fail for a reason the caller has not already been told about.
      style.fontName = { family: write.text.family, style: write.text.style };
      style.fontSize = write.text.fontSize;
      style.letterSpacing = toLetterSpacing(write.text.letterSpacing);
      // Absent means the token carried no line height (ADR-0003 §3's `AUTO`), so Figma's is left
      // exactly as it is. Never defaulted — see `toFigma.ts`'s rule 1.
      if (write.text.lineHeight !== undefined) {
        style.lineHeight = toLineHeight(write.text.lineHeight);
      }
      return;
    }
    case "effect-style": {
      const style = (await requireStyle(write.styleId, "EFFECT")) as EffectStyle;
      style.effects = write.effects.map((effect) => ({
        type: effect.type,
        color: {
          r: effect.color.r,
          g: effect.color.g,
          b: effect.color.b,
          a: effect.color.a === undefined ? 1 : effect.color.a,
        },
        offset: { x: effect.offsetX, y: effect.offsetY },
        radius: effect.radius,
        spread: effect.spread,
        visible: true,
        blendMode: "NORMAL",
      })) as Effect[];
      return;
    }
    case "grid-style": {
      const style = (await requireStyle(write.styleId, "GRID")) as GridStyle;
      style.layoutGrids = write.grids.map(toLayoutGrid);
      return;
    }
    case "style-description": {
      const style = await requireStyle(write.styleId);
      style.description = write.description;
      return;
    }
    case "style-remove": {
      const style = await requireStyle(write.styleId);
      style.remove();
      return;
    }
  }
}

async function requireVariable(id: string): Promise<Variable> {
  const variable = await figma.variables.getVariableByIdAsync(id);
  if (variable === null) throw new Error("The Variable no longer exists in this file.");
  return variable;
}

async function requireStyle(id: string, type?: StyleType): Promise<BaseStyle> {
  const style = await figma.getStyleByIdAsync(id);
  if (style === null) throw new Error("The Style no longer exists in this file.");
  if (type !== undefined && style.type !== type) {
    // The plan was built against a scan; between then and now the id could in principle name a
    // different kind of style. Refusing beats writing paints onto a text style.
    throw new Error(`Expected a ${type} style but found a ${style.type} one.`);
  }
  return style;
}

function toVariableValue(value: FigmaWriteOp extends never ? never : unknown): VariableValue {
  if (typeof value === "object" && value !== null && "r" in (value as Record<string, unknown>)) {
    const color = value as { r: number; g: number; b: number; a?: number };
    // Figma accepts RGB or RGBA; an absent alpha is opaque, and materialising `a: 1` here would
    // make an opaque colour's write differ from the shape the scanner reads back.
    return color.a === undefined
      ? { r: color.r, g: color.g, b: color.b }
      : { r: color.r, g: color.g, b: color.b, a: color.a };
  }
  return value as VariableValue;
}

function toLetterSpacing(unit: UnitValue): LetterSpacing {
  return { value: unit.value, unit: unit.unit };
}

function toLineHeight(unit: UnitValue): LineHeight {
  return { value: unit.value, unit: unit.unit };
}

function toLayoutGrid(grid: GridWrite): LayoutGrid {
  if (grid.pattern === "GRID") {
    return { pattern: "GRID", visible: true, sectionSize: grid.sectionSize ?? 1 };
  }
  // Figma's `RowsColsLayoutGrid` requires `alignment`, `gutterSize`, `count` and `offset`, so the
  // absent-stays-absent rule cannot reach all the way here. The fallbacks are Figma's own defaults
  // rather than invented ones, and the case only arises for a grid Figma itself reported without
  // them — which `styleGuards` has already refused when it would lose anything.
  const alignment = (grid.alignment ?? "STRETCH") as "MIN" | "MAX" | "STRETCH" | "CENTER";
  return {
    pattern: grid.pattern,
    visible: true,
    alignment,
    gutterSize: grid.gutterSize ?? 0,
    count: grid.count ?? 1,
    offset: grid.offset ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The delete blast radius — UX §5.7
// ---------------------------------------------------------------------------

/** How many layers would lose a binding if a target were removed. */
export interface ConsumerCount {
  key: string;
  layers: number;
  /** Node ids, so the confirmation's `[ Show them ]` can select them on the canvas. */
  nodeIds: string[];
}

/**
 * Counts the layers bound to each target.
 *
 * UX §10 is firm that the confirmation must not open with placeholder counts — *the counts are the
 * screen* — so this runs before the delete screen renders, not after.
 *
 * Styles get `getStyleConsumersAsync`, which is exact and cheap. Variables have no reverse index
 * in the plugin API (no `findAllWithCriteria` criterion covers bound variables), so the only
 * honest answer is a document walk. That is expensive, and it is why this is reached from one
 * deliberate destructive action and from nowhere else — never on a render path.
 */
export async function countConsumers(
  targets: Array<{ key: string; variableId?: string; styleId?: string }>
): Promise<ConsumerCount[]> {
  const counts = new Map<string, ConsumerCount>();
  for (const target of targets) counts.set(target.key, { key: target.key, layers: 0, nodeIds: [] });

  const styleTargets = targets.filter((target) => typeof target.styleId === "string");
  await Promise.all(
    styleTargets.map(async (target) => {
      try {
        const style = await figma.getStyleByIdAsync(target.styleId as string);
        if (style === null) return;
        const consumers = await style.getStyleConsumersAsync();
        const entry = counts.get(target.key) as ConsumerCount;
        for (const consumer of consumers) {
          entry.layers += 1;
          if (entry.nodeIds.length < MAX_SHOWN) entry.nodeIds.push(consumer.node.id);
        }
      } catch {
        // A count we could not take is reported as zero rather than as a failed screen: the
        // referrer half of the blast radius (which is the blocking one) is computed locally and
        // does not depend on this.
      }
    })
  );

  const variableIds = new Map<string, string>();
  for (const target of targets) {
    if (typeof target.variableId === "string") variableIds.set(target.variableId, target.key);
  }
  if (variableIds.size > 0) walkForVariables(variableIds, counts);

  return Array.from(counts.values());
}

/** Enough to populate `[ Show them ]` without holding thousands of ids for a count. */
const MAX_SHOWN = 200;

function walkForVariables(variableIds: Map<string, string>, counts: Map<string, ConsumerCount>): void {
  const visit = (node: BaseNode): void => {
    const bound = (node as SceneNode).boundVariables as
      | Record<string, unknown>
      | undefined;
    if (bound !== undefined) {
      // Every target this node binds, deduplicated **across fields** before anything is counted.
      // One layer counts once per target however many of its fields bind it — the sentence is
      // "used by 14 layers", not "used 19 times" — and a node binding the same Variable through
      // both `fills` and `strokes` is exactly one layer that would lose exactly one binding.
      // Collecting first rather than breaking out of the inner loop also keeps a *single* field
      // that binds two different doomed Variables counting for both of them.
      const hit = new Set<string>();
      for (const field of Object.keys(bound)) {
        for (const id of aliasIds(bound[field])) {
          const key = variableIds.get(id);
          if (key !== undefined) hit.add(key);
        }
      }
      for (const key of hit) {
        const entry = counts.get(key) as ConsumerCount;
        entry.layers += 1;
        if (entry.nodeIds.length < MAX_SHOWN) entry.nodeIds.push(node.id);
      }
    }
    const children = (node as ChildrenMixin).children;
    if (children !== undefined) {
      for (const child of children) visit(child);
    }
  };

  for (const page of figma.root.children) visit(page);
}

/** `boundVariables` fields are an alias, or an array of them for `fills`/`effects`/`strokes`. */
function aliasIds(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const ids: string[] = [];
    for (const item of value) ids.push(...aliasIds(item));
    return ids;
  }
  const alias = value as { type?: string; id?: string };
  return alias.type === "VARIABLE_ALIAS" && typeof alias.id === "string" ? [alias.id] : [];
}

/** What `[ Show them ]` managed to put on screen, so the caller can say so honestly. */
export interface SelectionResult {
  /** Nodes actually selected — those on the page we navigated to. */
  selected: number;
  /** Nodes still reachable in the file at all. */
  found: number;
  /** How many distinct pages those nodes are spread across. */
  pages: number;
}

/**
 * The confirmation's `[ Show them ]` — the honest inverse of a selection-driven flow (UX §5.5).
 *
 * **Figma's selection is per-page and there is no multi-page selection API**, so a set of consumers
 * spread across pages cannot all be shown at once. The choice is which page to land on and what to
 * say about the rest; silently selecting one page's worth under a heading that counted every page
 * is the one option that isn't available, because it contradicts the number the user just read.
 * So this reports what it managed and the caller says the remainder out loud.
 */
export async function selectNodes(nodeIds: string[]): Promise<SelectionResult> {
  const nodes: SceneNode[] = [];
  for (const id of nodeIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (node !== null && node.type !== "PAGE" && node.type !== "DOCUMENT") {
      nodes.push(node as SceneNode);
    }
  }
  if (nodes.length === 0) return { selected: 0, found: 0, pages: 0 };

  // Land on the page holding the most of them, rather than on whichever happened to be walked
  // first: it is the page where the largest part of the count is visible in one go.
  const byPage = new Map<PageNode, SceneNode[]>();
  for (const node of nodes) {
    const page = pageOf(node);
    if (page === null) continue;
    const list = byPage.get(page);
    if (list === undefined) byPage.set(page, [node]);
    else list.push(node);
  }
  if (byPage.size === 0) return { selected: 0, found: nodes.length, pages: 0 };

  let best: PageNode | null = null;
  let bestNodes: SceneNode[] = [];
  for (const [page, list] of byPage) {
    if (list.length > bestNodes.length) {
      best = page;
      bestNodes = list;
    }
  }

  // Selection is page-scoped, so the page has to move with it or the user gets an empty canvas and
  // a selection count they cannot see.
  if (best !== null && best !== figma.currentPage) await figma.setCurrentPageAsync(best);
  figma.currentPage.selection = bestNodes;
  figma.viewport.scrollAndZoomIntoView(bestNodes);
  return { selected: bestNodes.length, found: nodes.length, pages: byPage.size };
}

function pageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current !== null && current.type !== "PAGE") current = current.parent;
  return current as PageNode | null;
}
