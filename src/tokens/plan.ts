// The apply plan — ADR-0005 §1, §10, §11.
//
// Pure. Turns a built tree plus the local edit overlay into an ordered list of `{ target, op,
// before, after, write }` with a named skip reason on everything it refuses, and owns the two
// pieces of graph work the write itself must not discover halfway through: the path→variableId
// index behind alias resolution, and the cycle check (§11).
//
// Three decisions from the ADR shape this module and are easy to erode by accident:
//
//   1. **The unit of apply is an overlay entry, not a token** (§1). A whole-tree apply would write
//      Figma's own values back over themselves for every token but the edited handful. The overlay
//      is already exactly the set where the plugin and Figma disagree, and already the set the user
//      authored deliberately.
//   2. **The executor is written against a plan, not against `EditOverlay`** (§1). Phase 6 produces
//      a plan by diffing a pulled git tree against the current scan — a different *producer* over
//      the same executor. That seam costs one interface now and saves rewriting the writer later.
//   3. **A target in conflict is refused, not overwritten** (§10). ADR-0004 §4 chose "local edit
//      wins" for the *tree*, which is non-destructive because the tree is a local view. The same
//      rule at the *write* boundary is destructive, because Figma is the artifact other people see.
//
// Deletion is deliberately **not** producible here (§5): `buildApplyPlan` surfaces pending
// tombstones as un-appliable rows and nothing more. `buildDeletePlan` is its own entry point with
// its own guards, reached only from its own confirmation.

import type { EditOverlay, OverlayEntry, OverlayOp, OverlayTarget } from "./overlay";
import type { FigmaWriteOp, Refusal } from "./toFigma";
import type { FlatToken } from "./view";
import type { InboundIndex, Referrer } from "./references";
import type { Token, TokenValue } from "./types";
import { targetKey, tokenKey, valuesEqual } from "./overlay";
import { toFigmaDescription, toFigmaRemoval, toFigmaValue } from "./toFigma";
import { collectReferences, inboundReferrers, isReference, referenceTarget } from "./references";
import { normalizePathKey } from "./paths";

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * `ready` is written; `already-matches` and `skipped` never are.
 *
 * `already-matches` is a first-class outcome rather than an omission because UX §5.3 needs the
 * button's count to be honest about a scope that is mostly fine — dropping those rows would make
 * "apply this set" look like it had nothing to say about 288 of its 289 tokens.
 */
export type ApplyStatus = "ready" | "already-matches" | "skipped";

export interface ApplyEntry {
  /** ADR-0004's target key — the identity everything downstream reconciles on. */
  key: string;
  target: OverlayTarget;
  path: string;
  set: string;
  op: OverlayOp;
  /** What Figma has now: the imported value, before the overlay. Fills the dialog's `before`. */
  before: TokenValue | undefined;
  /** What would be written. */
  after: TokenValue | undefined;
  status: ApplyStatus;
  write?: FigmaWriteOp;
  /** Machine-readable slug, present on every `skipped` entry. */
  reason?: string;
  message?: string;
  /**
   * Set when `after` is a reference, so the dialog can render the pointer as the primary value
   * with the resolved literal muted beneath it (UX §5.6) rather than mistaking one for the other.
   */
  alias?: { path: string; resolved?: TokenValue };
}

export interface ApplyPlan {
  entries: ApplyEntry[];
  ready: number;
  matches: number;
  skipped: number;
}

export interface PlanScope {
  /** Restrict to these target keys. Absent means every overlay entry. */
  keys?: Set<string>;
  /** Restrict to these set ids — the "apply this set" entry point (UX §5.3). */
  sets?: Set<string>;
  /**
   * Also list tokens in scope that already match Figma, as `already-matches` rows.
   *
   * On for a set/path/group scope, off for the header chip's "apply my local edits": the chip's
   * scope *is* the overlay, so every row in it differs by construction and a matches section
   * would always be empty.
   */
  includeMatches?: boolean;
}

export interface PlanInput {
  /** The effective tree — overlay applied. Supplies every `after`. */
  tokens: FlatToken[];
  /** The same tree before the overlay. Supplies every `before`, i.e. what Figma currently holds. */
  imported: FlatToken[];
  overlay: EditOverlay;
  /**
   * Styles whose live shape apply cannot rebuild from the token alone (ADR-0005 §3).
   *
   * A style write replaces a whole array — `style.paints`, `style.effects`, `style.layoutGrids` —
   * so a style carrying anything import did not represent (an invisible paint, a blur beside its
   * shadows, an unknown grid pattern) would lose it on write. That is precisely the lossy write
   * §3 forbids, so those styles refuse instead. Keyed by `styleId`.
   */
  styleGuards?: Map<string, Refusal>;
  /**
   * Normalised dotted paths that name a variable in a published team library.
   *
   * ADR-0005 §11: a library variable is read-only here and cannot be aliased by local id, and the
   * check is up-front rather than a caught write error. `scan.ts` already knows which ids these
   * are — `aliasTargetNames` is populated for exactly the alias targets that were *not* in the
   * local set — so this is a lookup, not a re-derivation.
   */
  nonLocalPaths?: Set<string>;
  /**
   * Whether `styleGuards` and `nonLocalPaths` were actually derived from a scan.
   *
   * Both guards are **collections whose emptiness is meaningful**, and both are derived from the
   * live Figma read rather than from the token tree — so a tree restored from the import cache
   * (ADR-0004 §1) can arrive with neither. Empty then means "we never asked", not "nothing is
   * guarded", and `styleGuards.get(...)` returning `undefined` would wave through exactly the lossy
   * style write ADR-0005 §3 forbids. `false` refuses every write until a scan re-establishes them.
   *
   * Absent means known — the guards are only unknown by way of the cache, and that path says so
   * explicitly.
   */
  guardsKnown?: boolean;
}

// ---------------------------------------------------------------------------
// The alias index and the cycle check — ADR-0005 §11
// ---------------------------------------------------------------------------

interface IndexedToken {
  variableId?: string;
  type: string;
  path: string;
  /** The reference graph node this token *is* — see `cycleNodeKey`. */
  node: string;
}

/**
 * One token instance's identity in the reference graph.
 *
 * **Not the normalised path.** A path is what a reference *names*, and two tokens in different sets
 * can normalise to the same one — a `cross-set` collision, which ADR-0002 §5 detects and resolves by
 * picking a winner rather than by making the loser disappear. Keying graph nodes by path merges
 * those two tokens into one node, unions their outgoing references, and lets a cycle belonging to
 * the loser refuse the winner's perfectly ordinary write. The set is what tells them apart, and a
 * set cannot hold two tokens at one path — it is a JSON tree — so this is unique per instance.
 */
export function cycleNodeKey(setId: string, path: string): string {
  return `${setId}\u0000${normalizePathKey(path)}`;
}

/**
 * `normalizePathKey(path)` → the token it names.
 *
 * First-wins where a path is ambiguous, which is also how a reference resolves at write time: the
 * collision pass (ADR-0002 §5) has already chosen that same winner, so the index and the tree agree
 * about which token a pointer lands on.
 */
function buildAliasIndex(tokens: FlatToken[]): Map<string, IndexedToken> {
  const index = new Map<string, IndexedToken>();
  for (const entry of tokens) {
    const key = normalizePathKey(entry.path);
    if (index.has(key)) continue;
    const figma = entry.token.$extensions?.["com.tokenvault"]?.figma;
    index.set(key, {
      variableId: typeof figma?.variableId === "string" ? figma.variableId : undefined,
      type: entry.token.$type,
      path: entry.path,
      node: cycleNodeKey(entry.setId, entry.path),
    });
  }
  return index;
}

/** What the cycle pass found — nodes for reporting, edges for refusing a specific write. */
export interface CycleIndex {
  /** Node keys (see `cycleNodeKey`) that sit on a cycle. */
  nodes: Set<string>;
  /**
   * The `source → target` edges that *close* a cycle, keyed `sourceNode` + NUL + `targetNode`.
   *
   * The edge, not the node, is what a refusal is keyed on. A token can hold several references —
   * a shadow's colour and its offset both — and only the ones that actually complete a loop are
   * the circular ones; refusing by node would blame every pointer the token carries.
   */
  edges: Set<string>;
}

/** Exported so a caller can ask about one edge without re-deriving the key's shape. */
export function cycleEdgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * Every reference edge that sits on a cycle.
 *
 * Figma rejects a circular alias, but discovering that as a thrown error partway through a plan is
 * the worst possible place to find out: it lands after some entries have already been written, and
 * it reaches the user as whatever string Figma chose rather than as a named skip reason. So the
 * plan builder finds cycles up front and refuses them — which is also the "circular reference
 * detection with a clear error state" PRD §6.3 asks for, arriving early and as a side effect
 * (ADR-0005 §11, Consequences).
 *
 * The graph's nodes are **token instances** and its edges run through the alias index, so a
 * reference resolves to exactly the token a write would alias — see `cycleNodeKey` for why keying
 * this by path instead lets one set's cycle refuse another set's unrelated token.
 *
 * Iterative rather than recursive: a deep alias chain in a real file is perfectly legal, and a
 * recursive walk would trade a reported cycle for a stack overflow.
 */
export function findReferenceCycles(tokens: FlatToken[]): CycleIndex {
  const index = buildAliasIndex(tokens);
  const edges = new Map<string, string[]>();

  for (const entry of tokens) {
    const from = cycleNodeKey(entry.setId, entry.path);
    const targets: string[] = [];
    for (const reference of collectReferences(entry.token)) {
      // A reference to a path that isn't a token in this tree is a dangling reference, not a
      // cycle. It resolves as its own refusal (`alias-target-unknown`) and has no node here.
      const target = index.get(normalizePathKey(reference));
      if (target !== undefined) targets.push(target.node);
    }
    const existing = edges.get(from);
    if (existing === undefined) edges.set(from, targets);
    else existing.push(...targets);
  }

  const nodes = new Set<string>();
  const cycleEdges = new Set<string>();
  /** 0 unvisited, 1 on the current path, 2 finished. */
  const state = new Map<string, number>();

  for (const start of edges.keys()) {
    if ((state.get(start) ?? 0) !== 0) continue;

    const path: string[] = [];
    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    state.set(start, 1);
    path.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = edges.get(frame.node) ?? [];

      if (frame.next >= targets.length) {
        state.set(frame.node, 2);
        stack.pop();
        path.pop();
        continue;
      }

      const target = targets[frame.next];
      frame.next += 1;
      const seen = state.get(target) ?? 0;

      if (seen === 1) {
        // Back edge: everything from `target` to the top of the current path is on the cycle, and
        // so is every edge along it — including the back edge itself, which closes the loop.
        const from = path.lastIndexOf(target);
        for (let i = from; i < path.length; i += 1) {
          nodes.add(path[i]);
          if (i + 1 < path.length) cycleEdges.add(cycleEdgeKey(path[i], path[i + 1]));
        }
        cycleEdges.add(cycleEdgeKey(frame.node, target));
        continue;
      }
      if (seen === 2) continue;
      state.set(target, 1);
      path.push(target);
      stack.push({ node: target, next: 0 });
    }
  }

  return { nodes, edges: cycleEdges };
}

// ---------------------------------------------------------------------------
// Building the plan
// ---------------------------------------------------------------------------

export function buildApplyPlan(input: PlanInput, scope: PlanScope = {}): ApplyPlan {
  const effective = new Map<string, FlatToken>();
  for (const entry of input.tokens) {
    const key = tokenKey(entry.token);
    if (key !== null && !effective.has(key)) effective.set(key, entry);
  }

  const imported = new Map<string, Token>();
  for (const entry of input.imported) {
    const key = tokenKey(entry.token);
    if (key !== null && !imported.has(key)) imported.set(key, entry.token);
  }

  const aliasIndex = buildAliasIndex(input.tokens);
  const cycles = findReferenceCycles(input.tokens);
  const order = new Map<string, number>();
  input.tokens.forEach((entry, at) => {
    const key = tokenKey(entry.token);
    if (key !== null && !order.has(key)) order.set(key, at);
  });

  const entries: ApplyEntry[] = [];
  const covered = new Set<string>();

  // Over the raw entries, deliberately, rather than over `indexOverlay`'s per-target grouping: a
  // target carrying both a value and a description edit has to produce both rows.
  for (const overlayEntry of input.overlay.entries) {
    const key = targetKey(overlayEntry.target);
    if (key === null) continue;
    if (!inScope(key, overlayEntry.set, scope)) continue;
    covered.add(key);
    entries.push(planEntry(overlayEntry, key, { effective, imported, aliasIndex, cycles, input }));
  }

  if (scope.includeMatches === true) {
    for (const entry of input.tokens) {
      const key = tokenKey(entry.token);
      if (key === null || covered.has(key)) continue;
      if (!inScope(key, entry.setId, scope)) continue;
      // No overlay entry means the token was re-derived from Figma on this very scan, so it and
      // Figma agree by construction. Listed, never written.
      entries.push({
        key,
        target: { ...targetOf(entry.token) },
        path: entry.path,
        set: entry.setId,
        op: "set-value",
        before: entry.token.$value,
        after: entry.token.$value,
        status: "already-matches",
      });
    }
  }

  entries.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));

  return {
    entries,
    ready: entries.filter((entry) => entry.status === "ready").length,
    matches: entries.filter((entry) => entry.status === "already-matches").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
  };
}

function targetOf(token: Token): OverlayTarget {
  const figma = token.$extensions?.["com.tokenvault"]?.figma ?? {};
  if (typeof figma.styleId === "string") return { styleId: figma.styleId };
  return { variableId: figma.variableId, modeId: figma.modeId };
}

function inScope(key: string, set: string, scope: PlanScope): boolean {
  if (scope.keys !== undefined && !scope.keys.has(key)) return false;
  if (scope.sets !== undefined && !scope.sets.has(set)) return false;
  return true;
}

interface PlanContext {
  effective: Map<string, FlatToken>;
  imported: Map<string, Token>;
  aliasIndex: Map<string, IndexedToken>;
  cycles: CycleIndex;
  input: PlanInput;
}

function planEntry(entry: OverlayEntry, key: string, context: PlanContext): ApplyEntry {
  const live = context.effective.get(key);
  const base: ApplyEntry = {
    key,
    target: entry.target,
    path: live?.path ?? entry.path,
    set: live?.setId ?? entry.set,
    op: entry.op,
    before: undefined,
    after: entry.value,
    status: "skipped",
  };

  // The order of these guards is the order of certainty, not the order of severity: an orphan has
  // no target at all, so nothing further can be said about it.
  if (entry.orphaned === true) {
    return {
      ...base,
      reason: "apply-orphaned",
      message: `The ${entry.target.styleId !== undefined ? "Style" : "Variable"} this edit changed was deleted in Figma.`,
    };
  }

  if (entry.op === "delete") {
    // ADR-0005 §5, and the one rule in this module with no exception: a normal apply can never
    // remove anything from the file, whatever is sitting in the overlay. The tombstone is surfaced
    // — hiding a pending deletion would be worse — but reaching it takes `buildDeletePlan` and its
    // own confirmation. UX §5.2's pre-checked rows are exactly why a delete row here is unsafe.
    return {
      ...base,
      reason: "apply-delete-separate",
      message: "Deleting this from Figma is a separate action — use “Delete in Figma…”.",
    };
  }

  if (entry.conflict !== undefined) {
    // §10. Writing anyway would silently destroy a change a designer made in Figma, using a value
    // the user authored before that change existed and has not looked at since.
    return {
      ...base,
      reason: "apply-conflicted",
      message: "You and Figma both changed this. Resolve the conflict before applying it.",
    };
  }

  if (context.input.guardsKnown === false) {
    // Before `already-matches`, and before anything that could produce a `write`: an empty guard
    // map that was never populated passes every `.get`/`.has` check downstream, so the only place
    // this can be caught is above them all.
    return {
      ...base,
      reason: "apply-guards-unknown",
      message: "Rescan the file first — this tree came from the cache, so Tokenvault can't tell what a write would overwrite.",
    };
  }

  if (live === undefined) {
    return {
      ...base,
      reason: "apply-missing-token",
      message: "This token isn't in the current tree. Rescan the file and try again.",
    };
  }

  const importedToken = context.imported.get(key);
  base.before =
    entry.op === "set-description" ? importedToken?.$description : importedToken?.$value;
  base.after = entry.op === "set-description" ? live.token.$description : live.token.$value;

  if (valuesEqual(base.before, base.after)) {
    return { ...base, status: "already-matches" };
  }

  if (entry.op === "set-description") {
    const write = toFigmaDescription(live.token, typeof base.after === "string" ? base.after : "");
    if (!write.ok) return { ...base, reason: write.reason, message: write.message };
    return { ...base, status: "ready", write: write.write };
  }

  const styleId = live.token.$extensions?.["com.tokenvault"]?.figma?.styleId;
  const guard = styleId === undefined ? undefined : context.input.styleGuards?.get(styleId);
  if (guard !== undefined) return { ...base, reason: guard.reason, message: guard.message };

  const alias = referenceTarget(base.after);
  if (alias !== null) {
    base.alias = { path: alias, resolved: resolvedValue(alias, context) };
  }

  const write = toFigmaValue(live.token, {
    resolveAlias: (path) => resolveAlias(path, live.token, context),
  });
  if (!write.ok) return { ...base, reason: write.reason, message: write.message };
  return { ...base, status: "ready", write: write.write };
}

/** The literal a pointer currently lands on, for the dialog's muted second line (UX §5.6). */
function resolvedValue(path: string, context: PlanContext): TokenValue | undefined {
  // One hop only, and deliberately: this is a display aid, not an evaluator. Resolving a chain
  // here would be the first half of the flattening ADR-0005 §11 exists to prevent, and Phase 7
  // owns evaluation.
  const indexed = context.aliasIndex.get(normalizePathKey(path));
  if (indexed === undefined) return undefined;
  for (const entry of context.input.tokens) {
    if (normalizePathKey(entry.path) !== normalizePathKey(indexed.path)) continue;
    if (isReference(entry.token.$value)) return undefined;
    return entry.token.$value;
  }
  return undefined;
}

/**
 * ADR-0005 §11's four guards, all up-front and all failing loud per entry.
 *
 * Non-local is checked *before* unknown, because a library variable is both — its path names no
 * local token, so the unknown branch would swallow it and report the wrong cause. "This lives in a
 * published library" is actionable; "this isn't in any set" sends the user looking for a token
 * that was never going to be there.
 *
 * The cycle check comes after both, because it is the one guard that needs the target *resolved*:
 * it asks whether this specific source→target edge closes a loop, not whether the source's path
 * appears anywhere in the cycle set.
 */
function resolveAlias(
  path: string,
  source: Token,
  context: PlanContext
): { ok: true; targetId: string } | Refusal {
  const key = normalizePathKey(path);

  if (context.input.nonLocalPaths?.has(key) === true) {
    return {
      ok: false,
      reason: "alias-target-non-local",
      message: `${path} comes from a published library and can't be aliased from this file. Change it in its source file.`,
    };
  }

  const target = context.aliasIndex.get(key);
  if (target === undefined) {
    return {
      ok: false,
      reason: "alias-target-unknown",
      message: `Points at ${path}, which isn't in any set.`,
    };
  }

  const from = sourceNode(source, context);
  if (from !== null && context.cycles.edges.has(cycleEdgeKey(from, target.node))) {
    return {
      ok: false,
      reason: "alias-cycle",
      message: `${path} is part of a circular reference. Figma can't hold a variable that points back at itself.`,
    };
  }

  if (target.variableId === undefined) {
    return {
      ok: false,
      reason: "alias-target-not-variable",
      message: `Points at ${path}, which isn't a Figma Variable — there's nothing to alias to.`,
    };
  }
  if (target.type !== source.$type) {
    // Figma requires an alias target's `resolvedType` to match, and the token `$type` is a faithful
    // projection of it for every type Variables can hold.
    return {
      ok: false,
      reason: "alias-type-mismatch",
      message: `Points at ${path}, which is a ${target.type} — a ${source.$type} Variable can't alias it.`,
    };
  }

  return { ok: true, targetId: target.variableId };
}

/** The graph node the token being written *is*, or `null` when it isn't in the effective tree. */
function sourceNode(token: Token, context: PlanContext): string | null {
  const key = tokenKey(token);
  if (key === null) return null;
  const entry = context.effective.get(key);
  return entry === undefined ? null : cycleNodeKey(entry.setId, entry.path);
}

// ---------------------------------------------------------------------------
// Deletion — ADR-0005 §5
// ---------------------------------------------------------------------------

export interface DeleteEntry {
  key: string;
  target: OverlayTarget;
  path: string;
  set: string;
  value: TokenValue | undefined;
  status: "ready" | "blocked";
  write?: FigmaWriteOp;
  reason?: string;
  message?: string;
  /** Tokens outside the deletion that point at this one. Non-empty means blocked. */
  referrers: Referrer[];
}

export interface DeletePlan {
  entries: DeleteEntry[];
  ready: number;
  blocked: number;
  /** Every referrer across the plan, deduplicated — the confirmation's blocked-form list. */
  referrers: Referrer[];
}

/**
 * The plan for removing Variables or Styles from the file.
 *
 * Its own producer, never a group inside `buildApplyPlan` (§5). Two of ADR-0005's three guards
 * live here — inbound references block, and the write is only ever reachable through this
 * function; the third (that the UI treats it as destructive) is UX's.
 *
 * References *from within the same deletion* don't block, the same exclusion Phase 4's group
 * delete already uses: those referrers are going away in the same operation, so nothing is
 * stranded.
 */
export function buildDeletePlan(
  lines: Array<{ path: string; setId: string; token: Token }>,
  inbound: InboundIndex
): DeletePlan {
  const going = new Set(lines.map((line) => normalizePathKey(line.path)));
  const entries: DeleteEntry[] = [];
  const allReferrers = new Map<string, Referrer>();

  for (const line of lines) {
    const key = tokenKey(line.token);
    const base: DeleteEntry = {
      key: key ?? "",
      target: targetOf(line.token),
      path: line.path,
      set: line.setId,
      value: line.token.$value,
      status: "blocked",
      referrers: [],
    };

    if (key === null) {
      entries.push({
        ...base,
        reason: "no-provenance",
        message: "Tokenvault couldn't tie this token back to a Figma Variable or Style.",
      });
      continue;
    }

    const referrers = inboundReferrers(inbound, line.path, (referrer) =>
      going.has(normalizePathKey(referrer.path))
    );
    if (referrers.length > 0) {
      for (const referrer of referrers) {
        allReferrers.set(`${normalizePathKey(referrer.path)}\0${referrer.setId}`, referrer);
      }
      entries.push({
        ...base,
        referrers,
        reason: "delete-referenced",
        message: `${referrers.length} token${referrers.length === 1 ? "" : "s"} point at this one. Removing it would cascade into every one of them.`,
      });
      continue;
    }

    const write = toFigmaRemoval(line.token);
    if (!write.ok) {
      entries.push({ ...base, reason: write.reason, message: write.message });
      continue;
    }
    entries.push({ ...base, status: "ready", write: write.write });
  }

  return {
    entries,
    ready: entries.filter((entry) => entry.status === "ready").length,
    blocked: entries.filter((entry) => entry.status === "blocked").length,
    referrers: Array.from(allReferrers.values()),
  };
}
