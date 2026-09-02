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
import { isReference, referenceTarget } from "../tokens/references";
import { NUMBER_SUBTYPES, STRING_SUBTYPES } from "../tokens/subtype";
import type { GridField, ShadowField, TypographyField } from "../tokens/edit";
import {
  deleteBlockers,
  deleteLines,
  editBlockedReason,
  editDescription,
  editValue,
  getModel,
  resolveKeepMine,
  revert,
  send,
} from "./state";
import { button, copy, el, toast } from "./dom";
import { stableStringify } from "../tokens/serialize";
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
  body.appendChild(
    el(
      "p",
      "empty",
      "Editing changes the local token tree only. Nothing is written to Figma, and nothing is committed anywhere — git sync lands in Phase 6."
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
    const revertOne = button("Revert to imported value");
    revertOne.addEventListener("click", () => {
      if (line.target !== null) revert([line.target]);
      toast(`Reverted ${row.row.path} in ${line.set.code}`);
    });
    actions.appendChild(revertOne);
  }
  actions.appendChild(
    deleteButton([line], { action: "Delete", subject: `${row.row.path} in ${line.set.code}` })
  );
  section.appendChild(actions);

  for (const flag of line.flags) {
    section.appendChild(el("div", "empty", flag.message));
  }

  return section;
}

/** UX §5.5's conflict block: both sides, local shown as live, one tap each way. */
function renderConflict(line: Line): HTMLElement {
  const conflict = line.conflict as NonNullable<Line["conflict"]>;
  const box = el("div", "conflict-box");
  box.appendChild(el("div", undefined, "⚑ Conflict — both you and Figma changed this"));
  box.appendChild(el("div", "mono", `Your edit    ${describe(conflict.value)}`));
  box.appendChild(el("div", "mono", `Now in Figma ${describe(conflict.conflict?.figma)}`));
  box.appendChild(el("div", undefined, "Your edit is being used."));

  const actions = el("div", "actions");
  const mine = button("Keep mine");
  mine.addEventListener("click", () => {
    if (line.target !== null) resolveKeepMine(line.target, conflict.op);
    toast("Kept your value.");
  });
  const theirs = button("Take Figma's");
  theirs.addEventListener("click", () => {
    if (line.target !== null) revert([line.target], conflict.op);
    toast("Took Figma's value.");
  });
  actions.appendChild(mine);
  actions.appendChild(theirs);
  box.appendChild(actions);
  return box;
}

function describe(value: TokenValue | undefined): string {
  if (value === undefined) return "—";
  if (typeof value === "object") return stableStringify(value).trim().replace(/\s+/g, " ");
  return String(value);
}

// ---------------------------------------------------------------------------
// Value editors — §5.2
// ---------------------------------------------------------------------------

function renderValueEditor(line: Line): HTMLElement {
  const token = line.entry.token;
  if (isReference(token.$value)) return renderReferenceChip(line);

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
 * A reference is rendered verbatim, badged, and read-only (§5.3).
 *
 * There is deliberately no "break the link and type a literal" escape hatch: that is an aliasing
 * decision, and aliasing is Phase 7.
 */
function renderReferenceChip(line: Line): HTMLElement {
  const target = referenceTarget(line.entry.token.$value) as string;
  const wrap = el("div");

  const chip = el("div", "ref-chip");
  chip.appendChild(el("span", undefined, "↗"));
  chip.appendChild(el("span", "grow", `{${target}}`));
  wrap.appendChild(chip);

  const exists = getModel().byPath.has(normalizePathKey(target));
  wrap.appendChild(
    el(
      "p",
      "empty",
      exists
        ? `Points at ${target}. Editing references lands in Phase 7 — for now, change the token it points at.`
        : `Points at ${target}, which isn't in any set.`
    )
  );

  if (exists) {
    const go = button("Go to target");
    go.addEventListener("click", () => {
      closeDetail();
      navigate(target);
    });
    wrap.appendChild(go);
  }
  return wrap;
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
  const current = String(line.entry.token.$value);
  const wrap = el("div");

  const row = el("div", "field");
  row.appendChild(el("label", undefined, "Hex"));

  const text = committingInput(current, (raw) => {
    const parsed = parseHexColor(raw);
    if (!parsed.ok) return parsed.message;
    return editValue(line, parsed.value);
  });
  text.field.style.flex = "1";
  row.appendChild(text.field);

  // The hex field is the source of truth; the native picker is a convenience that writes into it.
  // 8-digit hex has no `<input type=color>` representation, so alpha is typed, never picked.
  const picker = el("input") as HTMLInputElement;
  picker.type = "color";
  picker.value = current.length >= 7 ? current.slice(0, 7) : "#000000";
  picker.className = "unit";
  picker.addEventListener("change", () => {
    const alpha = current.length === 9 ? current.slice(7) : "";
    const parsed = parseHexColor(picker.value + alpha);
    if (!parsed.ok) return;
    const error = editValue(line, parsed.value);
    if (error !== null) toast(error);
  });
  row.appendChild(picker);

  wrap.appendChild(row);
  return wrap;
}

function numberEditor(line: Line): HTMLElement {
  const extension = line.entry.token.$extensions?.["com.tokenvault"];
  const field = committingInput(String(line.entry.token.$value), (raw) => {
    const parsed = parseNumberValue(raw);
    if (!parsed.ok) return parsed.message;
    const error = editValue(line, parsed.value);
    if (error !== null) return error;
    // A warning, not a rejection: the value is committed and the note explains itself (§8).
    return subtypeWarning(extension?.subtype, parsed.value);
  });
  return fieldRow("Value", field.field);
}

function booleanEditor(line: Line): HTMLElement {
  const wrap = el("div", "toolbar");
  for (const value of [true, false]) {
    const control = button(String(value), line.entry.token.$value === value ? "primary" : undefined);
    control.addEventListener("click", () => {
      const error = editValue(line, value);
      if (error !== null) toast(error);
    });
    wrap.appendChild(control);
  }
  return fieldRow("Value", wrap);
}

function stringEditor(line: Line): HTMLElement {
  const field = committingInput(String(line.entry.token.$value), (raw) => {
    const parsed = parseStringValue(raw);
    if (!parsed.ok) return parsed.message;
    return editValue(line, parsed.value);
  });
  return fieldRow("Value", field.field);
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

function typographyEditor(line: Line): HTMLElement {
  const value = line.entry.token.$value as TypographyValue;
  const wrap = el("div");

  const apply = (field: TypographyField, raw: string, unit?: DimensionValue["unit"]): string | null => {
    const parsed = setTypographyField(value, field, raw, unit);
    if (!parsed.ok) return parsed.message;
    return editValue(line, parsed.value);
  };

  wrap.appendChild(
    fieldRow("Font family", committingInput(value.fontFamily, (raw) => apply("fontFamily", raw)).field)
  );
  wrap.appendChild(
    fieldRow("Weight", committingInput(String(value.fontWeight), (raw) => apply("fontWeight", raw)).field)
  );

  for (const field of ["fontSize", "letterSpacing"] as const) {
    const row = el("div", "field");
    row.appendChild(el("label", undefined, field === "fontSize" ? "Font size" : "Letter spacing"));
    const input = committingInput(formatDimension(value[field]), (raw) => apply(field, raw));
    input.field.style.flex = "1";
    row.appendChild(input.field);
    row.appendChild(
      unitSelect(dimensionUnit(value[field]), (unit) => apply(field, formatDimension(value[field]), unit))
    );
    wrap.appendChild(row);
  }

  // Three states, not two (ADR-0003 §3): a number, a dimension, or absent when Figma said Auto.
  // "Auto" removes the key rather than writing a sentinel, so a round-trip stays byte-identical.
  const lineRow = el("div", "field");
  lineRow.appendChild(el("label", undefined, "Line height"));
  const lineInput = committingInput(formatDimension(value.lineHeight), (raw) => apply("lineHeight", raw));
  lineInput.field.style.flex = "1";
  lineRow.appendChild(lineInput.field);
  if (value.lineHeight === undefined) {
    lineInput.input.placeholder = "Auto";
  } else {
    lineRow.appendChild(
      unitSelect(dimensionUnit(value.lineHeight), (unit) =>
        apply("lineHeight", formatDimension(value.lineHeight), unit)
      )
    );
    const auto = button("Auto");
    auto.title = "Remove lineHeight — Figma's Auto has no token equivalent";
    auto.addEventListener("click", () => {
      const error = editValue(line, clearLineHeight(value));
      if (error !== null) toast(error);
    });
    lineRow.appendChild(auto);
  }
  wrap.appendChild(lineRow);

  return wrap;
}

function shadowEditor(line: Line): HTMLElement {
  const list = shadowList(line.entry.token.$value);
  const wrap = el("div");

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

    for (const field of ["offsetX", "offsetY", "blur", "spread"] as const) {
      box.appendChild(fieldRow(field, committingInput(formatDimension(shadow[field]), (raw) => apply(field, raw)).field));
    }
    box.appendChild(fieldRow("color", committingInput(shadow.color, (raw) => apply("color", raw)).field));

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
      const input = committingInput(raw, (typed) => apply(field, typed));
      input.input.placeholder = "empty = absent";
      box.appendChild(fieldRow(field, input.field));
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
    section.appendChild(
      deleteButton(row.lines, {
        action: `Delete from all ${row.lines.length} sets`,
        subject: `${row.row.path} from all ${row.lines.length} sets`,
      })
    );
  }
  return section;
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
 * Each entry navigates to that token. There is deliberately no "remove all references" button:
 * that is reference surgery, which Phase 4 cannot do, and a token deep in the alias graph may
 * simply be undeletable until Phase 7. The panel says that in as many words rather than dangling
 * an affordance that doesn't exist.
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
      "Phase 4 can't edit a reference, so the only way to clear these is to delete the referencing tokens first — deepest first, since they may have references of their own. Repointing them lands with aliasing (Phase 7)."
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
