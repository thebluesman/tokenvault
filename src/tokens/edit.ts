// Value parsing, validation and construction for the local editor — UX local-editor §5.2, §8.
//
// Pure and Figma-free by design (UX §11): everything here runs identically in the plugin
// controller and in the UI iframe, and every rule in §5.2's table is a function in this file
// rather than a check scattered through DOM handlers.
//
// The recurring constraint is that the importer's output shape is load-bearing and must not drift
// under an edit. Absent keys stay absent (`lineHeight: AUTO`, a grid's `count`), a single shadow
// stays a bare object, and `$extensions` is never rebuilt — see `withValue` below.

import type {
  DimensionValue,
  GridValue,
  Referable,
  ShadowValue,
  Subtype,
  Token,
  TokenValue,
  TypographyValue,
} from "./types";
import { isReference } from "./references";
import type { MemberAccepts } from "./members";
import {
  gridMemberSpec,
  memberShape,
  refuseSubKeyReference,
  shadowMemberSpec,
  typographyMemberSpec,
} from "./members";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail<T>(message: string): ParseResult<T> {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Normalises a typed hex colour to the form the importer emits (`rgbaToHex`).
 *
 * Lowercase, `#`-prefixed, 6 digits — or 8 when there is real alpha. Shorthand is expanded and a
 * fully opaque 8-digit value is trimmed to 6, so retyping `#C33A2EFF` over an imported `#c33a2e`
 * produces no diff rather than a cosmetic one.
 */
export function parseHexColor(input: string): ParseResult<string> {
  const trimmed = input.trim();
  const match = HEX.exec(trimmed);
  if (match === null) return fail("Not a hex colour. Use #RRGGBB or #RRGGBBAA.");

  let digits = match[1].toLowerCase();
  if (digits.length === 3 || digits.length === 4) {
    digits = digits
      .split("")
      .map((digit) => digit + digit)
      .join("");
  }
  if (digits.length === 8 && digits.slice(6) === "ff") digits = digits.slice(0, 6);
  return ok(`#${digits}`);
}

export function parseNumberValue(input: string): ParseResult<number> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return fail("Enter a number.");
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fail(`"${trimmed}" is not a number.`);
  return ok(value);
}

export function parseStringValue(input: string): ParseResult<string> {
  if (input.trim().length === 0) return fail("Can't be empty.");
  return ok(input);
}

/**
 * A value that is legal but probably not what was meant (UX §8: amber note, **value committed**).
 *
 * Deliberately a warning and not a rejection. An opacity of 4 is almost certainly a mistake, but
 * the subtype is frequently a guess the importer made (`subtypeSource: "default"`), and refusing
 * the value would mean the guess outranked the human.
 */
export function subtypeWarning(subtype: Subtype | undefined, value: number): string | null {
  if (subtype === "opacity" && (value < 0 || value > 1)) {
    return `Opacity is usually 0–1. Saved as ${value}.`;
  }
  if ((subtype === "radius" || subtype === "sizing" || subtype === "duration") && value < 0) {
    return `${subtype} is not usually negative. Saved as ${value}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * A member that was handed a pointer or a formula it may keep, stored **verbatim**.
 *
 * UX §14.1: a composite member is an ordinary Phase 7 value field, so the string is the value here
 * exactly as it is for a whole token (ADR-0007 §2). Nothing evaluates on the way in and nothing is
 * normalised — `resolve.ts` answers what it comes out as, every time it is asked.
 *
 * The four authoring rules do **not** run here. They run in `checkAuthoredValue` before the overlay
 * entry is written, which is the same order the scalar field uses; this function is the store.
 */
export function memberPointer(
  input: string,
  accepts: MemberAccepts
): { kept: true; value: string } | { kept: false } {
  const trimmed = input.trim();
  if (memberShape(accepts, trimmed) === "literal") return { kept: false };
  return { kept: true, value: trimmed };
}

export function parseDimension(
  input: string,
  unit: DimensionValue["unit"],
  accepts: MemberAccepts = "full"
): ParseResult<DimensionValue | string> {
  const pointer = memberPointer(input, accepts);
  if (pointer.kept) return ok(pointer.value);
  const parsed = parseNumberValue(input);
  if (!parsed.ok) return parsed;
  return ok({ unit, value: parsed.value });
}

/**
 * What the member's field shows.
 *
 * A pointer or a formula shows as itself — that is what the file holds, and §14.1's whole premise is
 * that the field the user types a path into is the field that shows the path back.
 */
export function formatDimension(value: Referable<DimensionValue | number> | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return String(value.value);
}

export function dimensionUnit(
  value: Referable<DimensionValue | number> | undefined
): DimensionValue["unit"] {
  if (value === undefined || typeof value === "number" || typeof value === "string") return "px";
  return value.unit;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export type TypographyField = "fontFamily" | "fontSize" | "fontWeight" | "letterSpacing" | "lineHeight";

/**
 * Edits one typography field, leaving every other key exactly as imported.
 *
 * `lineHeight` has three states, not two (ADR-0003 §3): a number, a dimension, or **absent** when
 * Figma's line height was `Auto`. There is no sentinel to write, so "Auto" removes the key —
 * which is why this returns a whole value rather than patching a field in place.
 */
export function setTypographyField(
  value: TypographyValue,
  field: TypographyField,
  raw: string,
  unit?: DimensionValue["unit"]
): ParseResult<TypographyValue> {
  const next: TypographyValue = { ...value };
  const accepts = typographyMemberSpec(field).accepts;

  if (field === "fontFamily") {
    const pointer = memberPointer(raw, accepts);
    if (pointer.kept) {
      next.fontFamily = pointer.value;
      return ok(next);
    }
    const parsed = parseStringValue(raw);
    if (!parsed.ok) return parsed;
    next.fontFamily = parsed.value;
    return ok(next);
  }

  if (field === "fontWeight") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return fail("Can't be empty.");
    const pointer = memberPointer(raw, accepts);
    if (pointer.kept) {
      next.fontWeight = pointer.value;
      return ok(next);
    }
    // `number | string` on purpose: ADR-0003 §3 keeps Figma's raw style name when the keyword
    // table has no numeric entry, and retyping it must not coerce "Black Italic" to NaN.
    const numeric = Number(trimmed);
    next.fontWeight = Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(trimmed) ? numeric : trimmed;
    return ok(next);
  }

  if (field === "lineHeight") {
    if (raw.trim().length === 0) {
      delete next.lineHeight;
      return ok(next);
    }
    const parsed = parseDimension(raw, unit ?? dimensionUnit(value.lineHeight), accepts);
    if (!parsed.ok) return parsed;
    next.lineHeight = parsed.value;
    return ok(next);
  }

  const parsed = parseDimension(raw, unit ?? dimensionUnit(value[field]), accepts);
  if (!parsed.ok) return parsed;
  next[field] = parsed.value;
  return ok(next);
}

/** "Auto" — removes `lineHeight` entirely rather than writing a zero (UX §5.2). */
export function clearLineHeight(value: TypographyValue): TypographyValue {
  const next: TypographyValue = { ...value };
  delete next.lineHeight;
  return next;
}

// ---------------------------------------------------------------------------
// Shadow
// ---------------------------------------------------------------------------

/** A shadow `$value` is a single object *or* an array; the editor works on the list either way. */
export function shadowList(value: TokenValue): ShadowValue[] {
  if (Array.isArray(value)) return (value as ShadowValue[]).slice();
  if (value !== null && typeof value === "object") return [value as ShadowValue];
  return [];
}

/**
 * Back to `$value` shape: a bare object for one shadow, an array for more.
 *
 * Matches what the importer emits, so editing an unrelated field of a single-shadow style does
 * not silently promote it to a one-element array — which changes the bytes and shows up as a
 * spurious diff at Phase 6 (UX §5.2).
 */
export function denormalizeShadows(list: ShadowValue[]): TokenValue {
  return list.length === 1 ? list[0] : (list.slice() as ShadowValue[]);
}

export type ShadowField = "offsetX" | "offsetY" | "blur" | "spread" | "color" | "inset";

export function setShadowField(
  shadow: ShadowValue,
  field: ShadowField,
  raw: string
): ParseResult<ShadowValue> {
  const next: ShadowValue = { ...shadow };

  const accepts = shadowMemberSpec(field).accepts;

  if (field === "inset") {
    // §14.2: a two-state segmented control with nowhere to type, so a pointer is refused by name
    // rather than silently written as the string `"{a.b}" === "true"` would make of it.
    const refusal = refuseSubKeyReference(field, accepts, raw);
    if (refusal !== null) return fail(refusal);
    next.inset = raw === "true";
    return ok(next);
  }
  if (field === "color") {
    // §14.2 — exactly §4.1's colour rule, one level down: a pointer is stored verbatim and the
    // swatch shows what it resolves to, at full opacity like a literal (issue #28).
    const pointer = memberPointer(raw, accepts);
    if (pointer.kept) {
      next.color = pointer.value;
      return ok(next);
    }
    const parsed = parseHexColor(raw);
    if (!parsed.ok) return parsed;
    next.color = parsed.value;
    return ok(next);
  }

  const parsed = parseDimension(raw, dimensionUnit(shadow[field]), accepts);
  if (!parsed.ok) return parsed;
  next[field] = parsed.value;
  return ok(next);
}

export function newShadow(): ShadowValue {
  return {
    blur: { unit: "px", value: 0 },
    color: "#00000040",
    inset: false,
    offsetX: { unit: "px", value: 0 },
    offsetY: { unit: "px", value: 0 },
    spread: { unit: "px", value: 0 },
  };
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export function gridList(value: TokenValue): GridValue[] {
  return Array.isArray(value) ? (value as GridValue[]).slice() : [];
}

export type GridField = "alignment" | "count" | "gutter" | "offset" | "sectionSize";

/** Which keys a pattern may carry. Anything else is removed, not zeroed (ADR-0003 §3). */
const GRID_FIELDS: Record<GridValue["pattern"], GridField[]> = {
  columns: ["alignment", "count", "gutter", "offset"],
  rows: ["alignment", "count", "gutter", "offset"],
  grid: ["sectionSize"],
};

export function gridFieldsFor(pattern: GridValue["pattern"]): GridField[] {
  return GRID_FIELDS[pattern];
}

export function setGridField(grid: GridValue, field: GridField, raw: string): ParseResult<GridValue> {
  const next: GridValue = { ...grid };
  if (gridFieldsFor(grid.pattern).indexOf(field) === -1) {
    return fail(`A ${grid.pattern} grid has no ${field}.`);
  }

  if (raw.trim().length === 0) {
    delete next[field];
    return ok(next);
  }

  const accepts = gridMemberSpec(field).accepts;

  if (field === "alignment") {
    // Literal-only for the same family of reason as `pattern` (§14.2): it names one of Figma's own
    // enum values, and a `{…}` accepted here would become a graph edge nothing downstream can honour.
    const refusal = refuseSubKeyReference(field, accepts, raw);
    if (refusal !== null) return fail(refusal);
    next.alignment = raw;
    return ok(next);
  }
  if (field === "count") {
    const pointer = memberPointer(raw, accepts);
    if (pointer.kept) {
      next.count = pointer.value;
      return ok(next);
    }
    const parsed = parseNumberValue(raw);
    if (!parsed.ok) return parsed;
    next.count = parsed.value;
    return ok(next);
  }

  const parsed = parseDimension(raw, dimensionUnit(grid[field]), accepts);
  if (!parsed.ok) return parsed;
  next[field] = parsed.value;
  return ok(next);
}

/**
 * Switching pattern drops the keys the new pattern has no place for (UX §5.2).
 *
 * Removed, not zeroed: `count: 0` on a `grid` pattern is a value the importer would never write,
 * and it would round-trip into Figma as a real (wrong) setting.
 */
export function setGridPattern(grid: GridValue, pattern: GridValue["pattern"]): GridValue {
  const allowed = gridFieldsFor(pattern);
  const next: GridValue = { pattern };
  for (const field of allowed) {
    const existing = grid[field];
    if (existing !== undefined) {
      // Assigning through a union of value types needs the widening; the key set is already
      // constrained to what this pattern allows.
      (next as unknown as Record<string, unknown>)[field] = existing;
    }
  }
  return next;
}

export function newGrid(): GridValue {
  return { pattern: "columns", alignment: "STRETCH", count: 12, gutter: { unit: "px", value: 16 } };
}

// ---------------------------------------------------------------------------
// Writing back into a token
// ---------------------------------------------------------------------------

/**
 * A token with a new `$value`, carrying `$extensions` **by reference**.
 *
 * The single most important line in the editor (UX §11). `$extensions."com.tokenvault"` is the
 * re-import matching key and the round-trip carrier for everything DTCG has no home for; an
 * editor that rebuilt it from a form would break ADR-0002 §7's byte-identical guarantee in the
 * quietest way available.
 */
export function withValue(token: Token, value: TokenValue): Token {
  return { ...token, $value: value };
}

/** An empty description removes the key rather than writing `""`, which the importer never emits. */
export function withDescription(token: Token, description: string): Token {
  const next: Token = { ...token };
  if (description.trim().length === 0) delete next.$description;
  else next.$description = description;
  return next;
}

/**
 * True when this token's whole value is a pointer rather than a literal.
 *
 * **No longer a read-only test.** Phase 4 used it to refuse editing a reference outright
 * (`local-editor.md` §5.3); Phase 7 lifts that, exactly as that section said it would, so what is
 * left is the shape question the per-type editors still need — a colour whose value is a pointer
 * gets an inert swatch, a boolean gets a readout position (UX §4.1).
 */
export function isPointerValue(token: Token): boolean {
  return isReference(token.$value);
}
