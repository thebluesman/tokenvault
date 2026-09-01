// One-line value previews for the merged tree — UX local-editor §4.5.
//
// Pure, and separate from the DOM, because the preview is a data question ("what does this token
// say, in the width of a row?") that the tests can hold to account, not a rendering one. The UI
// decides what a swatch looks like; this decides what text sits next to it.

import type { GridValue, ShadowValue, Token, TokenValue, TypographyValue } from "./types";
import { referenceTarget } from "./references";

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

export function previewOf(token: Token): Preview {
  const reference = referenceTarget(token.$value);
  if (reference !== null) {
    return { text: `{${truncateReference(reference)}}`, reference };
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
    case "typography":
      return { text: previewTypography(token.$value as TypographyValue) };
    case "shadow":
      return { text: previewShadow(token.$value) };
    case "grid":
      return { text: previewGrid(token.$value) };
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
  return `${value.fontFamily} ${size}/${line} · ${String(value.fontWeight)}`;
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
    shadow.color,
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
  if (grid.count !== undefined) parts.push(String(grid.count));
  if (grid.gutter !== undefined) parts.push(`${dimension(grid.gutter)}px`);
  if (grid.sectionSize !== undefined) parts.push(`${dimension(grid.sectionSize)}px`);
  return parts.join(" · ");
}

function dimension(value: { value: number; unit: string } | number | undefined): string {
  if (value === undefined) return "–";
  return typeof value === "number" ? String(value) : String(value.value);
}
