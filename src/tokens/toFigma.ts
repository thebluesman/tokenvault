// Token → Figma write op — the inverse of the import, ADR-0005 §3.
//
// Pure, and hand-written rather than derived by inverting `build.ts`/`styleValues.ts`. Import is
// deliberately lossy at documented points (ADR-0003 §3): `AUTO` line height is omitted rather than
// invented, an unmapped `fontName.style` is kept as a string, gradients are refused outright. A
// mechanically derived inverse would have to *guess* at exactly those points, which is how a lossy
// import quietly becomes a lossy write — and a lossy write to a designer's file is unrecoverable.
//
// So this module refuses wherever import degraded, and two rules from ADR-0005 §3 are load-bearing
// throughout:
//
//   1. **Apply writes only the sub-keys the token carries.** A typography token whose `lineHeight`
//      was dropped as `AUTO` leaves the style's line height alone. Nothing is ever defaulted into
//      a gap.
//   2. **`figma.fontStyle` is authoritative for text styles.** ADR-0003 §2 carries Figma's raw
//      style string precisely so apply hands it back verbatim; a numeric `fontWeight: 700` is
//      never converted back into a style name.
//
// Everything below produces **plain data**. `src/figma/apply.ts` is the only module that calls a
// Figma write API — same one-impure-edge boundary as ADR-0002 §Module layout and ADR-0003 §7.

import type {
  GridValue,
  RgbaSnapshot,
  ShadowValue,
  StylesSnapshot,
  Token,
  TokenValue,
  TypographyValue,
} from "./types";
import { hexToRgba } from "./values";
import { isReference, referenceTarget } from "./references";

// ---------------------------------------------------------------------------
// The write ops
// ---------------------------------------------------------------------------

/** A colour in Figma's 0–1 channel form. `a` absent means fully opaque, as in `RGB`. */
export type ColorWrite = RgbaSnapshot;

export type VariableWriteValue = number | boolean | string | ColorWrite;

export interface PaintWrite {
  type: "SOLID";
  color: ColorWrite;
  /** Effective alpha lives here, not in `color` — Figma's `SolidPaint.color` is `RGB`. */
  opacity: number;
}

export interface EffectWrite {
  type: "DROP_SHADOW" | "INNER_SHADOW";
  color: ColorWrite;
  offsetX: number;
  offsetY: number;
  radius: number;
  spread: number;
}

export interface GridWrite {
  pattern: "COLUMNS" | "ROWS" | "GRID";
  alignment?: string;
  count?: number;
  gutterSize?: number;
  offset?: number;
  sectionSize?: number;
}

/** Figma's `LineHeight`/`LetterSpacing` units, in the two forms a token can round-trip into. */
export interface UnitValue {
  value: number;
  unit: "PIXELS" | "PERCENT";
}

export interface TextStyleWrite {
  family: string;
  /** `figma.fontStyle`, verbatim. Never derived from `fontWeight` — see the header. */
  style: string;
  fontSize: number;
  letterSpacing: UnitValue;
  /** Absent when the token has no `lineHeight`, which leaves Figma's alone (rule 1). */
  lineHeight?: UnitValue;
}

export type FigmaWriteOp =
  | { kind: "variable-value"; variableId: string; modeId: string; value: VariableWriteValue }
  | { kind: "variable-alias"; variableId: string; modeId: string; targetId: string }
  | { kind: "variable-description"; variableId: string; description: string }
  | { kind: "paint-style"; styleId: string; paint: PaintWrite }
  | { kind: "text-style"; styleId: string; text: TextStyleWrite }
  | { kind: "effect-style"; styleId: string; effects: EffectWrite[] }
  | { kind: "grid-style"; styleId: string; grids: GridWrite[] }
  | { kind: "style-description"; styleId: string; description: string }
  | { kind: "variable-remove"; variableId: string }
  | { kind: "style-remove"; styleId: string };

/**
 * A refusal, carrying the machine-readable slug the apply plan reports and the sentence the dialog
 * renders (UX §7's error table).
 *
 * Never an exception. ADR-0005 §11 is explicit that a failure discovered mid-plan, as whatever
 * string Figma chose to throw, is the failure mode the whole refusal apparatus exists to avoid.
 */
export interface Refusal {
  ok: false;
  reason: string;
  message: string;
}

export type WriteResult = { ok: true; write: FigmaWriteOp } | Refusal;

function refuse(reason: string, message: string): Refusal {
  return { ok: false, reason, message };
}

// ---------------------------------------------------------------------------
// Alias resolution — ADR-0005 §11
// ---------------------------------------------------------------------------

/**
 * What the caller's index says about a `{dotted.path}` target.
 *
 * The resolver itself lives in `plan.ts`, which owns the path→variableId index and the cycle
 * check; this module only needs the answer. Splitting it this way keeps `toFigma` a per-token
 * function with no view of the tree, which is what makes it exhaustively testable.
 */
export type AliasResolution = { ok: true; targetId: string } | Refusal;

export interface WriteOptions {
  /**
   * Resolves a reference to a local Figma variable id.
   *
   * Absent means the caller cannot alias at all, and every reference-valued token refuses. Under
   * ADR-0005 §1's overlay-scoped apply nothing in Phase 5 can *author* a reference (Phase 4's
   * editor refuses to edit one), so this path is exercised only by a Phase 6 pull — which is
   * exactly the point of building it now: the flattening failure mode is closed off before
   * anything can reach it.
   */
  resolveAlias?: (path: string) => AliasResolution;
  /**
   * Evaluates a math expression to the number that will be written — ADR-0007 §4.
   *
   * Apply is the one evaluation point that **flattens**: Figma has no representation for
   * arithmetic, so `{a} * 2` lands as `32` and stops tracking `a`. That is inherent to the Figma
   * data model rather than a Tokenvault shortfall, and the choice is not whether to flatten but
   * whether to make it visible — which the apply preview does, by showing the expression and the
   * number it resolved to before the button is pressed.
   *
   * Absent means the caller cannot evaluate, and every expression-valued token refuses rather than
   * being written as the string it holds.
   */
  evaluateExpression?: (raw: string) => { ok: true; value: number } | Refusal;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

interface VariableTarget {
  variableId: string;
  modeId: string;
}

function variableTarget(token: Token): VariableTarget | null {
  const figma = token.$extensions?.["com.tokenvault"]?.figma;
  if (!figma) return null;
  const { variableId, modeId } = figma;
  if (typeof variableId !== "string" || variableId.length === 0) return null;
  if (typeof modeId !== "string" || modeId.length === 0) return null;
  return { variableId, modeId };
}

function styleTarget(token: Token): string | null {
  const styleId = token.$extensions?.["com.tokenvault"]?.figma?.styleId;
  return typeof styleId === "string" && styleId.length > 0 ? styleId : null;
}

// ---------------------------------------------------------------------------
// The value write
// ---------------------------------------------------------------------------

/**
 * One token's `$value`, as the write that puts it back where it came from.
 *
 * Provenance decides the target system and there is no Variables-vs-Styles choice to make
 * (ADR-0005 §2): a token imported from a Variable applies to that Variable, a token imported from
 * a Style applies to that Style. Choosing between them is a *creation* question, and creation is
 * out of scope for this phase (§4).
 */
export function toFigmaValue(token: Token, options: WriteOptions = {}): WriteResult {
  const variable = variableTarget(token);
  if (variable !== null) return variableWrite(token, variable, options);

  const styleId = styleTarget(token);
  if (styleId !== null) return styleWrite(token, styleId);

  return refuse(
    "no-provenance",
    "Tokenvault couldn't tie this token back to a Figma Variable or Style, so there's nowhere to write it."
  );
}

/** A `$description` edit. Same target rules, one line of write either way. */
export function toFigmaDescription(token: Token, description: string): WriteResult {
  const variable = variableTarget(token);
  if (variable !== null) {
    return { ok: true, write: { kind: "variable-description", variableId: variable.variableId, description } };
  }
  const styleId = styleTarget(token);
  if (styleId !== null) {
    return { ok: true, write: { kind: "style-description", styleId, description } };
  }
  return refuse(
    "no-provenance",
    "Tokenvault couldn't tie this token back to a Figma Variable or Style, so there's nowhere to write it."
  );
}

/** The delete op for a token's target — ADR-0005 §5. Never reachable from a normal apply. */
export function toFigmaRemoval(token: Token): WriteResult {
  const variable = variableTarget(token);
  if (variable !== null) {
    return { ok: true, write: { kind: "variable-remove", variableId: variable.variableId } };
  }
  const styleId = styleTarget(token);
  if (styleId !== null) return { ok: true, write: { kind: "style-remove", styleId } };
  return refuse(
    "no-provenance",
    "Tokenvault couldn't tie this token back to a Figma Variable or Style, so there's nothing to remove."
  );
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function variableWrite(token: Token, target: VariableTarget, options: WriteOptions): WriteResult {
  const value = token.$value;

  if (isReference(value)) {
    const path = referenceTarget(value) as string;
    const resolve = options.resolveAlias;
    if (resolve === undefined) {
      return refuse(
        "alias-unresolvable",
        `Points at ${path}, and this apply has no way to resolve a reference to a Variable.`
      );
    }
    const resolved = resolve(path);
    if (!resolved.ok) return resolved;
    // The whole alias write, per ADR-0005 §11. There is no synthesis and no encoding: Figma models
    // token-to-token pointers natively, and multi-hop chains need no traversal here because each
    // link is written independently and Figma resolves the chain at render time.
    return {
      ok: true,
      write: {
        kind: "variable-alias",
        variableId: target.variableId,
        modeId: target.modeId,
        targetId: resolved.targetId,
      },
    };
  }

  // A value that merely *contains* braces is not a reference (`references.ts` anchors the pattern
  // deliberately). On a `number` token it is a math expression, which Figma cannot hold as such and
  // which therefore evaluates to a concrete number here — the one place Tokenvault flattens, and
  // the one the preview is obliged to show (ADR-0007 §4).
  // Read off the token rather than the narrowed local: `isReference` is a `value is string` guard,
  // so TypeScript has already subtracted `string` from `value` in this branch.
  const raw = token.$value;
  if (typeof raw === "string" && token.$type === "number") {
    const evaluateExpr = options.evaluateExpression;
    if (evaluateExpr === undefined) {
      return refuse(
        "expression-unresolvable",
        `"${raw}" is a math expression, and this apply has no way to work out what it comes to.`
      );
    }
    const evaluated = evaluateExpr(raw);
    if (!evaluated.ok) return evaluated;
    return {
      ok: true,
      write: {
        kind: "variable-value",
        variableId: target.variableId,
        modeId: target.modeId,
        value: evaluated.value,
      },
    };
  }
  if (typeof raw === "string" && raw.indexOf("{") !== -1 && token.$type !== "string") {
    return refuse(
      "expression-value",
      `"${raw}" isn't a plain value or a reference, and a ${token.$type} token can't hold an expression.`
    );
  }

  const scalar = scalarWrite(token, value);
  if (!scalar.ok) return scalar;

  return {
    ok: true,
    write: {
      kind: "variable-value",
      variableId: target.variableId,
      modeId: target.modeId,
      value: scalar.value,
    },
  };
}

function scalarWrite(
  token: Token,
  value: TokenValue
): { ok: true; value: VariableWriteValue } | Refusal {
  switch (token.$type) {
    case "color": {
      if (typeof value !== "string") {
        return refuse("bad-color", "This colour token's value isn't a hex string.");
      }
      const color = hexToRgba(value);
      if (color === null) {
        return refuse("bad-color", `"${value}" isn't a hex colour Figma can take.`);
      }
      return { ok: true, value: color };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return refuse("bad-number", `"${String(value)}" isn't a number Figma can take.`);
      }
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        return refuse("bad-boolean", `"${String(value)}" isn't true or false.`);
      }
      return { ok: true, value };
    }
    case "string": {
      if (typeof value !== "string") {
        return refuse("bad-string", "This string token's value isn't a string.");
      }
      return { ok: true, value };
    }
    default:
      // A composite type on a Variable target cannot happen from an import — Variables hold only
      // the four scalar kinds — so this is a corrupted or hand-edited tree, not a user mistake.
      return refuse(
        "composite-on-variable",
        `A ${token.$type} value can't be written into a Figma Variable.`
      );
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styleWrite(token: Token, styleId: string): WriteResult {
  // A style cannot hold a Variable alias as its *value*: the equivalent is binding a variable to
  // one of its fields, which is `setBoundVariableForPaint` and friends — a binding operation, and
  // ADR-0005 §12 defers bindings wholesale. Blocked, never flattened to the resolved literal
  // (UX §5.6: the fallback is always "block", never "flatten silently").
  if (isReference(token.$value)) {
    return refuse(
      "alias-target-not-variable",
      `Points at ${referenceTarget(token.$value) as string}, but this token is a Style — a Style can't hold a Variable reference as its value.`
    );
  }

  switch (token.$type) {
    case "color":
      return paintWrite(token, styleId);
    case "typography":
      return textWrite(token, styleId);
    case "shadow":
      return effectWrite(token, styleId);
    case "grid":
      return gridWrite(token, styleId);
    default:
      return refuse(
        "unsupported-style-type",
        `A ${token.$type} token has no Figma Style to write into.`
      );
  }
}

function paintWrite(token: Token, styleId: string): WriteResult {
  if (typeof token.$value !== "string") {
    return refuse("bad-color", "This paint style's token value isn't a hex string.");
  }
  const color = hexToRgba(token.$value);
  if (color === null) {
    return refuse("bad-color", `"${token.$value}" isn't a hex colour Figma can take.`);
  }

  // Import folded `paint.opacity × color.a` into one hex (ADR-0003 §3), and that product has no
  // unique factorisation. Alpha goes back on `opacity` — where Figma's own colour picker puts it,
  // and the only channel a `SolidPaint`'s RGB `color` has no room for.
  const alpha = color.a === undefined ? 1 : color.a;
  return {
    ok: true,
    write: {
      kind: "paint-style",
      styleId,
      paint: { type: "SOLID", color: { r: color.r, g: color.g, b: color.b }, opacity: alpha },
    },
  };
}

/** `PERCENT` letter spacing is a percentage *of font size*, which is what `em` means (ADR-0003). */
function toUnitValue(
  dimension: { unit: string; value: number } | number,
  percentUnit: string | undefined
): UnitValue {
  if (typeof dimension === "number") {
    // A bare number only ever comes from a PERCENT line height, where DTCG's multiplier form
    // (150% → 1.5) is what import wrote.
    return { value: dimension * 100, unit: "PERCENT" };
  }
  if (dimension.unit === "em") return { value: dimension.value * 100, unit: "PERCENT" };
  // The recorded Figma unit wins over the token's `px` when they disagree, because `figma.text`
  // is the round-trip carrier and the token's unit is the lossy projection of it.
  return { value: dimension.value, unit: percentUnit === "PERCENT" ? "PERCENT" : "PIXELS" };
}

function textWrite(token: Token, styleId: string): WriteResult {
  const value = token.$value as TypographyValue;
  if (value === null || typeof value !== "object") {
    return refuse("bad-typography", "This typography token's value isn't an object.");
  }

  const figma = token.$extensions?.["com.tokenvault"]?.figma;
  const fontStyle = figma?.fontStyle;
  if (typeof fontStyle !== "string" || fontStyle.length === 0) {
    // ADR-0003 §2 carries the raw style string for exactly this moment. Without it the only way
    // to name a font style is to invent one from `fontWeight`, and "600" is not a font Figma can
    // load — it would fail at `loadFontAsync` with a message about a missing font, which is a
    // confusing way to say "this token didn't round-trip".
    return refuse(
      "missing-font-style",
      "This text style has no recorded Figma font style, so the font can't be named to write it back."
    );
  }
  if (typeof value.fontFamily !== "string" || value.fontFamily.length === 0) {
    return refuse("bad-typography", "This typography token has no font family.");
  }
  if (typeof value.fontSize !== "object" || typeof value.fontSize.value !== "number") {
    return refuse("bad-typography", "This typography token has no usable font size.");
  }

  const extras = figma?.text ?? {};
  const text: TextStyleWrite = {
    family: value.fontFamily,
    style: fontStyle,
    fontSize: value.fontSize.value,
    letterSpacing: toUnitValue(
      value.letterSpacing ?? { unit: "px", value: 0 },
      typeof extras.letterSpacingUnit === "string" ? extras.letterSpacingUnit : undefined
    ),
  };

  // Rule 1, at its sharpest. An absent `lineHeight` means import dropped it as `AUTO`
  // (ADR-0003 §3) — so the key stays out of the write and Figma's line height is left exactly as
  // it is. Writing a default here is how an `AUTO` style silently becomes a fixed one.
  if (value.lineHeight !== undefined) {
    text.lineHeight = toUnitValue(
      value.lineHeight,
      typeof extras.lineHeightUnit === "string" ? extras.lineHeightUnit : undefined
    );
  }

  return { ok: true, write: { kind: "text-style", styleId, text } };
}

function effectWrite(token: Token, styleId: string): WriteResult {
  const list = Array.isArray(token.$value)
    ? (token.$value as ShadowValue[])
    : token.$value !== null && typeof token.$value === "object"
      ? [token.$value as ShadowValue]
      : null;
  if (list === null || list.length === 0) {
    return refuse("bad-shadow", "This shadow token has no shadows to write.");
  }

  const effects: EffectWrite[] = [];
  for (const shadow of list) {
    if (typeof shadow.color !== "string") {
      return refuse("bad-shadow", "A shadow in this token has no hex colour.");
    }
    const color = hexToRgba(shadow.color);
    if (color === null) {
      return refuse("bad-shadow", `"${shadow.color}" isn't a hex colour Figma can take.`);
    }
    effects.push({
      type: shadow.inset === true ? "INNER_SHADOW" : "DROP_SHADOW",
      // Figma's shadow colour is RGBA, so alpha stays on the colour here rather than moving to an
      // opacity field the way it does for a paint. An absent alpha is opaque.
      color: { r: color.r, g: color.g, b: color.b, a: color.a === undefined ? 1 : color.a },
      offsetX: dimensionNumber(shadow.offsetX),
      offsetY: dimensionNumber(shadow.offsetY),
      radius: dimensionNumber(shadow.blur),
      spread: dimensionNumber(shadow.spread),
    });
  }

  return { ok: true, write: { kind: "effect-style", styleId, effects } };
}

function dimensionNumber(value: { unit: string; value: number } | number | undefined): number {
  if (value === undefined) return 0;
  return typeof value === "number" ? value : value.value;
}

const GRID_PATTERNS: Record<string, GridWrite["pattern"]> = {
  columns: "COLUMNS",
  rows: "ROWS",
  grid: "GRID",
};

function gridWrite(token: Token, styleId: string): WriteResult {
  if (!Array.isArray(token.$value)) {
    return refuse("bad-grid", "This grid token's value isn't a list of layout grids.");
  }
  const list = token.$value as GridValue[];
  if (list.length === 0) return refuse("bad-grid", "This grid token has no layout grids to write.");

  const grids: GridWrite[] = [];
  for (const grid of list) {
    const pattern = GRID_PATTERNS[grid.pattern];
    if (pattern === undefined) {
      return refuse("bad-grid", `"${String(grid.pattern)}" isn't a layout grid pattern Figma knows.`);
    }
    // Absent keys stay absent, all the way through (ADR-0003 §3). `count: 0` on a `grid` pattern
    // is a value the importer would never write, and it would land in Figma as a real, wrong
    // setting rather than as the "unset" it is meant to represent.
    const write: GridWrite = { pattern };
    if (grid.alignment !== undefined) write.alignment = grid.alignment.toUpperCase();
    if (grid.count !== undefined) write.count = grid.count;
    if (grid.gutter !== undefined) write.gutterSize = dimensionNumber(grid.gutter);
    if (grid.offset !== undefined) write.offset = dimensionNumber(grid.offset);
    if (grid.sectionSize !== undefined) write.sectionSize = dimensionNumber(grid.sectionSize);
    grids.push(write);
  }

  return { ok: true, write: { kind: "grid-style", styleId, grids } };
}

// ---------------------------------------------------------------------------
// Style guards — the styles apply must refuse, ADR-0005 §3
// ---------------------------------------------------------------------------

/**
 * Styles whose live shape a token cannot rebuild without losing something.
 *
 * A style write replaces a whole array — `style.paints`, `style.effects`, `style.layoutGrids` —
 * because Figma offers no per-element write. So a style carrying anything import did not
 * represent would have it deleted on the way back: an invisible paint, a blur sitting beside the
 * shadows, a layout grid of a pattern the schema doesn't know. That is exactly the case ADR-0005
 * §3 forbids — *filling a gap is how a lossy import becomes a lossy write, which is
 * unrecoverable* — so those styles refuse rather than write.
 *
 * Derived from the scan rather than from the report on purpose: the report says a token was
 * *degraded*, which is a superset (an `AUTO` line height degrades a token and is perfectly safe to
 * write back, because text fields are written one at a time). What matters here is narrower and
 * structural — does this style hold elements the token has no room for? — and the snapshot is
 * where that question has an exact answer.
 *
 * Text styles are absent by construction: they have no array to replace, so the per-field rule
 * covers them completely.
 */
export function styleGuards(styles: StylesSnapshot): Map<string, Refusal> {
  const guards = new Map<string, Refusal>();

  for (const style of styles.paint) {
    // A style with more than one visible paint produced no token at all (ADR-0003 §3), so the only
    // case that reaches here is extra *invisible* paints riding along with the one that did.
    const extra = style.paints.length - 1;
    if (extra > 0) {
      guards.set(
        style.id,
        refuse(
          "apply-lossy-style",
          `"${style.name}" has ${extra} more paint${extra === 1 ? "" : "s"} than the token represents, so applying it would delete ${extra === 1 ? "that one" : "them"}.`
        )
      );
    }
  }

  const SHADOWS = ["DROP_SHADOW", "INNER_SHADOW"];
  for (const style of styles.effect) {
    const carried = style.effects.filter(
      (effect) => effect.visible && SHADOWS.indexOf(effect.type) !== -1
    ).length;
    const extra = style.effects.length - carried;
    if (extra > 0) {
      guards.set(
        style.id,
        refuse(
          "apply-lossy-style",
          `"${style.name}" has ${extra} effect${extra === 1 ? "" : "s"} the shadow token can't represent — a blur, or a hidden effect — so applying it would delete ${extra === 1 ? "it" : "them"}.`
        )
      );
    }
  }

  const PATTERNS = ["COLUMNS", "ROWS", "GRID"];
  for (const style of styles.grid) {
    const carried = style.layoutGrids.filter(
      (grid) => grid.visible && PATTERNS.indexOf(grid.pattern) !== -1
    ).length;
    const extra = style.layoutGrids.length - carried;
    if (extra > 0) {
      guards.set(
        style.id,
        refuse(
          "apply-lossy-style",
          `"${style.name}" has ${extra} layout grid${extra === 1 ? "" : "s"} the token can't represent, so applying it would delete ${extra === 1 ? "it" : "them"}.`
        )
      );
    }
  }

  return guards;
}
