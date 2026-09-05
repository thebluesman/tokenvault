// One-line value previews for the merged tree — UX local-editor §4.5.
//
// Pure, and separate from the DOM, because the preview is a data question ("what does this token
// say, in the width of a row?") that the tests can hold to account, not a rendering one. The UI
// decides what a swatch looks like; this decides what text sits next to it.

import type {
  GridValue,
  Referable,
  ShadowValue,
  Token,
  TokenValue,
  TypographyValue,
} from "./types";
import { isReference, referenceTarget } from "./references";
import { hasNonLiteralMember } from "./members";

export interface Preview {
  /** The text the row shows. */
  text: string;
  /** A colour to paint a swatch with, when the value resolves to a literal colour. */
  swatch?: string;
  /**
   * Set when the value is a reference. The row renders the swatch as an outline rather than a
   * fill and adds the `↗` glyph: Phase 4 cannot resolve a reference, and a filled swatch would
   * claim it had (§4.5).
   */
  reference?: string;
  /**
   * Set when a *composite* has at least one member that points or computes — UX §14.5.
   *
   * The preview stays the resolved summary (`Urbanist 20/24 · 500`) and gains a trailing `↗`, which
   * is a deliberate divergence from §6.3's "show the string" rule for scalars: a typography token
   * with three referenced members has a `$value` around 140 characters, which is four wrapped lines
   * of left-truncated paths in a 460 px column where the designer wanted to know which font it is.
   * A scalar's string *is* its whole value; a composite's isn't. The full strings are one tap away
   * in the overlay, which is where composites have always been edited.
   */
  memberPointer?: boolean;
}

/**
 * Truncates a dotted path **from the left**.
 *
 * `{folio.ref.palette.transparent.red-warm.50.30}` is 45 characters and the row has room for
 * about 24. The tail is the half that carries the meaning — the leading `folio.ref.palette` is
 * shared by hundreds of tokens — so the ellipsis goes at the front (§4.5).
 */
export function truncateReference(path: string, max = 24): string {
  if (path.length <= max) return path;
  const segments = path.split(".");
  let tail = segments[segments.length - 1];
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const candidate = `${segments[i]}.${tail}`;
    if (candidate.length + 1 > max) break;
    tail = candidate;
  }
  return `…${tail}`;
}

/**
 * The row's text, and the marks beside it.
 *
 * `resolved` is the token's value with every member that resolves already substituted — the
 * `composite` resolution from `resolve.ts`. Passing it is what turns `Urbanist {…size.l}/24` into
 * `Urbanist 20/24`; leaving it out renders the raw file, which is what a caller with no resolution
 * context (a diff, a fixture) actually wants.
 */
export function previewOf(token: Token, resolved?: TokenValue): Preview {
  const reference = referenceTarget(token.$value);
  if (reference !== null) {
    return { text: `{${truncateReference(reference)}}`, reference };
  }

  const value = resolved ?? token.$value;
  const memberPointer = hasNonLiteralMember(token) ? true : undefined;

  switch (token.$type) {
    case "typography":
      return { text: previewTypography(value as TypographyValue), memberPointer };
    case "shadow":
      return { text: previewShadow(value), memberPointer };
    case "grid":
      return { text: previewGrid(value), memberPointer };
  }

  switch (token.$type) {
    case "color":
      return { text: String(token.$value), swatch: String(token.$value) };
    case "number":
      return { text: String(token.$value) };
    case "boolean":
      return { text: token.$value === true ? "true" : "false" };
    case "string":
      return { text: `"${truncate(String(token.$value), 28)}"` };
    default:
      return { text: String(token.$value) };
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `Urbanist 20/24 · 500` — compressed to just enough to tell two styles apart (§4.5). */
function previewTypography(value: TypographyValue): string {
  if (value === null || typeof value !== "object") return String(value);
  const size = dimension(value.fontSize);
  const line = value.lineHeight === undefined ? "auto" : dimension(value.lineHeight);
  return `${slot(value.fontFamily)} ${size}/${line} · ${slot(value.fontWeight)}`;
}

/** A single shadow reads as its geometry; a stack reads as a count — the row has no room for both. */
function previewShadow(value: TokenValue): string {
  if (Array.isArray(value)) {
    const shadows = value as ShadowValue[];
    if (shadows.length === 1) return oneShadow(shadows[0]);
    return `${shadows.length} shadows`;
  }
  if (value !== null && typeof value === "object") return oneShadow(value as ShadowValue);
  return String(value);
}

function oneShadow(shadow: ShadowValue): string {
  const parts = [
    dimension(shadow.offsetX),
    dimension(shadow.offsetY),
    dimension(shadow.blur),
    slot(shadow.color),
  ];
  return `${shadow.inset ? "inset " : ""}${parts.join(" ")}`;
}

/** `columns · 4 · 8px` (§4.5). */
function previewGrid(value: TokenValue): string {
  if (!Array.isArray(value)) return String(value);
  const grids = value as GridValue[];
  if (grids.length === 0) return "no grids";
  if (grids.length > 1) return `${grids.length} grids`;
  const grid = grids[0];
  const parts: string[] = [grid.pattern];
  if (grid.count !== undefined) parts.push(dimension(grid.count));
  if (grid.gutter !== undefined) parts.push(`${dimension(grid.gutter)}px`);
  if (grid.sectionSize !== undefined) parts.push(`${dimension(grid.sectionSize)}px`);
  return parts.join(" · ");
}

/**
 * One member's slot in the summary.
 *
 * **A member with no value renders `—`, never a zero and never the last good number** (UX §14.6,
 * ADR-0007 §3). After substitution the only string left in a numeric slot is one that did not
 * resolve — a loop, or a target this theme has no value for — so the em dash is exactly the set of
 * cases §7.1 forbids inventing a number for. The slot is never collapsed either: `Urbanist —/24`
 * says a size is missing, where dropping it would read as `Urbanist 24`.
 */
function dimension(value: Referable<{ value: number; unit: string } | number> | undefined): string {
  if (value === undefined) return "–";
  if (typeof value === "string") return "—";
  return typeof value === "number" ? String(value) : String(value.value);
}

/** The same rule for a member whose literal is itself a string — a font family, a shadow colour. */
function slot(value: unknown): string {
  if (typeof value === "string") {
    // A brace is enough: after substitution the only member string still carrying one is a pointer
    // or a formula that did not resolve, and `isReference` is asked second only to keep the anchored
    // definition in one place.
    if (value.indexOf("{") !== -1 || isReference(value)) return "—";
  }
  return String(value);
}
