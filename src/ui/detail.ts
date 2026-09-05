// The token detail / editor overlay — UX local-editor §5.
//
// "Overlay", not "modal": it slides over the full panel, keeps the tree's scroll position, and has
// a back arrow. At 460×640 a centred modal with a dimmed backdrop spends a third of the panel on
// chrome (§5.1).
//
// One overlay covers **all of a path's sets** (§5.1). Opening a separate one per set would make
// the user back out and re-enter to compare `Light` against `Dark`, which is the thing the merged
// view was chosen to make easy.

import type {
  DimensionValue,
  GridValue,
  ShadowValue,
  SubtypeSelection,
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
  memberKey,
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
import { isConnected } from "./git";
import { openApplyDialog } from "./applyDialog";
import { openDeleteInFigma } from "./deleteFigma";
import { button, closePopover, copy, el, isPopoverOpen, popover, toast } from "./dom";
import { describeValue } from "../tokens/format";
import { normalizePathKey } from "../tokens/paths";

const panelEl = document.getElementById("panel") as HTMLElement;

let openKey: string | null = null;
let focusSet: string | undefined;
let navigate: (path: string) => void = () => undefined;

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

  const head = el("div", "panel-head");
  const back = button("←");
  back.title = "Back to the tree";
  back.addEventListener("click", closeDetail);
  head.appendChild(back);
  head.appendChild(el("div", "title", row.row.path));

  const copyPath = button("Copy path");
  copyPath.addEventListener("click", () => copy(row.row.path, "the token path"));
  head.appendChild(copyPath);
  panelEl.appendChild(head);

  const body = el("div", "panel-body");
  // Phase 5's whole job was to remove Phase 4's "editing changes nothing on the canvas" sentence.
  // What replaces it has to be equally precise about the *new* boundary: edits are still local
  // until applied, and applying is still not committing anything (git sync is Phase 6).
  body.appendChild(
    el(
      "p",
      "empty",
      "Editing changes the local token tree. Use Apply to write it into Figma — nothing is committed anywhere until git sync lands in Phase 6."
    )
  );

  for (const line of row.lines) body.appendChild(renderSetSection(row, line));

  body.appendChild(renderPathActions(row));
  panelEl.appendChild(body);

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

function renderSetSection(row: Row, line: Line): HTMLElement {
  const section = el("div", "set-section");
  section.setAttribute("data-set-section", line.entry.setId);

  const heading = el("h3");
  heading.appendChild(el("span", "mono", line.set.code));
  heading.appendChild(el("span", "badge", line.entry.token.$type));
  if (line.edited) heading.appendChild(el("span", "badge", "edited"));
  for (const flag of line.flags) heading.appendChild(el("span", "badge needs", flag.kind));
  section.appendChild(heading);
  section.title = line.set.label;

  if (line.conflict !== undefined) section.appendChild(renderConflict(line));
  else if (line.drift !== undefined) section.appendChild(renderDrift(line));
  else if (!line.edited) section.appendChild(renderInSync());

  // An edit is keyed on Figma provenance (ADR-0004 §2). Without one there is nothing to key on, so
  // say it up front rather than letting every field accept a value and quietly discard it (§8).
  const blocked = editBlockedReason(line);
  if (blocked !== null) section.appendChild(el("div", "empty", blocked));

  section.appendChild(renderValueEditor(line));
  section.appendChild(renderDescription(line));

  const subtype = renderSubtype(line);
  if (subtype !== null) section.appendChild(subtype);

  section.appendChild(renderProvenance(line));

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

  for (const flag of line.flags) {
    section.appendChild(el("div", "empty", flag.message));
  }

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

function renderValueEditor(line: Line): HTMLElement {
  // §7.3b — a token on a loop shows the block first, because the loop is the thing in the error
  // state rather than this token. The editor still follows it: *"editing any one of them breaks
  // it"* is only true if one of them can be edited, and this is one of them.
  const cycle = onCycle(line) ? resolutionFor(line).cycle : undefined;
  if (cycle !== undefined) {
    const wrap = el("div");
    wrap.appendChild(
      cycleBlock(cycle, getModel().resolve, {
        navigate: (path: string) => {
          closeDetail();
          navigate(path);
        },
      })
    );
    wrap.appendChild(typedEditor(line));
    return wrap;
  }

  return typedEditor(line);
}

/** The per-type editor, once the cycle block (if any) has had its say. */
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
    label?: string;
    /** Parses and commits a literal for this `$type`. Returns an error message or `null`. */
    commitLiteral?: (raw: string) => string | null;
    /** Extra control beside the input — the colour swatch. */
    trailing?: (input: HTMLInputElement, reference: boolean) => HTMLElement | null;
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
  const row = el("div", "field");
  row.appendChild(el("label", undefined, options.label ?? "Value"));

  const initial = options.initial ?? String(token.$value);
  const accepted = acceptedTypes(type, member);
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.value = initial;
  input.className = "inline-edit";
  input.style.flex = "1";
  if (options.placeholder !== undefined) input.placeholder = options.placeholder;

  const note = el("div", "field-note hidden");
  const extra = el("div");

  const clearNotes = (): void => {
    input.classList.remove("invalid");
    note.classList.add("hidden");
    note.textContent = "";
    extra.textContent = "";
  };

  const showAmber = (message: string): void => {
    input.classList.add("invalid");
    note.classList.remove("hidden");
    note.classList.add("warn");
    note.textContent = message;
  };

  const showGrey = (message: string): void => {
    input.classList.remove("invalid");
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

  row.appendChild(input);
  const trailing = options.trailing?.(input, isReference(member === undefined ? token.$value : initial));
  if (trailing !== null && trailing !== undefined) row.appendChild(trailing);

  wrap.appendChild(row);
  wrap.appendChild(live);
  wrap.appendChild(note);
  wrap.appendChild(extra);
  renderLive();

  const footer =
    member === undefined ? pointerFooter(line, setField) : memberFooter(member, initial);
  if (footer !== null) wrap.appendChild(footer);

  return wrap;
}

/**
 * `Go to target` and the cycle block, for one member.
 *
 * The same two affordances a scalar pointer gets, minus *Use the resolved value instead*: a member's
 * resolved value is a dimension object, not a string a field can be pre-filled with, and offering a
 * button that writes `[object Object]` would be worse than not offering one.
 */
function memberFooter(member: MemberField, initial: string): HTMLElement | null {
  const wrap = el("div");
  const target = pointerTarget(initial);

  if (target !== null && getModel().byPath.has(normalizePathKey(target))) {
    const bar = el("div", "toolbar");
    const go = button("Go to target");
    go.addEventListener("click", () => {
      closeDetail();
      navigate(target);
    });
    bar.appendChild(go);
    wrap.appendChild(bar);
  }

  // §14.6 — a cycled member renders the block **under its own field**, and every other member of the
  // composite still edits normally. Same block, same copy, one component (§7.2).
  if (member.resolution?.kind === "cycle" && member.resolution.cycle !== undefined) {
    wrap.appendChild(
      cycleBlock(member.resolution.cycle, getModel().resolve, {
        navigate: (path: string) => {
          closeDetail();
          navigate(path);
        },
      })
    );
  }

  return wrap.childNodes.length === 0 ? null : wrap;
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
  options: { note?: string } = {}
): { field: HTMLElement; input: HTMLInputElement } {
  const wrap = el("div");
  const input = el("input") as HTMLInputElement;
  input.type = "text";
  input.value = initial;
  input.className = "inline-edit";

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

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      run();
    } else if (event.key === "Escape") {
      input.value = initial;
      input.classList.remove("invalid");
      note.classList.add("hidden");
      input.blur();
    }
  });
  input.addEventListener("blur", run);

  wrap.appendChild(input);
  wrap.appendChild(note);
  return { field: wrap, input };
}

function colorEditor(line: Line): HTMLElement {
  const token = line.entry.token;
  const literal = valueShape(token) === "literal" ? String(token.$value) : "";

  return unifiedField(line, {
    label: "Hex",
    commitLiteral: (raw) => {
      const parsed = parseHexColor(raw);
      if (!parsed.ok) return parsed.message;
      return editValue(line, parsed.value);
    },
    trailing: (input, reference) => {
      // The hex field is the source of truth; the native picker is a convenience that writes into
      // it. 8-digit hex has no `<input type=color>` representation, so alpha is typed, never picked.
      const picker = el("input") as HTMLInputElement;
      picker.type = "color";
      picker.className = "unit";

      if (reference) {
        // §4.1 — while the value is a reference the swatch is **inert and shows the resolved
        // colour**. A colour picker that silently converted a pointer into a hex value is the exact
        // silent flattening this phase exists to prevent, so clicking it only focuses the field.
        const resolved = resolvedLiteralFor(line);
        picker.value = resolved !== null && resolved.length >= 7 ? resolved.slice(0, 7) : "#000000";
        picker.disabled = true;
        const shell = el("span");
        shell.appendChild(picker);
        shell.addEventListener("click", () => input.focus());
        return shell;
      }

      picker.value = literal.length >= 7 ? literal.slice(0, 7) : "#000000";
      picker.addEventListener("change", () => {
        const alpha = literal.length === 9 ? literal.slice(7) : "";
        const parsed = parseHexColor(picker.value + alpha);
        if (!parsed.ok) return;
        const error = editValue(line, parsed.value);
        if (error !== null) toast(error);
      });
      return picker;
    },
  });
}

function numberEditor(line: Line): HTMLElement {
  const extension = line.entry.token.$extensions?.["com.tokenvault"];
  return unifiedField(line, {
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
  wrap.appendChild(fieldRow("Value", segmented));
  wrap.appendChild(
    unifiedField(line, {
      label: "Points at",
      initial: reference ? String(token.$value) : "",
      commitLiteral: () =>
        "Type a token path in braces, like {folio.flag.on}, or pick true / false above.",
    })
  );
  return wrap;
}

function stringEditor(line: Line): HTMLElement {
  return unifiedField(line, {
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

  wrap.appendChild(field("fontFamily", "fontFamily", value.fontFamily));
  wrap.appendChild(field("fontWeight", "fontWeight", String(value.fontWeight)));

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
    wrap.appendChild(field(key, key, formatDimension(value[key]), unitFor(key)));
  }

  // Three states, not two (ADR-0003 §3): a number, a dimension, or absent when Figma said Auto.
  // "Auto" removes the key rather than writing a sentinel, so a round-trip stays byte-identical, and
  // it is unaffected by what the field holds (§14.2's last row).
  wrap.appendChild(
    field(
      "lineHeight",
      "lineHeight",
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

  list.forEach((shadow, index) => {
    const box = el("div", "subrow");
    const head = el("div", "subhead");
    head.appendChild(el("span", "grow", `Shadow ${index + 1}`));

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

    for (const field of ["offsetX", "offsetY", "blur", "spread", "color"] as const) {
      box.appendChild(
        memberValueField(
          line,
          { key: field, label: field, ...shadowMemberSpec(field) },
          at(field),
          field === "color" ? shadow.color : formatDimension(shadow[field]),
          (raw) => apply(field, raw),
          resolutions
        )
      );
    }

    const inset = el("select") as HTMLSelectElement;
    inset.appendChild(new Option("drop", "false"));
    inset.appendChild(new Option("inset", "true"));
    inset.value = String(shadow.inset === true);
    inset.addEventListener("change", () => {
      const error = apply("inset", inset.value);
      if (error !== null) toast(error);
    });
    box.appendChild(fieldRow("inset", inset));

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
    box.appendChild(fieldRow("pattern", pattern));

    const apply = (field: GridField, raw: string): string | null => {
      const parsed = setGridField(grid, field, raw);
      if (!parsed.ok) return parsed.message;
      const next = list.slice();
      next[index] = parsed.value;
      return write(next);
    };

    for (const field of gridFieldsFor(grid.pattern)) {
      const raw =
        field === "alignment"
          ? grid.alignment ?? ""
          : field === "count"
            ? grid.count === undefined
              ? ""
              : String(grid.count)
            : formatDimension(grid[field]);

      // `alignment` names one of Figma's own enum values and takes no pointer (§14.2), so it stays
      // the plain input it was — a picker on it would offer paths the field then refuses.
      if (gridMemberSpec(field).accepts === "literal") {
        const input = committingInput(raw, (typed) => apply(field, typed));
        input.input.placeholder = "empty = absent";
        box.appendChild(fieldRow(field, input.field));
        continue;
      }

      box.appendChild(
        memberValueField(
          line,
          { key: field, label: field, ...gridMemberSpec(field) },
          [index, field],
          raw,
          (typed) => apply(field, typed),
          resolutions,
          undefined,
          "empty = absent"
        )
      );
    }

    wrap.appendChild(box);
  });

  const add = button("Add grid");
  add.addEventListener("click", () => writeOrToast(list.concat([newGrid()])));
  wrap.appendChild(add);
  return wrap;
}

// ---------------------------------------------------------------------------

function renderDescription(line: Line): HTMLElement {
  const field = committingInput(line.entry.token.$description ?? "", (raw) =>
    editDescription(line, raw)
  );
  field.input.placeholder = "none";
  return fieldRow("Description", field.field);
}

/**
 * The subtype dropdown, which writes `userSubtypes` — **not** the overlay (ADR-0004 §3).
 *
 * One concern, one storage path. Routing it through the overlay would give the same decision two
 * homes that could disagree, and it is why a subtype change doesn't count toward the
 * **Local edits · N** chip.
 */
function renderSubtype(line: Line): HTMLElement | null {
  const type = line.entry.token.$type;
  if (type !== "number" && type !== "string") return null;
  const extension = line.entry.token.$extensions?.["com.tokenvault"];
  const variableId = extension?.figma?.variableId;
  if (variableId === undefined) return null;

  const select = el("select") as HTMLSelectElement;
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

  const row = fieldRow("Subtype", select);
  if (extension?.subtypeSource === "default") {
    row.appendChild(el("span", "badge needs", "guessed"));
  }
  return row;
}

/**
 * Source, `boundVariables` and the `text` extras — read-only, always shown, never editable (§5.2).
 *
 * `boundVariables` is shown because it is why a text style's numbers look "already aliased";
 * hiding it makes the value editor look broken.
 */
function renderProvenance(line: Line): HTMLElement {
  const figma = line.entry.token.$extensions?.["com.tokenvault"]?.figma ?? {};
  const wrap = el("div", "provenance");

  if (figma.variableId !== undefined) {
    wrap.appendChild(el("div", undefined, `Source  Variable · ${line.set.label}`));
    wrap.appendChild(el("div", "mono", `${figma.variableId} · mode ${figma.modeId ?? "?"}`));
    if (figma.scopes !== undefined && figma.scopes.length > 0) {
      wrap.appendChild(el("div", undefined, `Scopes  ${figma.scopes.join(", ")}`));
    }
  } else if (figma.styleId !== undefined) {
    wrap.appendChild(el("div", undefined, `Source  Style · ${figma.styleType ?? "?"}`));
    wrap.appendChild(el("div", "mono", figma.styleId));
    if (figma.fontStyle !== undefined) {
      wrap.appendChild(el("div", undefined, `Figma font style  ${figma.fontStyle}`));
    }
  }

  const bound = figma.boundVariables ?? {};
  const boundKeys = Object.keys(bound);
  if (boundKeys.length > 0) {
    const details = el("details");
    details.appendChild(el("summary", undefined, `${boundKeys.length} bound Variables`));
    for (const key of boundKeys.sort()) {
      details.appendChild(el("div", "mono", `${key} → ${bound[key]}`));
    }
    wrap.appendChild(details);

    // §14.7 — the two can now both exist, so the overlay says which one applies. Only when they
    // **disagree**: re-authoring what Figma already bound is the common case, and two lines agreeing
    // needs no commentary. Grey, not amber, for the same reason §6.2's resolve line is grey —
    // nothing is broken and nothing needs the user.
    for (const slot of nonLiteralMembers(line.entry.token)) {
      const binding = bound[slot.key];
      if (binding === undefined) continue;
      const authored = String(slot.value);
      if (String(binding) === authored) continue;
      wrap.appendChild(
        el(
          "div",
          "muted",
          `Figma binds \`${slot.key}\` to ${String(binding)}. This token's own value points at ${authored}, and that's what applies.`
        )
      );
    }
  }

  const extras = figma.text ?? {};
  const extraKeys = Object.keys(extras);
  if (extraKeys.length > 0) {
    const details = el("details");
    details.appendChild(el("summary", undefined, `${extraKeys.length} Figma text properties`));
    for (const key of extraKeys.sort()) {
      details.appendChild(el("div", "mono", `${key}: ${String(extras[key])}`));
    }
    wrap.appendChild(details);
  }

  return wrap;
}

// ---------------------------------------------------------------------------
// Delete — §7
// ---------------------------------------------------------------------------

function renderPathActions(row: Row): HTMLElement {
  const section = el("div", "toolbar");
  if (row.lines.length > 1) {
    if (row.lines.some((line) => line.edited)) {
      const apply = button(`Apply all ${row.lines.length} sets`, "primary");
      apply.addEventListener("click", () => applyLines(row.lines, `Apply ${row.row.path}`));
      section.appendChild(apply);
    }
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
