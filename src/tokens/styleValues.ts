// Figma style → DTCG `$value` conversion — ADR-0003 §3.
//
// Pure, like src/tokens/values.ts: nothing here touches the `figma` global, and every function
// takes a plain-data snapshot. The one structural difference from the Variables side is that a
// style value can be *partly* mappable — an effect style of one shadow and one blur, a text
// style with `AUTO` line height — so these return the value alongside the sub-keys that were
// dropped, and the caller turns those into `partial-token` entries (ADR-0003 §6).

import type {
  DimensionValue,
  EffectSnapshot,
  EffectStyleSnapshot,
  GridStyleSnapshot,
  GridValue,
  LayoutGridSnapshot,
  PaintSnapshot,
  PaintStyleSnapshot,
  ShadowValue,
  TextStyleSnapshot,
  TypographyValue,
} from "./types";
import { normalizeFloat, rgbaToHex } from "./values";

/** A conversion that produced a value, possibly minus some sub-keys. */
export interface StyleValueOk<T> {
  ok: true;
  value: T;
  /**
   * Sub-values Figma carries that the token does not. Non-empty means `partial-token`: the token
   * is written, but a reader of the JSON alone would not know what was lost.
   */
  omitted: string[];
  /** One sentence naming what was dropped and why, for the report. Empty when nothing was. */
  note: string;
}

/** A conversion that produced nothing. `reason` is the `unmappable-value` reason (ADR-0003 §6). */
export interface StyleValueFailed {
  ok: false;
  reason: string;
  message: string;
}

export type StyleValueResult<T> = StyleValueOk<T> | StyleValueFailed;

function ok<T>(value: T, omitted: string[] = [], note = ""): StyleValueOk<T> {
  return { ok: true, value, omitted, note };
}

function failed(reason: string, message: string): StyleValueFailed {
  return { ok: false, reason, message };
}

export function px(value: number): DimensionValue {
  return { unit: "px", value: normalizeFloat(value) };
}

function em(value: number): DimensionValue {
  return { unit: "em", value: normalizeFloat(value) };
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/** Paint types that are neither SOLID nor a gradient. Grouped so the report says which. */
const IMAGE_PAINT_TYPES = ["IMAGE", "VIDEO", "PATTERN"];

export interface PaintResult {
  /** The paint that will become the token, once the caller decides alias vs. literal. */
  paint: PaintSnapshot;
  /** `#rrggbb`, or `#rrggbbaa` when the effective alpha is < 1. */
  hex: string;
}

/**
 * Picks the one solid paint a colour token can come from — ADR-0003 §3.
 *
 * Everything that is not exactly one visible SOLID paint is a reported non-import rather than a
 * guess. A gradient has a plausible landing zone in DTCG's draft `gradient` type, but choosing a
 * stop representation is its own decision, and a reported non-import is reversible where a wrong
 * shape baked into the source of truth is not.
 */
export function paintValue(style: PaintStyleSnapshot): StyleValueResult<PaintResult> {
  const visible = style.paints.filter((paint) => paint.visible);

  if (visible.length === 0) {
    return failed(
      "empty-paint",
      style.paints.length === 0
        ? "has no paints."
        : `has ${style.paints.length} paint${style.paints.length === 1 ? "" : "s"}, none of them visible.`
    );
  }

  if (visible.length > 1) {
    return failed(
      "multi-paint",
      `has ${visible.length} visible paints stacked, which a single colour token cannot represent.`
    );
  }

  const paint = visible[0];

  if (paint.type.indexOf("GRADIENT") === 0) {
    return failed(
      "gradient-paint",
      `is a ${paint.type.toLowerCase().replace(/_/g, " ")}, and DTCG's gradient type is still draft, so Phase 3 does not write one.`
    );
  }

  if (IMAGE_PAINT_TYPES.indexOf(paint.type) !== -1) {
    return failed("image-paint", `is an ${paint.type.toLowerCase()} fill, which is not a token value.`);
  }

  if (paint.type !== "SOLID" || paint.color === undefined) {
    return failed("unsupported-paint", `is a ${paint.type} paint, which the Phase 3 schema does not cover.`);
  }

  // Effective alpha is `paint.opacity × color.a` (ADR-0003 §3). Figma's SolidPaint.color is RGB
  // with no alpha of its own, but the snapshot type allows one, so both are honoured.
  const colorAlpha = paint.color.a === undefined ? 1 : paint.color.a;
  const hex = rgbaToHex({
    r: paint.color.r,
    g: paint.color.g,
    b: paint.color.b,
    a: colorAlpha * paint.opacity,
  });

  return ok({ paint, hex });
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Figma's free-text `fontName.style` → a DTCG 100–900 weight.
 *
 * Inherently incomplete (foundry-specific names, variable-font instances), which is why ADR-0003
 * fixes the behaviour on a miss — keep the string, flag it — rather than the table's contents.
 * The table can grow without an amendment. Slant is stripped before lookup because it is not a
 * weight; the raw string is kept verbatim at `figma.fontStyle` regardless, so nothing is lost.
 */
const FONT_WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  roman: 400,
  "": 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  demi: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
  extrablack: 950,
  ultrablack: 950,
};

const SLANT_WORDS = ["italic", "oblique"];

export interface FontWeightResult {
  weight: number | string;
  /** False when the keyword table had no entry and the raw string was kept instead. */
  mapped: boolean;
}

export function fontWeightOf(fontStyle: string): FontWeightResult {
  const words = fontStyle
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0 && SLANT_WORDS.indexOf(word) === -1);

  const key = words.join("");
  const weight = FONT_WEIGHTS[key];
  if (weight !== undefined) return { weight, mapped: true };

  // DTCG permits a string in `fontWeight`, so an unrecognised style is kept rather than guessed.
  return { weight: fontStyle, mapped: false };
}

export function typographyValue(style: TextStyleSnapshot): StyleValueResult<TypographyValue> {
  const omitted: string[] = [];
  const notes: string[] = [];

  const font = fontWeightOf(style.fontStyle);
  if (!font.mapped) {
    notes.push(
      `the font style "${style.fontStyle}" is not in the weight keyword table, so fontWeight kept the raw string instead of a 100–900 number`
    );
  }

  const value: TypographyValue = {
    fontFamily: style.fontFamily,
    fontSize: px(style.fontSize),
    fontWeight: font.weight,
    letterSpacing:
      // Figma's PERCENT letter spacing is a percentage *of font size*, which is exactly what
      // `em` means — so this is a change of notation, not a unit invention (ADR-0003 context).
      style.letterSpacing.unit === "PERCENT"
        ? em(style.letterSpacing.value / 100)
        : px(style.letterSpacing.value),
  };

  if (style.lineHeight.unit === "AUTO") {
    // Auto line height is a Figma layout behaviour, not a value: there is no number to write.
    omitted.push("lineHeight");
    notes.push("its line height is AUTO, which is a Figma layout behaviour rather than a value");
  } else if (style.lineHeight.value !== undefined) {
    value.lineHeight =
      style.lineHeight.unit === "PERCENT"
        ? // DTCG's multiplier form: 150% is 1.5.
          normalizeFloat(style.lineHeight.value / 100)
        : px(style.lineHeight.value);
  } else {
    omitted.push("lineHeight");
    notes.push(`its line height unit is ${style.lineHeight.unit} but Figma reported no value`);
  }

  return ok(value, omitted, notes.join("; "));
}

/**
 * Everything Figma carries that DTCG typography does not (ADR-0003 §3).
 *
 * Written verbatim under `figma.text` so import stays lossless and Phase 5 can hand a style back
 * to Figma unchanged, without the DTCG surface having to grow to make that possible.
 */
export function textExtras(style: TextStyleSnapshot): Record<string, string | number | boolean> {
  return {
    hangingList: style.hangingList,
    hangingPunctuation: style.hangingPunctuation,
    leadingTrim: style.leadingTrim,
    letterSpacingUnit: style.letterSpacing.unit,
    lineHeightUnit: style.lineHeight.unit,
    listSpacing: normalizeFloat(style.listSpacing),
    paragraphIndent: normalizeFloat(style.paragraphIndent),
    paragraphSpacing: normalizeFloat(style.paragraphSpacing),
    textCase: style.textCase,
    textDecoration: style.textDecoration,
    textWrapStyle: style.textWrapStyle,
  };
}

// ---------------------------------------------------------------------------
// Effect
// ---------------------------------------------------------------------------

const SHADOW_TYPES = ["DROP_SHADOW", "INNER_SHADOW"];

/**
 * ADR-0003 §3: one shadow object, or an array in source order when there are several.
 *
 * Invisible effects are skipped silently — a `visible: false` effect is off in Figma too, so
 * dropping it loses nothing. Blurs, noise, texture and anything Figma adds later have no DTCG
 * representation: a style made only of those is not written at all, while a style mixing them
 * with shadows writes the shadows and reports what was left out.
 */
export function shadowValue(
  style: EffectStyleSnapshot
): StyleValueResult<ShadowValue | ShadowValue[]> {
  const visible = style.effects.filter((effect) => effect.visible);
  const shadows = visible.filter((effect) => SHADOW_TYPES.indexOf(effect.type) !== -1);
  const others = visible.filter((effect) => SHADOW_TYPES.indexOf(effect.type) === -1);

  if (shadows.length === 0) {
    return failed(
      "unsupported-effect",
      visible.length === 0
        ? `has no visible effects.`
        : `has only ${describeEffects(others)}, none of which DTCG's shadow type can represent.`
    );
  }

  const values = shadows.map(toShadow);
  const omitted = others.map((effect) => effect.type);
  const note =
    others.length === 0
      ? ""
      : `${describeEffects(others)} ${others.length === 1 ? "has" : "have"} no DTCG representation and ${others.length === 1 ? "was" : "were"} left out of the shadow token`;

  return ok(values.length === 1 ? values[0] : values, omitted, note);
}

function toShadow(effect: EffectSnapshot): ShadowValue {
  return {
    blur: px(effect.radius),
    color: effect.color === undefined ? "#00000000" : rgbaToHex(effect.color),
    // INNER_SHADOW is DTCG's `inset` shadow. Always written, both ways, so a reader never has to
    // infer the default.
    inset: effect.type === "INNER_SHADOW",
    offsetX: px(effect.offsetX ?? 0),
    offsetY: px(effect.offsetY ?? 0),
    spread: px(effect.spread ?? 0),
  };
}

function describeEffects(effects: EffectSnapshot[]): string {
  const types = effects.map((effect) => effect.type.toLowerCase().replace(/_/g, " "));
  return `${types.length} effect${types.length === 1 ? "" : "s"} (${types.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

const GRID_PATTERNS: Record<string, GridValue["pattern"]> = {
  COLUMNS: "columns",
  ROWS: "rows",
  GRID: "grid",
};

/**
 * ADR-0003 §3: an array of layout-grid objects in source order, keys absent where Figma leaves
 * them absent.
 *
 * `grid` is a declared divergence — no DTCG type exists, and nothing downstream consumes it in
 * Phase 8. It is imported anyway because re-deriving it later from a file whose styles have
 * drifted costs a lot, and carrying it losslessly costs almost nothing.
 */
export function gridValue(style: GridStyleSnapshot): StyleValueResult<GridValue[]> {
  const visible = style.layoutGrids.filter((grid) => grid.visible);

  if (visible.length === 0) {
    return failed(
      "empty-grid",
      style.layoutGrids.length === 0
        ? "has no layout grids."
        : `has ${style.layoutGrids.length} layout grid${style.layoutGrids.length === 1 ? "" : "s"}, none of them visible.`
    );
  }

  const unknown = visible.filter((grid) => GRID_PATTERNS[grid.pattern] === undefined);
  if (unknown.length === visible.length) {
    return failed(
      "unsupported-grid",
      `has only layout grids of unknown pattern (${unknown.map((grid) => grid.pattern).join(", ")}).`
    );
  }

  const values = visible
    .filter((grid) => GRID_PATTERNS[grid.pattern] !== undefined)
    .map(toGrid);

  const omitted = unknown.map((grid) => grid.pattern);
  const note =
    unknown.length === 0
      ? ""
      : `${unknown.length} layout grid${unknown.length === 1 ? "" : "s"} of unknown pattern (${omitted.join(", ")}) ${unknown.length === 1 ? "was" : "were"} left out`;

  return ok(values, omitted, note);
}

function toGrid(grid: LayoutGridSnapshot): GridValue {
  const value: GridValue = { pattern: GRID_PATTERNS[grid.pattern] };
  if (grid.alignment !== undefined) value.alignment = grid.alignment.toLowerCase();
  if (grid.count !== undefined) value.count = normalizeFloat(grid.count);
  if (grid.gutterSize !== undefined) value.gutter = px(grid.gutterSize);
  if (grid.offset !== undefined) value.offset = px(grid.offset);
  if (grid.sectionSize !== undefined) value.sectionSize = px(grid.sectionSize);
  return value;
}
