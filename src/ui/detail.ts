// The token detail / editor overlay — UX local-editor §5.
//
// "Overlay", not "modal": it slides over the full panel, keeps the tree's scroll position, and has
// a back arrow. At 460×640 a centred modal with a dimmed backdrop spends a third of the panel on
// chrome (§5.1).
//
// One overlay covers **all of a path's sets** (§5.1). Opening a separate one per set would make
// the user back out and re-enter to compare `Light` against `Dark`, which is the thing the merged
// view was chosen to make easy.
//
// Restyled as **the token card** in Phase 10 — `edit-view-redesign.md`. The surface did not change:
// still the full-panel overlay, still not a modal and not a second pane (§3.1, and
// `panel-size-and-swatches.md` §3.4 makes it a constraint rather than a preference). What changed is
// everything inside `.panel-body`:
//
//   - **Labels sit above their fields**, not in an 84px gutter beside them — ~90px of value width
//     recovered at the 400px floor for ~14px of height per field (§4.1).
//   - **One card for a single-set path**, one bordered section per set for a multi-set one (§3.2).
//   - **`.value-shell`**: one new class, one bordered row holding the swatch, the input and any
//     trailing control. No new colour, no new badge, and the swatch is `swatchMark()` (§4.3, §12).
//   - **The Figma section is one disclosure** with the Source line promoted into its summary, so
//     collapsing never hides provenance (§6).
//   - **A pinned footer** holding `Done` and the path-level `Apply all N sets`. No Save and no
//     Cancel: there is no draft buffer for one to act on (§7.2).

import type {
  DimensionValue,
  GridValue,
  Referable,
  ShadowValue,
  SubtypeSelection,
  Token,
  TokenValue,
  TypographyValue,
} from "../tokens/types";
import type { OverlayTarget } from "../tokens/overlay";
import type { Line, Row } from "./state";
import {
  clearLineHeight,
  denormalizeShadows,
  dimensionUnit,
  formatDimension,
  gridFieldsFor,
  gridList,
  newGrid,
  newShadow,
  parseHexColor,
  parseNumberValue,
  parseStringValue,
  setGridField,
  setGridPattern,
  setShadowField,
  setTypographyField,
  shadowList,
  subtypeWarning,
} from "../tokens/edit";
import { isReference } from "../tokens/references";
import { valueShape } from "../tokens/expr";
import {
  authorValue,
  buildPicker,
  candidatePaths,
  cycleBlock,
  isNonLiteral,
  noOpSwap,
  pointerTarget,
  resolveLine,
  resolvedLiteralFor,
} from "./valueField";
import { NUMBER_SUBTYPES, STRING_SUBTYPES } from "../tokens/subtype";
import type { GridField, ShadowField, TypographyField } from "../tokens/edit";
import type { MemberAccepts, MemberType } from "../tokens/members";
import {
  gridMemberSpec,
  memberBindingKeys,
  memberKey,
  memberLayerCount,
  memberShape,
  nonLiteralMembers,
  shadowMemberSpec,
  typographyMemberSpec,
} from "../tokens/members";
import type { Resolution } from "../tokens/resolve";
import {
  deleteBlockers,
  deleteLines,
  dismissDrift,
  driftBaseline,
  editBlockedReason,
  editDescription,
  editValue,
  getModel,
  keysOf,
  planFor,
  onCycle,
  planRestoreDrift,
  resolutionFor,
  resolveKeepMine,
  resolveTakeRepo,
  revert,
  send,
} from "./state";
import {
  autoExpandFigma,
  collapsedLayers,
  figmaSummary,
  hasFigmaSection,
  memberLabel,
  pairMembers,
  scopesLine,
  valueLabel,
} from "./card";
import { isColorValue, swatchMark, swatchNode } from "./swatch";
import { isConnected } from "./git";
import { openApplyDialog } from "./applyDialog";
import { openDeleteInFigma } from "./deleteFigma";
import { button, closePopover, copy, el, isPopoverOpen, popover, toast } from "./dom";
import { describeValue } from "../tokens/format";
import { previewOf } from "../tokens/preview";
import { normalizePathKey } from "../tokens/paths";

const panelEl = document.getElementById("panel") as HTMLElement;

let openKey: string | null = null;
let focusSet: string | undefined;
let navigate: (path: string) => void = () => undefined;

/**
 * Which Figma disclosures the user has opened or shut by hand, keyed by `path\u0000setId`.
 *
 * In memory, cleared on `closeDetail`, and deliberately **not** `clientStorage` (§6.2, §12): the
 * store is quota-constrained (ADR-0004 §1) and which accordion you last poked is a per-glance
 * preference, not user data. `undefined` means "nobody has touched this one", which is what lets
 * §6.2's auto-expand decide instead.
 */
const figmaOpen = new Map<string, boolean>();

/** Same shape, same lifetime, for a shadow layer the user expanded past §5.6's collapse rule. */
const layerOpen = new Map<string, boolean>();

function stateKey(line: Line, suffix = ""): string {
  return `${line.entry.path}\u0000${line.entry.setId}${suffix}`;
}

export function setNavigator(fn: (path: string) => void): void {
  navigate = fn;
}

export function openDetail(pathKey: string, setId?: string): void {
  openKey = pathKey;
  focusSet = setId;
  pendingRender = false;
  renderNow();
}

export function closeDetail(): void {
  openKey = null;
  focusSet = undefined;
  pendingRender = false;
  blockedPanel = false;
  figmaOpen.clear();
  layerOpen.clear();
  panelEl.classList.add("hidden");
  panelEl.textContent = "";
}

export function isDetailOpen(): boolean {
  return openKey !== null;
}

// ---------------------------------------------------------------------------
// Rendering — deferred while a field is being edited
// ---------------------------------------------------------------------------
//
// A field commits on blur, and a commit rebuilds the model, which calls back here. Rendering
// straight through would rebuild the panel from scratch *during* that blur — and by then focus has
// usually already moved to the sibling the user tabbed into. Destroying that input fires a native
// blur on it and re-enters the commit path with a half-typed value, so a tab between two fields
// can discard or spuriously commit what was in the second one.
//
// So the render is owed rather than performed: it runs on the next tick, and only once focus has
// left the panel's fields. What the user is typing in is never torn out from under them.

/** A render is owed — the model changed and the panel hasn't caught up yet. */
let pendingRender = false;
/** The blocked-reference panel currently owns the panel element; don't paint over it. */
let blockedPanel = false;

function panelInputFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !panelEl.contains(active)) return false;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    active instanceof HTMLTextAreaElement
  );
}

export function renderDetail(): void {
  if (openKey === null) return;
  pendingRender = true;
  setTimeout(flushRender, 0);
}

function flushRender(): void {
  if (!pendingRender) return;
  if (openKey === null) {
    pendingRender = false;
    return;
  }
  // Both of these leave the render owed rather than dropping it: dismissing the blocked panel and
  // leaving the field each re-flush.
  if (blockedPanel || panelInputFocused()) return;
  pendingRender = false;
  renderNow();
}

// `focusout` fires as focus leaves a field, before it settles on the next one, so the flush is
// deferred a tick — landing on a sibling input simply leaves the render owed again.
panelEl.addEventListener("focusout", () => setTimeout(flushRender, 0));

function renderNow(): void {
  if (openKey === null) return;
  pendingRender = false;
  blockedPanel = false;
  const row = getModel().byPath.get(openKey);
  if (row === undefined) {
    // The path was deleted from every set it lived in, so there is nothing left to show.
    closeDetail();
    return;
  }

  panelEl.textContent = "";
  panelEl.classList.remove("hidden");

  // The title bar **is** the name field (§10.1). The full dotted path in mono with `Copy path`
  // beside it is the reference's own item 1, and rendering an editable input that refuses everything
  // typed into it would be worse than rendering none: ADR-0004 defines no rename op.
  const head = el("div", "panel-head");
  const back = button("←");
  back.title = "Back to the tree";
  back.addEventListener("click", closeDetail);
  head.appendChild(back);

  const headMain = el("div", "head-main");
  headMain.appendChild(el("div", "title", row.row.path));
  // §3.2 — a single-set path drops the `.set-section` box and its `h3`, so the badges that lived in
  // the `h3` have to reappear here or they are lost (§12). The `$type` badge is not among them: on a
  // single-set card the value field's own label carries the type (§4.2).
  const single = row.lines.length === 1;
  if (single) {
    const line = row.lines[0];
    const meta = el("div", "head-meta");
    const code = el("span", "mono", line.set.code);
    code.title = line.set.label;
    meta.appendChild(code);
    if (line.edited) meta.appendChild(el("span", "badge", "edited"));
    for (const flag of line.flags) meta.appendChild(el("span", "badge needs", flag.kind));
    headMain.appendChild(meta);
  }
  head.appendChild(headMain);

  const copyPath = button("Copy path");
  copyPath.addEventListener("click", () => copy(row.row.path, "the token path"));
  head.appendChild(copyPath);
  panelEl.appendChild(head);

  const body = el("div", "panel-body");
  for (const line of row.lines) body.appendChild(renderCard(row, line, single));

  // Destructive path-level actions stay at the bottom of the scroll. They do **not** belong in a
  // permanently visible footer next to `Done` (§7.2).
  body.appendChild(renderPathActions(row));
  panelEl.appendChild(body);
  panelEl.appendChild(renderFooter(row));

  if (focusSet !== undefined) {
    const target = body.querySelector(`[data-set-section="${cssEscape(focusSet)}"]`);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "start" });
    focusSet = undefined;
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------

/**
 * The pinned footer — `edit-view-redesign.md` §7.2.
 *
 * **There is no Save and nothing for one to do.** Every field commits to the `clientStorage` overlay
 * on blur (ADR-0004 §2), so a Save button would mean inventing a draft buffer — and a card that can
 * be abandoned unsaved makes `local-editor.md` §5.4's "local edits" promise conditional. No Cancel
 * either: `←` has been the exit since Phase 4.
 *
 * What is pinned instead is the thing that actually writes, which is `git-sync.md` §7.2's pattern in
 * the same `.panel-foot` class: the body scrolls against the panel and the write verb never scrolls
 * out of reach.
 */
function renderFooter(row: Row): HTMLElement {
  const foot = el("div", "panel-foot");

  // Replaces Phase 4's standing paragraph at the top of the body, which still promised git sync was
  // coming in Phase 6 — it landed 2026-09-03. Rendered only when something on this path is edited;
  // silent otherwise, and commit state lives on the Repo tab's own chip now.
  if (row.lines.some((line) => line.edited)) {
    foot.appendChild(el("div", "note", "Edits are local until you Apply."));
  }

  const actions = el("div", "foot-row");
  if (row.lines.length > 1 && row.lines.some((line) => line.edited)) {
    const apply = button(`Apply all ${row.lines.length} sets`, "primary");
    apply.addEventListener("click", () => applyLines(row.lines, `Apply ${row.row.path}`));
    actions.appendChild(apply);
  }
  // The reference's Save position, doing the reference's Save gesture — *I'm finished here* — without
  // claiming to write anything. Identical in effect to `←`.
  const done = button("Done", "primary");
  done.addEventListener("click", closeDetail);
  actions.appendChild(done);
  foot.appendChild(actions);
  return foot;
}

/**
 * One token card — `edit-view-redesign.md` §3.2, §5.
 *
 * `bare` is the single-set path: **no `.set-section` box and no `h3`**, because a border, 8px of
 * padding each side and a heading restating a set the title already implies is pure redundancy on
 * two-thirds of paths (§3.2). Multi-set keeps one bordered section per set — with three on screen the
 * set is the thing you are locating — and the `h3` is also where two sets disagreeing on `$type`
 * shows up (`local-editor.md` §4.2).
 *
 * Section order is §5's matrix, and a row absent from a type's column simply is not rendered: nothing
 * here draws a placeholder for a section it does not have.
 */
function renderCard(row: Row, line: Line, bare: boolean): HTMLElement {
  const section = el("div", bare ? "card" : "set-section");
  section.setAttribute("data-set-section", line.entry.setId);

  if (!bare) {
    const heading = el("h3");
    heading.appendChild(el("span", "mono", line.set.code));
    heading.appendChild(el("span", "badge", line.entry.token.$type));
    if (line.edited) heading.appendChild(el("span", "badge", "edited"));
    for (const flag of line.flags) heading.appendChild(el("span", "badge needs", flag.kind));
    section.appendChild(heading);
    section.title = line.set.label;
  }

  // §4.6's precedence, unchanged and all of it **above** the value field: the cycle block first,
  // because the loop is the thing in the error state rather than this token
  // (`references-math-themes.md` §7.3b), then conflict, then drift, then the in-sync line, then
  // `editBlockedReason`.
  const cycle = onCycle(line) ? resolutionFor(line).cycle : undefined;
  if (cycle !== undefined) {
    section.appendChild(
      cycleBlock(cycle, getModel().resolve, {
        navigate: (path: string) => {
          closeDetail();
          navigate(path);
        },
      })
    );
  }

  if (line.conflict !== undefined) section.appendChild(renderConflict(line));
  else if (line.drift !== undefined) section.appendChild(renderDrift(line));
  else if (!line.edited) section.appendChild(renderInSync());

  // An edit is keyed on Figma provenance (ADR-0004 §2). Without one there is nothing to key on, so
  // say it up front rather than letting every field accept a value and quietly discard it (§8).
  const blocked = editBlockedReason(line);
  if (blocked !== null) section.appendChild(el("div", "empty", blocked));

  section.appendChild(typedEditor(line));

  // §4.6 — flag messages used to render after the actions toolbar, at the very bottom of the
  // section, detached from the field they describe. *"Points at folio.ref.palette.red-warm.50, which
  // isn't in any set"* is a sentence about the value field directly above it.
  for (const flag of line.flags) section.appendChild(el("div", "field-note", flag.message));

  section.appendChild(renderDescription(line));

  const figma = renderFigmaSection(line);
  if (figma !== null) section.appendChild(figma);

  const actions = el("div", "toolbar");
  if (line.edited) {
    const apply = button("Apply", "primary");
    apply.title = "Write this value into Figma.";
    apply.addEventListener("click", () => applyLines([line], `Apply ${row.row.path}`));
    actions.appendChild(apply);

    const revertOne = button("Revert to imported value");
    revertOne.addEventListener("click", () => {
      if (line.target !== null) revert([line.target]);
      toast(`Reverted ${row.row.path} in ${line.set.code}`);
    });
    actions.appendChild(revertOne);
  }
  actions.appendChild(
    deleteButton([line], { action: "Delete token", subject: `${row.row.path} in ${line.set.code}` })
  );
  // Two separate actions with two separate names, and the second is styled as a different kind of
  // thing (UX §5.7): "Delete token" is Phase 4's local tombstone, "Delete in Figma…" removes the
  // Variable or Style from the file. The ellipsis promises a further step; the colour promises
  // consequences.
  actions.appendChild(deleteInFigmaButton([line]));
  section.appendChild(actions);

  return section;
}

/** UX §5.5's conflict block: both sides, local shown as live, one tap each way. */
function renderConflict(line: Line): HTMLElement {
  const conflict = line.conflict as NonNullable<Line["conflict"]>;
  // A pulled conflict names the repo rather than the user — ADR-0006 §5's `origin` field doing UX
  // work (UX git-sync §8.2). The two are structurally identical and resolve identically; they
  // differ only in what the block can honestly call the opposing value.
  const fromRepo = conflict.conflict?.origin === "repo";
  const box = el("div", "conflict-box");
  box.appendChild(
    el(
      "div",
      undefined,
      fromRepo ? "⚑ Conflict — you and the repo both changed this" : "⚑ Conflict — both you and Figma changed this"
    )
  );
  box.appendChild(el("div", "mono", `${fromRepo ? "Yours        " : "Your edit    "}${describe(conflict.value)}`));
  box.appendChild(
    el("div", "mono", `${fromRepo ? "From the repo" : "Now in Figma "} ${describe(conflict.conflict?.figma)}`)
  );
  box.appendChild(
    el("div", undefined, fromRepo ? "You edited this token; the repo changed it too. Pick one." : "Your edit is being used.")
  );

  const actions = el("div", "actions");
  const mine = button("Keep mine");
  mine.addEventListener("click", () => {
    if (line.target !== null) resolveKeepMine(line.target, conflict.op);
    toast("Kept your value.");
  });
  const theirs = button(fromRepo ? "Take the repo's" : "Take Figma's");
  theirs.addEventListener("click", () => {
    if (fromRepo) {
      // The repo's value is in neither the tree nor Figma, so taking it records it as a pending
      // change rather than dropping the entry and falling back to a third thing.
      if (resolveTakeRepo(line)) toast("Took the repo's value — apply it to update Figma.");
      return;
    }
    if (line.target !== null) revert([line.target], conflict.op);
    toast("Took Figma's value.");
  });
  actions.appendChild(mine);
  actions.appendChild(theirs);
  box.appendChild(actions);
  return box;
}

/** Untruncated: the detail view is the surface with room for the whole value. */
function describe(value: TokenValue | undefined): string {
  return describeValue(value);
}

/**
 * UX §6.4's comparison block — the `edit-conflict` component with one row fewer.
 *
 * The two labels are deliberately **not** the doc's "Your token / Now in Figma". That pairing
 * assumes the token file can disagree with Figma for an unedited token, which is only true from
 * Phase 6: today the tree is re-derived from Figma on every scan, so a drifted-but-unedited row
 * *already shows Figma's new value*. ADR-0005 §8 is explicit that this is a changelog against a
 * local watermark, and the labels say exactly that instead of implying a divergence the
 * architecture cannot yet produce. Same component, honest nouns.
 */
function renderDrift(line: Line): HTMLElement {
  const drift = line.drift as NonNullable<Line["drift"]>;
  const box = el("div", "conflict-box");
  box.appendChild(el("div", undefined, "⚑ Changed in Figma"));

  // Phase 6's rebaseline — UX git-sync §10.2, amending `apply-and-drift.md` §6.4 exactly as that
  // section predicted. Connected, the repo holds a value genuinely independent of Figma, so the two
  // rows are once again two different things and the labels say which is which. Disconnected, the
  // tree is still re-derived from Figma on every scan and Phase 5's honest nouns stand.
  //
  // Keyed to the connection, not to a feature flag: both are live code paths, and a file can be
  // disconnected at any time (UX §14).
  const connected = driftBaseline() === "repo" && isConnected();

  if (drift.kind === "drift-added") {
    box.appendChild(el("div", undefined, "This is new in Figma since your last scan."));
  } else if (drift.kind === "drift-removed") {
    box.appendChild(el("div", undefined, "This was in Figma at your last scan and isn't any more."));
  } else if (connected) {
    // `In the repo`, not `Your token`: the tree renders `build(scan) + overlay`, so "your token" is
    // showing Figma's value on this row. `In the repo` names the thing the row actually holds.
    box.appendChild(el("div", "mono", `In the repo   ${describe(drift.baseline)}`));
    box.appendChild(el("div", "mono", `Now in Figma  ${describe(drift.current)}`));
    box.appendChild(el("div", undefined, "The repo and Figma disagree about this token."));
  } else {
    box.appendChild(el("div", "mono", `At your last scan  ${describe(drift.baseline)}`));
    box.appendChild(el("div", "mono", `Now in Figma       ${describe(drift.current)}`));
    box.appendChild(
      el("div", undefined, "Someone edited this in Figma after your last scan. Your tree already shows the new value.")
    );
  }

  const actions = el("div", "actions");

  if (drift.kind === "drift-value") {
    // Connected this really is *take the repo's* — the baseline is the repo's value, so writing it
    // back into Figma is what the button says. Disconnected the baseline is only a watermark, so
    // the honest label is Phase 5's `Put Figma back`. Same plan, same dialog, two names for two
    // different facts. A canvas write, so it routes through the dialog like every other one.
    const restore = button(connected ? "Take the repo's" : "Put Figma back");
    restore.title = connected
      ? `Writes ${describe(drift.baseline)} — the repo's value — into Figma.`
      : `Writes ${describe(drift.baseline)} — the value at your last scan — back into Figma.`;
    restore.addEventListener("click", () => {
      openApplyDialog({
        plan: planRestoreDrift([line.key as string]),
        title: connected ? `Take the repo's ${line.entry.path}` : `Put back ${line.entry.path}`,
        nothingToDo: "Nothing to put back.",
        onNothingToDo: toast,
      });
    });
    actions.appendChild(restore);
  }

  const accept = button("Take Figma's");
  // Connected, accepting gains a consequence it did not have in Phase 5: the file the panel would
  // push already carries Figma's value, so the repo now disagrees with it and the file becomes an
  // uncommitted change. Disconnected, it still writes nothing. Two facts, two sentences (§10.2).
  accept.title = connected
    ? "Accepts the change. Nothing is written to Figma — the token becomes a change to push."
    : "Accepts the change and clears the flag. Nothing is written.";
  accept.addEventListener("click", () => {
    dismissDrift([line.key as string]);
    toast(connected ? "Accepted the change from Figma — 1 change to push." : "Accepted Figma's change.");
  });
  actions.appendChild(accept);

  box.appendChild(actions);
  return box;
}

/**
 * The per-token green — UX §8's second of exactly three places it is allowed.
 *
 * The overlay is the right home for it: the user has already asked a question about one specific
 * token, so an answer is warranted and there is room to give it. It stays off tree rows, where a
 * green dot on 1,300 mostly-clean lines would be a wall of green that means nothing and drowns the
 * fifteen amber badges that do.
 */
function renderInSync(): HTMLElement {
  const model = getModel();
  const row = el("div", "ok-line");
  if (!model.driftKnown) {
    // Never a green all-clear on an unknown (§8). Grey, and it says which it is.
    const unknown = el("div", "empty");
    unknown.textContent = "Not compared yet — there's no earlier scan to check this against.";
    return unknown;
  }
  row.appendChild(el("span", undefined, "●"));
  row.appendChild(el("span", undefined, "In sync — matches Figma as of the last scan."));
  return row;
}

// ---------------------------------------------------------------------------
// Value editors — §5.2
// ---------------------------------------------------------------------------

/**
 * The per-type editor, once the cycle block (if any) has had its say.
 *
 * The editor renders even on a loop: *"editing any one of them breaks it"*
 * (`references-math-themes.md` §7.3b) is only true if one of them can be edited, and this is one of
 * them.
 */
function typedEditor(line: Line): HTMLElement {
  const token = line.entry.token;
  switch (token.$type) {
    case "color":
      return colorEditor(line);
    case "number":
      return numberEditor(line);
    case "boolean":
      return booleanEditor(line);
    case "string":
      return stringEditor(line);
    case "typography":
      return typographyEditor(line);
    case "shadow":
      return shadowEditor(line);
    case "grid":
      return gridEditor(line);
    default:
      return el("div", "empty", String(token.$value));
  }
}

/**
 * The affordances that hang under a committed non-literal value.
 *
 * `Go to target` survives from Phase 4 unchanged — it was the right affordance and it is now
 * reachable from an *editable* field (§12). `Use the resolved value instead` is new, and it is the
 * escape hatch Phase 4 §5.3 deliberately withheld because breaking a link was an aliasing decision:
 * Phase 7 is where that decision gets made, and the answer is that breaking one on purpose is a
 * legitimate thing to want as long as it is a named action rather than the accidental result of
 * clicking a swatch (§4.1, §4.3).
 */
function pointerFooter(line: Line, setField: (raw: string) => void): HTMLElement | null {
  const token = line.entry.token;
  const shape = valueShape(token);
  if (shape === "literal") return null;

  const wrap = el("div", "toolbar");
  const target = pointerTarget(token.$value);

  if (target !== null) {
    const exists = getModel().byPath.has(normalizePathKey(target));
    if (exists) {
      const go = button("Go to target");
      go.addEventListener("click", () => {
        closeDetail();
        navigate(target);
      });
      wrap.appendChild(go);
    }
  }

  const literal = resolvedLiteralFor(line);
  if (literal !== null) {
    // Worded as *use the resolved value*, not *break the link* — the user is choosing what they
    // want, not vandalising something. Left uncommitted in the field so they can see what they are
    // about to do (§4.3).
    const use = button("Use the resolved value instead");
    use.addEventListener("click", () => setField(literal));
    wrap.appendChild(use);
  }

  return wrap.childNodes.length === 0 ? null : wrap;
}

/**
 * The one value field — §4.1.
 *
 * Accepts a literal, a whole-value reference, or (on a `number` token) a math expression, in the
 * same input, with no mode switch. `{` opens the path picker at the caret. Validation fires on
 * **commit**, not per keystroke: a half-typed path is not an error, and amber that appears on the
 * third character trains people to ignore amber (§5).
 */
/**
 * One composite member, addressed the way the field needs it — UX §14.1.
 *
 * Its presence is the *only* difference between a member field and a scalar one: the picker, the
 * parser, the four rules and the cycle block are the same objects either way, which is §14.9's first
 * build note. What the member supplies is which types it takes, whether it takes arithmetic, and how
 * to write a pointer back into the composite.
 */
interface MemberField {
  key: string;
  label: string;
  type: MemberType;
  accepts: MemberAccepts;
  /** Writes the raw pointer or formula into this member of the composite, verbatim. */
  commitPointer: (raw: string) => string | null;
  /** What this member currently resolves to, for the resolve line and the `—` slot. */
  resolution?: Resolution;
}

/** The `$type`s a field will accept a pointer to — one for a scalar, one or two for a member. */
function acceptedTypes(type: string, member: MemberField | undefined): Set<string> {
  if (member === undefined) return new Set([type]);
  if (member.type === "number-or-string") return new Set(["number", "string"]);
  return new Set([member.type]);
}

function unifiedField(
  line: Line,
  options: {
    /** `null` renders no label at all — the boolean's pointer shell, which borrows the one above it. */
    label?: string | null;
    /** Parses and commits a literal for this `$type`. Returns an error message or `null`. */
    commitLiteral?: (raw: string) => string | null;
    /** Trailing control inside the shell — `px`/`em`, the subtype select, `Auto` (§4.4). */
    trailing?: (input: HTMLInputElement, reference: boolean) => HTMLElement | null;
    /** Leading control inside the shell — the colour swatch, and nothing else (§4.3). */
    leading?: (input: HTMLInputElement, reference: boolean) => HTMLElement | null;
    /** A muted line under the shell, for a field whose label went elsewhere (§5.3). */
    hint?: string;
    initial?: string;
    placeholder?: string;
    member?: MemberField;
  } = {}
): HTMLElement {
  const token = line.entry.token;
  const member = options.member;
  // The type the *field* answers to. For a member it is the member's own (§14.9), collapsed to the
  // one thing `valueShape` cares about: whether a bare string here would be arithmetic.
  const type =
    member === undefined
      ? token.$type
      : member.accepts === "full"
        ? "number"
        : member.type === "number-or-string"
          ? "string"
          : member.type;
  const wrap = el("div");
  // §4.1 — the label sits **above** the control, not in an 84px gutter beside it. That is ~90px of
  // width recovered on every value, every resolve line and every dotted path at the 400px floor, for
  // ~14px of height, and height is the cheap axis now the panel opens 720 tall.
  const row = el("div", "field");
  if (options.label !== null) {
    row.appendChild(el("label", undefined, options.label ?? "Value"));
  }

  // §4.3's one new class, and the only one: a bordered flex row that looks like the text input it
  // contains. **No trailing chevron** — the reference's is its value-type dropdown, which is exactly
  // the mode toggle `references-math-themes.md` §4.1 refused.
  const shell = el("div", "value-shell");

  const initial = options.initial ?? String(token.$value);
  const accepted = acceptedTypes(type, member);
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.value = initial;
  input.className = "inline-edit";
  if (options.placeholder !== undefined) input.placeholder = options.placeholder;

  const note = el("div", "field-note hidden");
  const extra = el("div");

  // The amber goes on the *shell*, not the input: inside `.value-shell` the input has no border of
  // its own to colour (§12), so the refusal would be invisible if it stayed where Phase 7 put it.
  const clearNotes = (): void => {
    input.classList.remove("invalid");
    shell.classList.remove("invalid");
    note.classList.add("hidden");
    note.textContent = "";
    extra.textContent = "";
  };

  const showAmber = (message: string): void => {
    input.classList.add("invalid");
    shell.classList.add("invalid");
    note.classList.remove("hidden");
    note.classList.add("warn");
    note.textContent = message;
  };

  const showGrey = (message: string): void => {
    input.classList.remove("invalid");
    shell.classList.remove("invalid");
    note.classList.remove("hidden");
    note.classList.remove("warn");
    note.textContent = message;
  };

  const live = el("div");
  const renderLive = (): void => {
    live.textContent = "";
    const rendered = resolveLine(input.value, type, getModel().resolve);
    if (rendered !== null) live.appendChild(rendered);
  };

  const setField = (raw: string): void => {
    input.value = raw;
    clearNotes();
    renderLive();
    input.focus();
  };

  const commit = (): void => {
    const raw = input.value;
    // An empty field that started empty is not an edit. The boolean editor's "Points at" field
    // starts that way, and blurring past it must not fire an error about a value nobody typed.
    if (raw.trim().length === 0 && initial.length === 0) {
      clearNotes();
      return;
    }
    if (member === undefined ? !isNonLiteral(raw, type) : memberShape(member.accepts, raw.trim()) === "literal") {
      const literalCommit = options.commitLiteral;
      if (literalCommit === undefined) {
        showAmber(`A ${type} token needs a ${type} value.`);
        return;
      }
      const error = literalCommit(raw);
      if (error === null) clearNotes();
      else showAmber(error);
      return;
    }

    // §5's four rules, all before the overlay entry is written — §14.4 runs the same four on a
    // member, with rule 2 reading the member's type.
    const outcome = authorValue(line, raw, member === undefined ? undefined : member);
    if (!outcome.ok) {
      showAmber(outcome.message);
      extra.textContent = "";
      if (outcome.cycle !== undefined) {
        const candidate = candidatePaths(raw);
        extra.appendChild(
          cycleBlock(outcome.cycle, getModel().resolve, {
            candidateEdge:
              candidate.length > 0
                ? { fromPath: line.entry.path, toPath: candidate[0] }
                : undefined,
            navigate: (path: string) => {
              closeDetail();
              navigate(path);
            },
          })
        );
      }
      // The field stays open with the value in it, so Escape reverts and any other edit is one
      // keystroke away (§7.3a).
      return;
    }

    const error =
      member === undefined ? editValue(line, raw.trim() as never) : member.commitPointer(raw.trim());
    if (error !== null) {
      showAmber(error);
      return;
    }
    clearNotes();

    if ("warning" in outcome && outcome.warning !== undefined) {
      // Grey, not amber, at the moment of authoring — the user just did a legitimate thing and
      // nothing needs them. The *row* badge is amber, because by the time you meet it in the tree
      // you have lost the context that made it deliberate (§5.4).
      showGrey(outcome.warning);
    }

    // §6.5, and the one place the editor steers toward a reference: only where a plain reference is
    // provably equivalent, and it offers rather than rewrites.
    const swap = noOpSwap(raw);
    if (swap !== null) {
      showGrey(
        `Committed. ${raw.trim()} is the same as {${swap}}, and a plain reference keeps a live link in Figma.`
      );
      const fix = button(`Use {${swap}}`);
      fix.addEventListener("click", () => {
        const applied =
          member === undefined
            ? editValue(line, `{${swap}}` as never)
            : member.commitPointer(`{${swap}}`);
        if (applied !== null) toast(applied);
      });
      extra.textContent = "";
      extra.appendChild(fix);
    }
  };

  input.addEventListener("input", () => {
    renderLive();
    // The picker fires on `{` and inserts at the caret rather than replacing the field, which is
    // the only mechanical thing expressions add to §4.2. It is reopened on every keystroke while
    // the caret sits inside an unclosed `{`, because **the picker filters live** — it is the amber
    // that waits for commit, not the list (§5, build notes).
    if (openBraceBefore() !== -1) openPicker();
    else closePopover();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      // Escape closes the popover **without closing the field** (§4.2). Only a second Escape, with
      // no popover to dismiss, reverts what was typed.
      event.preventDefault();
      if (isPopoverOpen()) {
        closePopover();
        return;
      }
      input.value = initial;
      clearNotes();
      renderLive();
    }
  });
  input.addEventListener("blur", () => {
    // A click inside the picker must not commit the half-typed path underneath it.
    window.setTimeout(() => {
      if (document.activeElement !== input) commit();
    }, 0);
  });

  /** The unclosed `{` the caret sits inside, or -1. Drives both opening and closing the picker. */
  function openBraceBefore(): number {
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const opened = before.lastIndexOf("{");
    if (opened === -1) return -1;
    return before.indexOf("}", opened) === -1 ? opened : -1;
  }

  function openPicker(): void {
    const caret = input.selectionStart ?? input.value.length;
    const openedAt = openBraceBefore();
    if (openedAt === -1) return;
    const query = input.value.slice(openedAt + 1, caret);
    popover(input, (close) =>
      buildPicker(line.entry, query, accepted, (path: string) => {
        const before = input.value.slice(0, openedAt);
        const after = input.value.slice(caret);
        setField(`${before}{${path}}${after}`);
        close();
      })
    );
  }

  const reference = isReference(member === undefined ? token.$value : initial);
  const leading = options.leading?.(input, reference);
  if (leading !== null && leading !== undefined) shell.appendChild(leading);
  shell.appendChild(input);
  const trailing = options.trailing?.(input, reference);
  if (trailing !== null && trailing !== undefined) shell.appendChild(trailing);
  row.appendChild(shell);

  wrap.appendChild(row);
  wrap.appendChild(live);
  wrap.appendChild(note);
  wrap.appendChild(extra);
  if (options.hint !== undefined) wrap.appendChild(el("div", "field-note", options.hint));
  renderLive();

  if (member === undefined) {
    // A scalar card shows the pointer footer whenever the value is non-literal, as it has since
    // Phase 7. It has one field, so there is nothing to scope it to (§4.5).
    const footer = pointerFooter(line, setField);
    if (footer !== null) wrap.appendChild(footer);
  } else {
    // §4.5 — a composite shows it under the field that has **focus**, and nowhere else. A typography
    // token with three referenced members would otherwise carry six buttons.
    attachMemberFooter(wrap, input, initial);
    const cycle = memberCycle(member);
    if (cycle !== null) wrap.appendChild(cycle);
  }

  return wrap;
}

/**
 * `Go to target` for one member, rendered under **the focused field only** — §4.5, §12.
 *
 * One container for the whole card, moved to whichever field has focus, rather than a hidden one per
 * member: a node can only be in one place, so the move *is* the exclusivity. The same two affordances
 * a scalar pointer gets, minus *Use the resolved value instead* — a member's resolved value is a
 * dimension object, not a string a field can be pre-filled with, and a button that writes
 * `[object Object]` is worse than no button.
 *
 * Unfocused referenced members still carry their resolve line, and the target path *inside* that line
 * is a tap target that navigates — which is `Go to target` without a button.
 */
const memberFooterHost = el("div", "toolbar member-footer");

function attachMemberFooter(wrap: HTMLElement, input: HTMLInputElement, initial: string): void {
  input.addEventListener("focus", () => {
    memberFooterHost.textContent = "";
    const target = pointerTarget(initial);
    if (target === null || !getModel().byPath.has(normalizePathKey(target))) {
      memberFooterHost.remove();
      return;
    }
    const go = button("Go to target");
    // The field keeps focus through the click, so the deferred blur teardown below never races the
    // navigation it was about to perform.
    go.addEventListener("mousedown", (event) => event.preventDefault());
    go.addEventListener("click", () => {
      closeDetail();
      navigate(target);
    });
    memberFooterHost.appendChild(go);
    wrap.appendChild(memberFooterHost);
  });

  input.addEventListener("blur", () => {
    // Deferred for the same reason the commit is: focus lands on the next field a tick later, and
    // tearing the footer down synchronously would fight a click that is still in flight.
    window.setTimeout(() => {
      if (document.activeElement === input) return;
      if (memberFooterHost.contains(document.activeElement)) return;
      memberFooterHost.textContent = "";
      memberFooterHost.remove();
    }, 0);
  });
}

/**
 * §14.6 — a cycled member renders the block **under its own field**, always, while every other member
 * of the composite still edits normally. Not focus-scoped: a loop is a state, not an affordance.
 */
function memberCycle(member: MemberField): HTMLElement | null {
  if (member.resolution?.kind !== "cycle" || member.resolution.cycle === undefined) return null;
  return cycleBlock(member.resolution.cycle, getModel().resolve, {
    navigate: (path: string) => {
      closeDetail();
      navigate(path);
    },
  });
}


function fieldRow(label: string, control: HTMLElement): HTMLElement {
  const row = el("div", "field");
  row.appendChild(el("label", undefined, label));
  row.appendChild(control);
  return row;
}

/**
 * A text input that commits on Enter or blur and reverts on Escape (§5.1).
 *
 * `commit` returns an error message to reject the value: the field goes amber, the message shows
 * below the row, and the edit **stays open** (UX §8) rather than swallowing what was typed.
 */
function committingInput(
  initial: string,
  commit: (raw: string) => string | null,
  options: { note?: string; multiline?: boolean } = {}
): { field: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement } {
  const wrap = el("div");
  // A variant, not a fork (§12): commit, revert and the amber note are identical, and the only
  // behavioural difference is the Enter binding, which the control forces (§7.1).
  const input = options.multiline === true ? el("textarea", "desc-input") : el("input", "inline-edit");
  if (input instanceof HTMLInputElement) input.type = "text";
  if (input instanceof HTMLTextAreaElement) input.rows = 2;
  input.value = initial;

  const note = el("div", "field-note", options.note ?? "");
  note.style.margin = "2px 0 0";
  if (!options.note) note.classList.add("hidden");

  const run = (): void => {
    const error = commit(input.value);
    if (error === null) {
      input.classList.remove("invalid");
      note.classList.add("hidden");
    } else {
      input.classList.add("invalid");
      note.textContent = error;
      note.classList.remove("hidden");
    }
  };

  // Cast because `input` is a union of two element types, which collapses `addEventListener` to its
  // bare-`Event` overload. The handler is the same handler either way — that is §12's "a variant, not
  // a fork" holding at the type level too.
  input.addEventListener("keydown", ((event: KeyboardEvent) => {
    if (event.key === "Enter") {
      // In a textarea Enter must insert a newline — `$description` is a string and DTCG permits
      // them — so ⌘/Ctrl+Enter is what commits there (§7.1). Blur still commits either way.
      if (options.multiline === true && !event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      run();
    } else if (event.key === "Escape") {
      input.value = initial;
      input.classList.remove("invalid");
      note.classList.add("hidden");
      input.blur();
    }
  }) as EventListener);
  input.addEventListener("blur", run);

  wrap.appendChild(input);
  wrap.appendChild(note);
  return { field: wrap, input };
}

function colorEditor(line: Line): HTMLElement {
  const token = line.entry.token;
  const literal = valueShape(token) === "literal" ? String(token.$value) : "";

  return unifiedField(line, {
    // The `$type`, sentence case (§4.2). `Hex` is gone: the hex expectation is carried by the
    // refusal copy on a bad commit, at the moment the user is looking at the problem.
    label: valueLabel("color"),
    commitLiteral: (raw) => {
      const parsed = parseHexColor(raw);
      if (!parsed.ok) return parsed.message;
      return editValue(line, parsed.value);
    },
    leading: (input, reference) => colorChip(line, input, reference, literal),
  });
}

/**
 * The swatch inside the value shell — §4.3, §12.
 *
 * `swatchMark()` and `swatchNode()`, the exact call and the exact classes the tree row makes, under
 * the same `resolutionFor(line)`. A third swatch treatment would be a third vocabulary in a panel
 * whose whole argument is that it has one of everything — and if this chip and the row's chip ever
 * disagreed, the failure `panel-size-and-swatches.md` §5.4 exists to prevent would have reappeared
 * one surface over.
 *
 * The native `<input type="color">` stays as the **hidden mechanism** behind the chip rather than
 * being restyled into looking like one. Clicking the chip opens it; on a reference the chip is inert
 * and the click focuses the text field instead, because a picker that silently converted a pointer
 * into a hex value is the exact flattening Phase 7 exists to prevent (`references-math-themes.md`
 * §4.1). The text field remains the source of truth — 8-digit hex has no `<input type=color>`
 * representation, so alpha is typed, never picked.
 */
function colorChip(
  line: Line,
  input: HTMLInputElement,
  reference: boolean,
  literal: string
): HTMLElement {
  const chip = swatchNode(swatchMark(line.entry.token, resolutionFor(line)));
  chip.classList.add("shell-swatch");

  if (reference) {
    chip.title = "This value points at another token. Edit the field to change it.";
    chip.addEventListener("click", () => input.focus());
    return chip;
  }

  const picker = el("input") as HTMLInputElement;
  picker.type = "color";
  picker.className = "hidden-picker";
  picker.value = literal.length >= 7 ? literal.slice(0, 7) : "#000000";
  // The picker is a child of the chip, so its own click must not bubble back into the chip's handler
  // and reopen it.
  picker.addEventListener("click", (event) => event.stopPropagation());
  picker.addEventListener("change", () => {
    const alpha = literal.length === 9 ? literal.slice(7) : "";
    const parsed = parseHexColor(picker.value + alpha);
    if (!parsed.ok) return;
    const error = editValue(line, parsed.value);
    if (error !== null) toast(error);
  });

  chip.title = "Pick a colour";
  chip.appendChild(picker);
  chip.addEventListener("click", () => {
    // `showPicker` where the engine has it, a forwarded click where it doesn't — either way the
    // native input is never the visible chip.
    const open = (picker as unknown as { showPicker?: () => void }).showPicker;
    if (typeof open === "function") open.call(picker);
    else picker.click();
  });
  return chip;
}

function numberEditor(line: Line): HTMLElement {
  const extension = line.entry.token.$extensions?.["com.tokenvault"];
  return unifiedField(line, {
    label: valueLabel("number"),
    // §5 — the subtype sits **in the value shell**, not in a row of its own, and directly under the
    // value rather than down with description: it changes how the number is read.
    trailing: () => subtypeControl(line),
    commitLiteral: (raw) => {
      const parsed = parseNumberValue(raw);
      if (!parsed.ok) return parsed.message;
      const error = editValue(line, parsed.value);
      if (error !== null) return error;
      // A warning, not a rejection: the value is committed and the note explains itself (§8).
      return subtypeWarning(extension?.subtype, parsed.value);
    },
  });
}

/**
 * §4.1 — the segmented control gains a third, **non-selectable readout position** when the value is
 * a reference.
 *
 * Picking `true` or `false` replaces the reference, and that is a deliberate two-tap action rather
 * than a stray one: the readout is not a button, so the pointer cannot be lost by a mis-click on
 * the control that shows it.
 */
function booleanEditor(line: Line): HTMLElement {
  const token = line.entry.token;
  const reference = valueShape(token) === "reference";
  const wrap = el("div");

  const segmented = el("div", "toolbar");
  if (reference) {
    const readout = el("div", "ref-chip");
    readout.appendChild(el("span", undefined, "↗"));
    readout.appendChild(el("span", "grow", String(token.$value)));
    segmented.appendChild(readout);
  }
  for (const value of [true, false]) {
    const control = button(String(value), token.$value === value ? "primary" : undefined);
    control.addEventListener("click", () => {
      const error = editValue(line, value);
      if (error !== null) toast(error);
    });
    segmented.appendChild(control);
  }
  // §5.3 — a two-state value does not deserve six sections. One `Boolean` label over the segmented
  // group, and the pointer shell below it loses its own `Points at` label and gains a muted hint
  // instead: four lines total, not seven. Both mechanisms stay, because you cannot type `{` into a
  // segmented control.
  wrap.appendChild(fieldRow(valueLabel("boolean"), segmented));
  wrap.appendChild(
    unifiedField(line, {
      label: null,
      hint: "or point at another boolean token",
      initial: reference ? String(token.$value) : "",
      commitLiteral: () =>
        "Type a token path in braces, like {folio.flag.on}, or pick true / false above.",
    })
  );
  return wrap;
}

function stringEditor(line: Line): HTMLElement {
  return unifiedField(line, {
    label: valueLabel("string"),
    trailing: () => subtypeControl(line),
    commitLiteral: (raw) => {
      const parsed = parseStringValue(raw);
      if (!parsed.ok) return parsed.message;
      return editValue(line, parsed.value);
    },
  });
}

// ---------------------------------------------------------------------------

function unitSelect(current: DimensionValue["unit"], onChange: (unit: DimensionValue["unit"]) => void): HTMLSelectElement {
  const select = el("select", "unit") as HTMLSelectElement;
  select.appendChild(new Option("px", "px"));
  select.appendChild(new Option("em", "em"));
  select.value = current;
  select.addEventListener("change", () => onChange(select.value as DimensionValue["unit"]));
  return select;
}

/**
 * What each member of this composite currently resolves to, keyed by its address.
 *
 * One lookup for the whole overlay rather than a resolve per field: the context is theme-scoped and
 * shared, and asking it once is what keeps the per-member `—` and the whole-token preview showing
 * the same answer (§14.6).
 */
function memberResolutions(line: Line): Map<string, Resolution> {
  const resolution = resolutionFor(line);
  const map = new Map<string, Resolution>();
  if (resolution.kind !== "composite") return map;
  for (const member of resolution.members ?? []) {
    map.set(memberKey(member.slot.keyPath), member.resolution);
  }
  return map;
}

/**
 * One composite member as an ordinary Phase 7 value field — §14.1, and the whole of this ticket's
 * authoring surface.
 *
 * Same input, same `{` picker, same three groups, same four rules. What is passed in is the member's
 * own type and its writer; nothing here decides whether the text is a literal, a pointer or a
 * formula, because the parser decides that afterwards exactly as it does for a whole token (§4.1).
 */
function memberValueField(
  line: Line,
  spec: { key: string; label: string; type: MemberType; accepts: MemberAccepts },
  keyPath: Array<string | number>,
  initial: string,
  commit: (raw: string) => string | null,
  resolutions: Map<string, Resolution>,
  trailing?: (input: HTMLInputElement, reference: boolean) => HTMLElement | null,
  placeholder?: string
): HTMLElement {
  return unifiedField(line, {
    label: spec.label,
    initial,
    commitLiteral: commit,
    trailing,
    placeholder,
    member: {
      key: spec.key,
      label: spec.label,
      type: spec.type,
      accepts: spec.accepts,
      commitPointer: commit,
      resolution: resolutions.get(memberKey(keyPath)),
    },
  });
}

function typographyEditor(line: Line): HTMLElement {
  const value = line.entry.token.$value as TypographyValue;
  const wrap = el("div");
  const resolutions = memberResolutions(line);

  const apply = (field: TypographyField, raw: string, unit?: DimensionValue["unit"]): string | null => {
    const parsed = setTypographyField(value, field, raw, unit);
    if (!parsed.ok) return parsed.message;
    return editValue(line, parsed.value);
  };

  const field = (
    key: TypographyField,
    label: string,
    initial: string,
    trailing?: () => HTMLElement | null,
    placeholder?: string
  ): HTMLElement =>
    memberValueField(
      line,
      { key, label, ...typographyMemberSpec(key) },
      [key],
      initial,
      (raw) => apply(key, raw),
      resolutions,
      trailing === undefined ? undefined : () => trailing(),
      placeholder
    );

  // §5.5 — the labels are humanised (`Font size`, not `fontSize`). They are display strings only:
  // copy *about the JSON* keeps the schema key in mono, so rule 2's refusal is still
  // "`fontSize` takes a number, so it can't point there", the `boundVariables` rows still read
  // `fontSize → {…}`, and §14.7's disagreement line still names `fontSize`. The label says what the
  // field is; the copy says what the file holds.
  wrap.appendChild(field("fontFamily", memberLabel("fontFamily"), value.fontFamily));
  wrap.appendChild(field("fontWeight", memberLabel("fontWeight"), String(value.fontWeight)));

  // The unit picker stays where it was, beside the field — but only while the member holds a
  // literal: `px` or `em` is meaningless next to a dotted path, and the unit the value comes out
  // with is the target's (§14.1).
  const unitFor = (key: "fontSize" | "letterSpacing" | "lineHeight") => () => {
    if (typeof value[key] === "string" || value[key] === undefined) return null;
    return unitSelect(dimensionUnit(value[key]), (unit) => {
      const error = apply(key, formatDimension(value[key]), unit);
      if (error !== null) toast(error);
    });
  };

  for (const key of ["fontSize", "letterSpacing"] as const) {
    wrap.appendChild(field(key, memberLabel(key), formatDimension(value[key]), unitFor(key)));
  }

  // Three states, not two (ADR-0003 §3): a number, a dimension, or absent when Figma said Auto.
  // "Auto" removes the key rather than writing a sentinel, so a round-trip stays byte-identical, and
  // it is unaffected by what the field holds (§14.2's last row).
  wrap.appendChild(
    field(
      "lineHeight",
      memberLabel("lineHeight"),
      formatDimension(value.lineHeight),
      () => {
        // "Auto" sits beside the field and is unaffected by what the field holds (§14.2's last
        // row). It removes the key rather than writing a sentinel, so a round-trip stays
        // byte-identical.
        const controls = el("div", "toolbar");
        const unit = unitFor("lineHeight")();
        if (unit !== null) controls.appendChild(unit);
        if (value.lineHeight !== undefined) {
          const auto = button("Auto");
          auto.title = "Remove lineHeight — Figma's Auto has no token equivalent";
          auto.addEventListener("click", () => {
            const error = editValue(line, clearLineHeight(value));
            if (error !== null) toast(error);
          });
          controls.appendChild(auto);
        }
        return controls.childNodes.length === 0 ? null : controls;
      },
      // An absent `lineHeight` is Figma's AUTO, and the placeholder is the only thing that says so.
      value.lineHeight === undefined ? "Auto" : undefined
    )
  );

  return wrap;
}

function shadowEditor(line: Line): HTMLElement {
  const list = shadowList(line.entry.token.$value);
  const wrap = el("div");
  const resolutions = memberResolutions(line);

  const write = (next: ShadowValue[]): string | null => editValue(line, denormalizeShadows(next));
  const writeOrToast = (next: ShadowValue[]): void => {
    const error = write(next);
    if (error !== null) toast(error);
  };

  // §5.6 — with one or two layers everything is expanded, because two stacked layers is a shadow you
  // read as a whole. With three or more, layer 1 stays expanded and the rest fold to their `.subhead`
  // with a swatch and the tree's own one-line preview, which is where the height actually goes.
  const collapsed = new Set(collapsedLayers(list.length));

  list.forEach((shadow, index) => {
    const box = el("div", "subrow");
    const head = el("div", "subhead");
    const layerKey = stateKey(line, ` shadow ${index}`);
    const open = layerOpen.get(layerKey) ?? !collapsed.has(index);

    if (collapsed.has(index)) {
      const toggle = button(`${open ? "▾" : "▸"} Shadow ${index + 1}`, "layer-toggle");
      toggle.addEventListener("click", () => {
        layerOpen.set(layerKey, !open);
        renderNow();
      });
      head.appendChild(toggle);
      if (open) head.appendChild(el("span", "grow"));
      else {
        // Reuses `previewOf` and the shared swatch node — no new vocabulary, and no new string (§8).
        // A layer whose colour is a pointer has no literal colour to paint, which is the outlined
        // mark's existing meaning (`panel-size-and-swatches.md` §4.2).
        head.appendChild(
          swatchNode(
            isColorValue(shadow.color)
              ? { kind: "color", color: shadow.color }
              : { kind: "outlined" }
          )
        );
        head.appendChild(
          el("span", "mono grow", previewOf({ $type: "shadow", $value: shadow } as Token).text)
        );
      }
    } else {
      head.appendChild(el("span", "grow", `Shadow ${index + 1}`));
    }

    if (index > 0) {
      const up = button("↑");
      up.addEventListener("click", () => {
        const next = list.slice();
        next.splice(index - 1, 0, next.splice(index, 1)[0]);
        writeOrToast(next);
      });
      head.appendChild(up);
    }
    const remove = button("Remove");
    remove.addEventListener("click", () => writeOrToast(list.filter((_, at) => at !== index)));
    head.appendChild(remove);
    box.appendChild(head);

    const apply = (field: ShadowField, raw: string): string | null => {
      const parsed = setShadowField(shadow, field, raw);
      if (!parsed.ok) return parsed.message;
      const next = list.slice();
      next[index] = parsed.value;
      return write(next);
    };

    // The address a member resolution is keyed by: a single shadow is a bare object, a stack is an
    // array, and the token's `$value` shape is what tells them apart (edit.ts's `denormalizeShadows`).
    const at = (field: string): Array<string | number> =>
      Array.isArray(line.entry.token.$value) ? [index, field] : [field];

    if (!open) {
      wrap.appendChild(box);
      return;
    }

    const shadowField = (field: ShadowField): HTMLElement =>
      memberValueField(
        line,
        { key: field, label: memberLabel(field), ...shadowMemberSpec(field) },
        at(field),
        field === "color"
          ? shadow.color
          : formatDimension(shadow[field] as Referable<DimensionValue | number>),
        (raw) => apply(field, raw),
        resolutions
      );

    // §5.6 — `Offset X` / `Offset Y` on one line, `Blur` / `Spread` on the next, each ~190px at the
    // 400px floor and ample for a number. **A pair collapses to two full-width stacked rows the
    // moment either member holds a non-literal value**, because a dotted path needs the whole width;
    // a literal dimension is stored as a number or a `{value, unit}`, so a string here *is* the
    // pointer-or-formula case.
    const numeric: ShadowField[] = ["offsetX", "offsetY", "blur", "spread"];
    for (const group of pairMembers(numeric, (key) => typeof shadow[key as ShadowField] === "string")) {
      if (group.length === 1) {
        box.appendChild(shadowField(group[0] as ShadowField));
        continue;
      }
      const pair = el("div", "field-pair");
      for (const key of group) pair.appendChild(shadowField(key as ShadowField));
      box.appendChild(pair);
    }

    // `Color` and `Inset` stay full-width always (§5.6).
    box.appendChild(shadowField("color"));

    const inset = el("select") as HTMLSelectElement;
    inset.appendChild(new Option("drop", "false"));
    inset.appendChild(new Option("inset", "true"));
    inset.value = String(shadow.inset === true);
    inset.addEventListener("change", () => {
      const error = apply("inset", inset.value);
      if (error !== null) toast(error);
    });
    box.appendChild(fieldRow(memberLabel("inset"), inset));

    wrap.appendChild(box);
  });

  const add = button("Add shadow");
  add.addEventListener("click", () => writeOrToast(list.concat([newShadow()])));
  wrap.appendChild(add);
  return wrap;
}

function gridEditor(line: Line): HTMLElement {
  const list = gridList(line.entry.token.$value);
  const wrap = el("div");
  const resolutions = memberResolutions(line);

  const write = (next: GridValue[]): string | null => editValue(line, next);
  const writeOrToast = (next: GridValue[]): void => {
    const error = write(next);
    if (error !== null) toast(error);
  };

  list.forEach((grid, index) => {
    const box = el("div", "subrow");
    const head = el("div", "subhead");
    head.appendChild(el("span", "grow", `Grid ${index + 1}`));
    const remove = button("Remove");
    remove.addEventListener("click", () => writeOrToast(list.filter((_, at) => at !== index)));
    head.appendChild(remove);
    box.appendChild(head);

    const pattern = el("select") as HTMLSelectElement;
    for (const option of ["columns", "rows", "grid"]) pattern.appendChild(new Option(option, option));
    pattern.value = grid.pattern;
    pattern.addEventListener("change", () => {
      const next = list.slice();
      // Switching pattern removes the keys the new one has no place for, rather than zeroing
      // them: `count: 0` on a `grid` is a value the importer would never write (§5.2).
      next[index] = setGridPattern(grid, pattern.value as GridValue["pattern"]);
      writeOrToast(next);
    });
    // §5.7 asks for `Pattern` as a trailing select "in the first shell". It stays its own stacked
    // row: which fields the card even *has* depends on this select (`references-math-themes.md`
    // §14.2 — it decides which keys exist), so parking it inside `alignment`'s or `sectionSize`'s
    // shell would put the control that rebuilds the card inside one of the things it rebuilds.
    box.appendChild(fieldRow(memberLabel("pattern"), pattern));

    const apply = (field: GridField, raw: string): string | null => {
      const parsed = setGridField(grid, field, raw);
      if (!parsed.ok) return parsed.message;
      const next = list.slice();
      next[index] = parsed.value;
      return write(next);
    };

    const rawOf = (field: GridField): string =>
      field === "alignment"
        ? grid.alignment ?? ""
        : field === "count"
          ? grid.count === undefined
            ? ""
            : String(grid.count)
          : formatDimension(grid[field]);

    const gridField = (field: GridField): HTMLElement => {
      const raw = rawOf(field);
      // `alignment` names one of Figma's own enum values and takes no pointer (§14.2), so it stays
      // the plain input it was — a picker on it would offer paths the field then refuses.
      if (gridMemberSpec(field).accepts === "literal") {
        const input = committingInput(raw, (typed) => apply(field, typed));
        input.input.placeholder = "empty = absent";
        return fieldRow(memberLabel(field), input.field);
      }

      return memberValueField(
        line,
        { key: field, label: memberLabel(field), ...gridMemberSpec(field) },
        [index, field],
        raw,
        (typed) => apply(field, typed),
        resolutions,
        undefined,
        "empty = absent"
      );
    };

    // Only the fields valid for the current pattern render, and switching pattern still *removes*
    // keys rather than zeroing them (`local-editor.md` §5.2). The literal-only ones stay full-width;
    // the numeric ones pair two-up under §5.6's rule, unpairing when either holds a pointer.
    const fields = gridFieldsFor(grid.pattern);
    const literalOnly = fields.filter((field) => gridMemberSpec(field).accepts === "literal");
    const numeric = fields.filter((field) => gridMemberSpec(field).accepts !== "literal");
    for (const field of literalOnly) box.appendChild(gridField(field));
    for (const group of pairMembers(numeric, (key) => typeof grid[key as GridField] === "string")) {
      if (group.length === 1) {
        box.appendChild(gridField(group[0] as GridField));
        continue;
      }
      const pair = el("div", "field-pair");
      for (const key of group) pair.appendChild(gridField(key as GridField));
      box.appendChild(pair);
    }

    wrap.appendChild(box);
  });

  const add = button("Add grid");
  add.addEventListener("click", () => writeOrToast(list.concat([newGrid()])));
  wrap.appendChild(add);
  return wrap;
}

// ---------------------------------------------------------------------------

/**
 * §7.1 — a two-row textarea, label above, placeholder `Optional description`.
 *
 * `none` read like a value; `Optional description` says what the field is for. Newlines are preserved
 * rather than stripped: `$description` is a string and DTCG permits them, and the tree row and the
 * push diff already truncate to one line. No character counter, no markdown, no validation — it is an
 * optional string.
 */
function renderDescription(line: Line): HTMLElement {
  const field = committingInput(
    line.entry.token.$description ?? "",
    (raw) => editDescription(line, raw),
    { multiline: true }
  );
  field.input.placeholder = "Optional description";
  return fieldRow("Description", field.field);
}

/**
 * The subtype dropdown, which writes `userSubtypes` — **not** the overlay (ADR-0004 §3).
 *
 * One concern, one storage path. Routing it through the overlay would give the same decision two
 * homes that could disagree, and it is why a subtype change doesn't count toward the
 * **Local edits · N** chip.
 */
function subtypeControl(line: Line): HTMLElement | null {
  const type = line.entry.token.$type;
  if (type !== "number" && type !== "string") return null;
  const extension = line.entry.token.$extensions?.["com.tokenvault"];
  const variableId = extension?.figma?.variableId;
  if (variableId === undefined) return null;

  const select = el("select", "subtype") as HTMLSelectElement;
  select.appendChild(new Option("auto-detect", "__reset"));
  select.appendChild(new Option("untagged", "untagged"));
  for (const subtype of type === "number" ? NUMBER_SUBTYPES : STRING_SUBTYPES) {
    select.appendChild(new Option(subtype, subtype));
  }
  select.value = extension?.subtype ?? (extension?.subtypeSource === "user" ? "untagged" : "__reset");
  select.addEventListener("change", () => {
    const chosen = select.value === "__reset" ? null : (select.value as SubtypeSelection);
    send({ type: "set-subtypes", subtypes: { [variableId]: chosen } });
  });

  if (extension?.subtypeSource !== "default") return select;

  // The `guessed` badge follows the select, and the shell wraps rather than overflowing when there is
  // no room for both at 400px (§5).
  const group = el("span", "subtype-group");
  group.appendChild(select);
  group.appendChild(el("span", "badge needs", "guessed"));
  return group;
}

/**
 * The Figma section — one disclosure holding all of the read-only provenance (§6).
 *
 * `local-editor.md` §5.2's rule is *provenance is always shown*, and that survives a collapsed
 * accordion because **the Source line is promoted into the always-visible summary row** (§6.1): the
 * ids, the scopes and the bindings fold away; where the token came from never does.
 *
 * Collapsed by default, because this is reference material and the editable fields are the point —
 * *except* when it explains a value the user is looking at (§6.2). Two triggers, both of them
 * `local-editor.md` §5.2's own reasoning honoured rather than overridden: a populated
 * `boundVariables` is why a text style's numbers look "already aliased", and hiding the reason makes
 * the value editor look broken; and §14.7's disagreement line only exists to explain which of two
 * values applies.
 *
 * One level of disclosure inside, with one exception: `boundVariables` is a plain sub-block, because
 * nested disclosures at 400px are a maze, while the `text` extras keep theirs — eleven rows of Figma
 * internals nobody reads is exactly what a disclosure is for.
 *
 * `null` when there is no provenance at all (§8): nothing here renders an empty container, and
 * `editBlockedReason`'s existing sentence already explains what a missing binding means for editing.
 */
function renderFigmaSection(line: Line): HTMLElement | null {
  const figma = line.entry.token.$extensions?.["com.tokenvault"]?.figma ?? {};
  if (!hasFigmaSection(figma)) return null;

  const bound = figma.boundVariables ?? {};
  const boundKeys = Object.keys(bound).sort();
  const disagreements = valueDisagreements(line, bound);

  const details = el("details", "figma-section") as HTMLDetailsElement;
  const key = stateKey(line);
  details.open =
    figmaOpen.get(key) ??
    autoExpandFigma({ bound: boundKeys.length > 0, disagreement: disagreements.length > 0 });
  details.addEventListener("toggle", () => figmaOpen.set(key, details.open));

  const summary = el("summary");
  summary.appendChild(el("span", undefined, "Figma"));
  const source = figmaSummary(figma, line.set.label);
  if (source !== null) summary.appendChild(el("span", "muted", `· ${source}`));
  details.appendChild(summary);

  const body = el("div", "provenance");

  if (figma.variableId !== undefined) {
    body.appendChild(el("div", "mono", `${figma.variableId} · mode ${figma.modeId ?? "?"}`));
  } else if (figma.styleId !== undefined) {
    body.appendChild(el("div", "mono", figma.styleId));
    if (figma.fontStyle !== undefined) {
      body.appendChild(el("div", undefined, `Figma font style  ${figma.fontStyle}`));
    }
  }

  // Read-only, humanised by a mechanical transform, and **omitted entirely when absent** (§6.3) —
  // no `None`, no dash. Comma-separated and wrapping, never badges: `local-editor.md` §9 keeps
  // `.badge` for state, and a scope is not a state. No checkboxes and no write-back: `scopes` are
  // read every import and never edited.
  const scopes = scopesLine(figma.scopes);
  if (scopes !== null) body.appendChild(el("div", undefined, `Scopes  ${scopes}`));

  if (boundKeys.length > 0) {
    // `Bound in Figma`, not `N bound Variables`: the count was doing nothing and the phrase reads as
    // a fact rather than as a file listing (§8).
    body.appendChild(el("div", "sub-head", "Bound in Figma"));
    for (const bindingKey of boundKeys) {
      body.appendChild(el("div", "mono", `${bindingKey} → ${bound[bindingKey]}`));
    }
    // §14.7 — grey, not amber, and only when the two disagree. Keeps the schema key in mono, because
    // this is copy *about the JSON* and never routed through §5.5's label map.
    for (const message of disagreements) body.appendChild(el("div", "muted", message));
  }

  const extras = figma.text ?? {};
  const extraKeys = Object.keys(extras);
  if (extraKeys.length > 0) {
    const inner = el("details");
    inner.appendChild(el("summary", undefined, `${extraKeys.length} Figma text properties`));
    for (const extraKey of extraKeys.sort()) {
      inner.appendChild(el("div", "mono", `${extraKey}: ${String(extras[extraKey])}`));
    }
    body.appendChild(inner);
  }

  details.appendChild(body);
  return details;
}

/**
 * §14.7's lines — where Figma's own binding and the token's authored value disagree about a member.
 *
 * Only when they **disagree**: re-authoring what Figma already bound is the common case, and two
 * lines agreeing needs no commentary.
 *
 * Keyed by the slot's full address, not its bare name: two shadow layers both have a `blur`, and
 * `shadowBoundVariables` files a multi-layer binding as `shadows.<index>.<field>` for exactly that
 * reason. A bare-name lookup would read layer 1's binding against layer 2's authored value and
 * announce a disagreement that doesn't exist.
 */
function valueDisagreements(line: Line, bound: Record<string, unknown>): string[] {
  if (Object.keys(bound).length === 0) return [];
  const layers = memberLayerCount(line.entry.token.$value);
  const messages: string[] = [];
  for (const slot of nonLiteralMembers(line.entry.token)) {
    const binding = firstDefined(bound, memberBindingKeys(slot, layers));
    if (binding === undefined) continue;
    const authored = String(slot.value);
    if (String(binding) === authored) continue;
    messages.push(
      `Figma binds \`${slot.label}\` to ${String(binding)}. This token's own value points at ${authored}, and that's what applies.`
    );
  }
  return messages;
}

/** The first of `keys` the map actually carries — `memberBindingKeys`' most-specific-first order. */
function firstDefined(map: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Delete — §7
// ---------------------------------------------------------------------------

function renderPathActions(row: Row): HTMLElement {
  const section = el("div", "toolbar");
  if (row.lines.length > 1) {
    // `Apply all N sets` has moved to the pinned footer (§7.2). What stays here is destructive, and
    // destructive actions do not belong in a permanently visible footer next to `Done`.
    section.appendChild(
      deleteButton(row.lines, {
        action: `Delete from all ${row.lines.length} sets`,
        subject: `${row.row.path} from all ${row.lines.length} sets`,
      })
    );
    section.appendChild(deleteInFigmaButton(row.lines));
  }
  return section;
}

/**
 * Every apply entry point in this module funnels here, and here funnels into the dialog.
 *
 * UX §5.2's invariant restated as code: a one-row dialog *is* the confirmation, and there is no
 * path around it — not even for a single token.
 */
export function applyLines(lines: Line[], title: string): void {
  openApplyDialog({
    plan: planFor({ keys: keysOf(lines) }),
    title,
    nothingToDo: "Figma already matches this.",
    onNothingToDo: toast,
  });
}

/** The destructive control. Red, ellipsised, and it opens a screen rather than acting. */
export function deleteInFigmaButton(lines: Line[]): HTMLButtonElement {
  const control = button("Delete in Figma…", "danger");
  control.title = "Removes the Variable or Style from this file. Not undoable from the plugin.";
  control.addEventListener("click", () => {
    const key = openKey;
    const set = focusSet;
    openDeleteInFigma(lines, {
      navigate: (path) => navigate(path),
      // Hand the panel back to the detail view it replaced, rather than dumping the user in the
      // tree having lost their place.
      onClose: () => {
        if (key !== null && getModel().byPath.has(key)) openDetail(key, set);
      },
    });
  });
  return control;
}

/**
 * The delete control, disabled while anything references the token (§7, Shyam's call §10.3).
 *
 * Not warn-and-allow. Phase 4 cannot rewrite a reference, so allowing the delete would manufacture
 * a `dangling-reference` the *user* created — and that badge would stop meaning "the import found
 * this". Choosing the disabled control opens an explanation, never a confirmation.
 */
export function deleteButton(
  lines: Line[],
  labels: { action: string; subject: string }
): HTMLButtonElement {
  const paths = Array.from(new Set(lines.map((line) => line.entry.path)));
  const block = deleteBlockers(paths);

  if (block.count > 0) {
    // The count is inline on the control, so the user learns the delete is unavailable before
    // clicking it rather than after (§7).
    const blocked = button(`${labels.action} — ${block.count} reference${block.count === 1 ? "" : "s"}`);
    blocked.addEventListener("click", () => showBlockedPanel(paths, block.referrers));
    blocked.style.opacity = "0.6";
    return blocked;
  }

  const control = button(labels.action);
  control.addEventListener("click", () => runDelete(lines, paths, labels.subject));
  return control;
}

/**
 * The delete itself, with the blocker check re-run **at click time**.
 *
 * The label's count is computed when the control is built, and a reference can appear while it is
 * still on screen — editing another token's value to point here, for one. Trusting the stale check
 * would let a delete through that manufactures exactly the dangling reference §7 exists to
 * prevent, so the check at the moment of the write is the one that decides.
 */
export function runDelete(lines: Line[], paths: string[], subject: string): void {
  const block = deleteBlockers(paths);
  if (block.count > 0) {
    showBlockedPanel(paths, block.referrers);
    return;
  }

  const targets = lines
    .map((line) => line.target)
    .filter((target): target is OverlayTarget => target !== null);
  const outcome = deleteLines(lines);

  // Never claim a deletion that didn't happen: a line with no overlay target has nothing to
  // tombstone, and closing the panel on a "Deleted" toast would be a lie the user can't check.
  if (outcome.deleted === 0) {
    toast(`Couldn't delete ${subject} — no Figma Variable or Style behind it.`);
    return;
  }
  if (outcome.skipped > 0) {
    toast(
      `Deleted ${subject} — ${outcome.skipped} couldn't be deleted (no Figma Variable or Style behind them).`,
      { label: "Undo", run: () => revert(targets, "delete") }
    );
  } else {
    toast(`Deleted ${subject}`, { label: "Undo", run: () => revert(targets, "delete") });
  }
  closeDetail();
}

/**
 * The explanation panel — the referrer list is the whole point of it, so it is never truncated.
 *
 * Each entry navigates to that token. There is still deliberately no "remove all references"
 * button: Phase 7 makes re-pointing *possible* but does not make it automatic, and rewriting seven
 * tokens' values on one tap is reference surgery the user hasn't seen (UX §12). The block is now a
 * dead end they can dig out of, which is what Phase 4 §7's "be honest that this can be a dead end"
 * was waiting for.
 */
export function showBlockedPanel(paths: string[], referrers: Array<{ path: string; sets: string[] }>): void {
  const model = getModel();
  const codes = new Map(model.sets.map((info) => [info.id, info.code] as const));

  blockedPanel = true;
  panelEl.textContent = "";
  panelEl.classList.remove("hidden");

  const head = el("div", "panel-head");
  const back = button("←");
  back.addEventListener("click", dismissBlockedPanel);
  head.appendChild(back);
  head.appendChild(el("div", "title", "Can't delete yet"));
  panelEl.appendChild(head);

  const body = el("div", "panel-body");
  const box = el("div", "entry");
  box.appendChild(el("span", "kind", `Can't delete ${paths.length === 1 ? paths[0] : `${paths.length} tokens`} yet.`));
  const total = referrers.reduce((sum, referrer) => sum + referrer.sets.length, 0);
  box.appendChild(
    el("div", undefined, `${total} token${total === 1 ? "" : "s"} still reference ${paths.length === 1 ? "it" : "them"}. Deleting would leave them pointing at nothing.`)
  );
  body.appendChild(box);

  for (const referrer of referrers) {
    const row = el("div", "row");
    const name = el("div", "name", referrer.path);
    name.style.cursor = "pointer";
    name.addEventListener("click", () => {
      closeDetail();
      navigate(referrer.path);
    });
    row.appendChild(name);
    row.appendChild(
      el("span", "badge", referrer.sets.map((set) => codes.get(set) ?? set).join(", "))
    );
    body.appendChild(row);
  }

  body.appendChild(
    el(
      "p",
      "empty",
      "Re-point them at something else, or delete them first — deepest first, since they may have references of their own. There is deliberately no “remove all references” button: rewriting seven tokens' values on one tap is reference surgery you haven't seen."
    )
  );

  const close = button("Close");
  close.addEventListener("click", dismissBlockedPanel);
  body.appendChild(close);

  panelEl.appendChild(body);
}

/** Hands the panel back to the detail view, or closes it if there was nothing open behind. */
function dismissBlockedPanel(): void {
  blockedPanel = false;
  if (openKey !== null) renderNow();
  else closeDetail();
}
