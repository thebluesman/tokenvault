// Composite members, and which of them can point at a token — UX references-math-themes §14.
//
// Issue #26 widens Phase 7's *one field, three shapes* rule one level deeper: a typography token's
// `fontSize` is an ordinary value field, and the parser classifies what was typed into it after the
// fact, exactly as §4.1 already does for a whole token. Nothing about the picker changes.
//
// Two boundaries this module is the keeper of, both from §14:
//
//   1. **A reference points AT a token, never INTO one** (§14.3). There are no path-index entries
//      for members here and there must never be: `{folio.type.heading.fontSize}` is not a path, and
//      the symmetric feature — addressable sub-keys as reference *targets* — is a different ticket
//      that starts by amending ADR-0002 §5's path normalisation.
//   2. **Two members refuse outright** (§14.2). Grid `pattern` chooses which other keys the object
//      has, so a reference there would make one token's key set depend on another token's value;
//      shadow `inset` is a two-state control with nowhere to type. `alignment` is refused for the
//      same family of reason as `pattern` — it is an enum Figma names, not a value with a token
//      behind it — and refusing it is what stops a `{…}` typed there becoming a graph edge nothing
//      downstream can honour.
//
// Everything here is pure and shape-driven: the table below *is* the spec's table, and every other
// module (the editor, the graph, the resolver, the apply write, the export) asks this one rather
// than re-deriving which members take what.

import type { GridValue, ShadowValue, Token, TokenValue, TypographyValue } from "./types";
import { isReference } from "./references";
import { looksLikeExpression } from "./expr";

/** What a member's field will take, per §14.2. */
export type MemberAccepts =
  /** literal · reference · expression — every numeric member. */
  | "full"
  /** literal · reference. `fontFamily`, `fontWeight`, a shadow's `color`. */
  | "reference"
  /** literal only, and a `{…}` is refused by name. `pattern`, `inset`, `alignment`. */
  | "literal";

/**
 * The member's *own* type, which is what rule 2 compares against (§14.9) — never the composite's
 * `$type`, which would be true and useless ("this token is a typography").
 */
export type MemberType = "number" | "string" | "color" | "number-or-string";

export interface MemberSlot {
  /** Where the member sits inside `$value`, for reading and for writing a resolved value back. */
  keyPath: Array<string | number>;
  /** The member key, as the copy names it: `fontSize`, `blur`, `pattern`. */
  key: string;
  /** The key, disambiguated when the composite holds a list: `blur (shadow 2)`. */
  label: string;
  type: MemberType;
  accepts: MemberAccepts;
  /** Whatever is stored there right now. */
  value: unknown;
}

interface SlotSpec {
  type: MemberType;
  accepts: MemberAccepts;
}

const TYPOGRAPHY: Record<string, SlotSpec> = {
  fontFamily: { type: "string", accepts: "reference" },
  fontSize: { type: "number", accepts: "full" },
  fontWeight: { type: "number-or-string", accepts: "reference" },
  letterSpacing: { type: "number", accepts: "full" },
  lineHeight: { type: "number", accepts: "full" },
};

const SHADOW: Record<string, SlotSpec> = {
  offsetX: { type: "number", accepts: "full" },
  offsetY: { type: "number", accepts: "full" },
  blur: { type: "number", accepts: "full" },
  spread: { type: "number", accepts: "full" },
  color: { type: "color", accepts: "reference" },
  inset: { type: "string", accepts: "literal" },
};

const GRID: Record<string, SlotSpec> = {
  pattern: { type: "string", accepts: "literal" },
  alignment: { type: "string", accepts: "literal" },
  count: { type: "number", accepts: "full" },
  gutter: { type: "number", accepts: "full" },
  offset: { type: "number", accepts: "full" },
  sectionSize: { type: "number", accepts: "full" },
};

/** True when this token's value is a composite object rather than a scalar or a whole reference. */
export function isCompositeValue(value: TokenValue | undefined): boolean {
  return value !== null && value !== undefined && typeof value === "object";
}

/**
 * Every member of a composite token, in declaration order.
 *
 * A key the value does not carry produces no slot: an absent `lineHeight` is Figma's `AUTO`
 * (ADR-0003 §3) and has no field to type into, and inventing one here would be the first half of
 * writing a default into a gap the import deliberately left.
 */
export function memberSlots(token: Pick<Token, "$type" | "$value">): MemberSlot[] {
  const value = token.$value;
  if (!isCompositeValue(value)) return [];

  if (token.$type === "typography") {
    return slotsFor(value as unknown as Record<string, unknown>, TYPOGRAPHY, [], "");
  }

  if (token.$type === "shadow") {
    const list = Array.isArray(value) ? (value as ShadowValue[]) : [value as ShadowValue];
    const many = Array.isArray(value) && list.length > 1;
    const slots: MemberSlot[] = [];
    list.forEach((shadow, index) => {
      const prefix: Array<string | number> = Array.isArray(value) ? [index] : [];
      const suffix = many ? ` (shadow ${index + 1})` : "";
      slots.push(...slotsFor(shadow as unknown as Record<string, unknown>, SHADOW, prefix, suffix));
    });
    return slots;
  }

  if (token.$type === "grid") {
    if (!Array.isArray(value)) return [];
    const list = value as GridValue[];
    const many = list.length > 1;
    const slots: MemberSlot[] = [];
    list.forEach((grid, index) => {
      const suffix = many ? ` (grid ${index + 1})` : "";
      slots.push(...slotsFor(grid as unknown as Record<string, unknown>, GRID, [index], suffix));
    });
    return slots;
  }

  return [];
}

function slotsFor(
  holder: Record<string, unknown>,
  table: Record<string, SlotSpec>,
  prefix: Array<string | number>,
  suffix: string
): MemberSlot[] {
  const slots: MemberSlot[] = [];
  for (const key of Object.keys(table)) {
    if (!Object.prototype.hasOwnProperty.call(holder, key)) continue;
    const spec = table[key];
    slots.push({
      keyPath: prefix.concat([key]),
      key,
      label: `${key}${suffix}`,
      type: spec.type,
      accepts: spec.accepts,
      value: holder[key],
    });
  }
  return slots;
}

/** The spec for one member, addressed the way an editor addresses it. */
export function memberSpec(
  type: Token["$type"],
  key: string
): { type: MemberType; accepts: MemberAccepts } | null {
  const table = type === "typography" ? TYPOGRAPHY : type === "shadow" ? SHADOW : type === "grid" ? GRID : null;
  if (table === null) return null;
  const spec = table[key];
  return spec === undefined ? null : { type: spec.type, accepts: spec.accepts };
}

// ---------------------------------------------------------------------------
// Classifying what a member holds
// ---------------------------------------------------------------------------

export type MemberShape = "literal" | "reference" | "expression";

/**
 * Which of the three shapes a member's stored value is — the same question `valueShape` asks of a
 * whole token, asked of one slot, and asked of the **grammar** rather than of a second regex.
 *
 * A member that does not accept expressions never has one: `"Semi Bold"` on `fontWeight` and
 * `"#c33a2e"` on a shadow colour are literals however they lex, and running them past the tokenizer
 * would be a way to invent an error out of a perfectly ordinary value.
 */
export function memberShape(accepts: MemberAccepts, value: unknown): MemberShape {
  if (typeof value !== "string") return "literal";
  if (isReference(value)) return "reference";
  if (accepts !== "full") return "literal";
  return looksLikeExpression(value) ? "expression" : "literal";
}

/** The members of this token that hold a pointer or a formula rather than a value. */
export function nonLiteralMembers(token: Pick<Token, "$type" | "$value">): MemberSlot[] {
  return memberSlots(token).filter((slot) => memberShape(slot.accepts, slot.value) !== "literal");
}

/** True when any member holds a pointer or a formula — §14.5's trailing `↗` on the tree preview. */
export function hasNonLiteralMember(token: Pick<Token, "$type" | "$value">): boolean {
  return nonLiteralMembers(token).length > 0;
}

/** A stable key for one slot, so a caller can look a member's resolution up by address. */
export function memberKey(keyPath: Array<string | number>): string {
  return keyPath.join(".");
}

// ---------------------------------------------------------------------------
// Refusing the two members that take a value directly — §14.2
// ---------------------------------------------------------------------------

/**
 * The narrowed `refuseSubKeyReference` (§14.2, §14.9).
 *
 * Phase 7's helper refused a reference in *every* composite member. It does not disappear — it
 * narrows to the members that select the object's own shape, with copy that names what it is
 * refusing rather than reporting a version limitation that no longer exists.
 */
export function refuseSubKeyReference(key: string, accepts: MemberAccepts, raw: string): string | null {
  if (accepts !== "literal") return null;
  if (!isReference(raw.trim())) return null;

  if (key === "pattern") {
    return "`pattern` can't point at another token. It decides which fields this grid has, so it takes a value directly.";
  }
  if (key === "inset") {
    return "`inset` can't point at another token — it's a drop/inset switch, so it takes a value directly.";
  }
  return `\`${key}\` can't point at another token. It takes a value directly.`;
}

// ---------------------------------------------------------------------------
// Writing a member back
// ---------------------------------------------------------------------------

/**
 * A copy of `value` with one member replaced.
 *
 * Structural rather than in-place: the effective tree is shared with the overlay and the imported
 * snapshot, and mutating a composite through it would change what a drift check thinks Figma said.
 * Only the objects along `keyPath` are cloned, so the rest keeps its identity and its bytes.
 */
export function withMemberValue(
  value: TokenValue,
  keyPath: Array<string | number>,
  replacement: unknown
): TokenValue {
  return write(value as unknown, keyPath, replacement) as TokenValue;
}

function write(node: unknown, keyPath: Array<string | number>, replacement: unknown): unknown {
  if (keyPath.length === 0) return replacement;
  const [head, ...rest] = keyPath;

  if (Array.isArray(node)) {
    const copy = node.slice();
    const index = Number(head);
    copy[index] = write(copy[index], rest, replacement);
    return copy;
  }
  if (node === null || typeof node !== "object") return node;

  const copy: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  copy[String(head)] = write(copy[String(head)], rest, replacement);
  return copy;
}

/** The value at a member address, or `undefined`. */
export function memberValueAt(value: TokenValue | undefined, keyPath: Array<string | number>): unknown {
  let node: unknown = value;
  for (const step of keyPath) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[String(step)];
  }
  return node;
}

/** Typed helpers the per-type editors use, so they don't each re-derive the table. */
export function typographyMemberSpec(key: keyof TypographyValue): { type: MemberType; accepts: MemberAccepts } {
  return TYPOGRAPHY[key as string];
}

export function shadowMemberSpec(key: keyof ShadowValue): { type: MemberType; accepts: MemberAccepts } {
  return SHADOW[key as string];
}

export function gridMemberSpec(key: string): { type: MemberType; accepts: MemberAccepts } {
  return GRID[key];
}
