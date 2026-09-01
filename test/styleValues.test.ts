// The pure style value mappings — ADR-0003 §3.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fontWeightOf,
  gridValue,
  paintValue,
  shadowValue,
  textExtras,
  typographyValue,
} from "../src/tokens/styleValues";
import {
  blur,
  columnsGrid,
  effectStyle,
  gridStyle,
  nonSolidPaint,
  paintStyle,
  shadow,
  solid,
  textStyle,
} from "./helpers";

const BLUE = { r: 45 / 255, g: 127 / 255, b: 249 / 255 };

function ok<T>(result: { ok: boolean } & Record<string, unknown>): asserts result is {
  ok: true;
  value: T;
  omitted: string[];
  note: string;
} & Record<string, unknown> {
  assert.equal(result.ok, true, `expected a value, got: ${JSON.stringify(result)}`);
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

test("a single visible solid paint maps to a hex colour", () => {
  const result = paintValue(paintStyle("S:1", "brand/primary", [solid(BLUE)]));
  ok(result);
  assert.equal(result.value.hex, "#2d7ff9");
});

test("effective alpha is the paint's opacity times the colour's own alpha", () => {
  // ADR-0003 §3. Neither factor alone is the answer, so both have to be multiplied.
  const half = paintValue(paintStyle("S:1", "a", [solid(BLUE, { opacity: 0.5 })]));
  ok(half);
  assert.equal(half.value.hex, "#2d7ff980");

  const both = paintValue(paintStyle("S:2", "b", [solid(BLUE, { opacity: 0.5, alpha: 0.5 })]));
  ok(both);
  assert.equal(both.value.hex, "#2d7ff940");
});

test("a fully opaque paint stays #rrggbb, with no redundant alpha pair", () => {
  const result = paintValue(paintStyle("S:1", "a", [solid(BLUE, { opacity: 1, alpha: 1 })]));
  ok(result);
  assert.equal(result.value.hex, "#2d7ff9");
});

test("invisible paints do not count towards the one-visible-paint rule", () => {
  const result = paintValue(
    paintStyle("S:1", "a", [solid({ r: 1, g: 0, b: 0 }, { visible: false }), solid(BLUE)])
  );
  ok(result);
  assert.equal(result.value.hex, "#2d7ff9");
});

test("gradients, images and stacks are reported with a reason, never dropped or guessed", () => {
  const cases: Array<[string, ReturnType<typeof paintStyle>]> = [
    ["gradient-paint", paintStyle("S:1", "a", [nonSolidPaint("GRADIENT_LINEAR")])],
    ["gradient-paint", paintStyle("S:2", "b", [nonSolidPaint("GRADIENT_RADIAL")])],
    ["image-paint", paintStyle("S:3", "c", [nonSolidPaint("IMAGE")])],
    ["image-paint", paintStyle("S:4", "d", [nonSolidPaint("VIDEO")])],
    ["image-paint", paintStyle("S:5", "e", [nonSolidPaint("PATTERN")])],
    ["multi-paint", paintStyle("S:6", "f", [solid(BLUE), solid({ r: 1, g: 0, b: 0 })])],
    ["empty-paint", paintStyle("S:7", "g", [])],
    ["empty-paint", paintStyle("S:8", "h", [solid(BLUE, { visible: false })])],
  ];

  for (const [reason, style] of cases) {
    const result = paintValue(style);
    assert.equal(result.ok, false, `${style.name} should not have produced a value`);
    if (!result.ok) assert.equal(result.reason, reason, `wrong reason for ${style.name}`);
  }
});

test("a paint type Figma has not shipped yet is reported rather than coerced", () => {
  const result = paintValue(paintStyle("S:1", "a", [nonSolidPaint("SOMETHING_NEW")]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unsupported-paint");
});

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

test("a text style maps to the DTCG typography composite", () => {
  const result = typographyValue(
    textStyle("S:1", "heading/lg", {
      fontFamily: "Inter",
      fontStyle: "Semibold",
      fontSize: 16,
      letterSpacing: { value: 1, unit: "PERCENT" },
      lineHeight: { value: 150, unit: "PERCENT" },
    })
  );
  ok(result);
  assert.deepEqual(result.value, {
    fontFamily: "Inter",
    fontSize: { unit: "px", value: 16 },
    fontWeight: 600,
    letterSpacing: { unit: "em", value: 0.01 },
    lineHeight: 1.5,
  });
  assert.deepEqual(result.omitted, []);
});

test("pixel letter spacing and line height stay px dimensions", () => {
  const result = typographyValue(
    textStyle("S:1", "a", {
      letterSpacing: { value: 0.5, unit: "PIXELS" },
      lineHeight: { value: 24, unit: "PIXELS" },
    })
  );
  ok(result);
  assert.deepEqual(result.value.letterSpacing, { unit: "px", value: 0.5 });
  assert.deepEqual(result.value.lineHeight, { unit: "px", value: 24 });
});

test("AUTO line height omits the sub-key and reports a partial token", () => {
  // Auto line height is a Figma layout behaviour, not a value — so there is nothing to write,
  // and writing a guess would be worse than saying so (ADR-0003 §3).
  const result = typographyValue(textStyle("S:1", "a", { lineHeight: { unit: "AUTO" } }));
  ok(result);
  assert.equal("lineHeight" in result.value, false);
  assert.deepEqual(result.omitted, ["lineHeight"]);
  assert.match(result.note, /AUTO/);
});

test("the font weight keyword table covers Figma's usual style names", () => {
  const expected: Array<[string, number]> = [
    ["Thin", 100],
    ["ExtraLight", 200],
    ["Extra Light", 200],
    ["UltraLight", 200],
    ["Light", 300],
    ["Regular", 400],
    ["Normal", 400],
    ["Book", 400],
    ["Italic", 400],
    ["Medium", 500],
    ["SemiBold", 600],
    ["Semibold", 600],
    ["Demi Bold", 600],
    ["Bold", 700],
    ["ExtraBold", 800],
    ["Black", 900],
    ["Heavy", 900],
  ];

  for (const [style, weight] of expected) {
    const result = fontWeightOf(style);
    assert.equal(result.weight, weight, `${style} should map to ${weight}`);
    assert.equal(result.mapped, true);
  }
});

test("slant is stripped before the weight lookup, never folded into it", () => {
  assert.equal(fontWeightOf("Bold Italic").weight, 700);
  assert.equal(fontWeightOf("SemiBold Oblique").weight, 600);
  assert.equal(fontWeightOf("bold-italic").weight, 700);
});

test("an unrecognised font style keeps the raw string and is flagged", () => {
  // DTCG permits a string in fontWeight, so the honest answer is to keep what Figma said and
  // say the table missed — not to guess 400 (ADR-0003 §3).
  const result = fontWeightOf("Condensed Ultra Expanded");
  assert.equal(result.weight, "Condensed Ultra Expanded");
  assert.equal(result.mapped, false);

  const typography = typographyValue(textStyle("S:1", "a", { fontStyle: "Wonky Grotesk" }));
  ok(typography);
  assert.equal(typography.value.fontWeight, "Wonky Grotesk");
  // Nothing was omitted — the token is whole, just degraded — so this is a note, not an omission.
  assert.deepEqual(typography.omitted, []);
  assert.match(typography.note, /weight keyword table/);
});

test("everything DTCG typography cannot hold is kept verbatim for round-trip", () => {
  const extras = textExtras(
    textStyle("S:1", "a", {
      textCase: "UPPER",
      textDecoration: "UNDERLINE",
      paragraphSpacing: 8,
      paragraphIndent: 4,
      listSpacing: 2,
      hangingPunctuation: true,
      leadingTrim: "CAP_HEIGHT",
      lineHeight: { value: 24, unit: "PIXELS" },
      letterSpacing: { value: 1, unit: "PERCENT" },
    })
  );

  assert.equal(extras.textCase, "UPPER");
  assert.equal(extras.textDecoration, "UNDERLINE");
  assert.equal(extras.paragraphSpacing, 8);
  assert.equal(extras.paragraphIndent, 4);
  assert.equal(extras.listSpacing, 2);
  assert.equal(extras.hangingPunctuation, true);
  assert.equal(extras.leadingTrim, "CAP_HEIGHT");
  // The units are kept too: `px` in the token cannot say whether Figma held PIXELS or a
  // percentage that happened to resolve there, and Phase 5 has to hand the original back.
  assert.equal(extras.lineHeightUnit, "PIXELS");
  assert.equal(extras.letterSpacingUnit, "PERCENT");
});

// ---------------------------------------------------------------------------
// Effect
// ---------------------------------------------------------------------------

test("one visible shadow maps to a single shadow object", () => {
  const result = shadowValue(effectStyle("S:1", "elevation/1", [shadow("DROP_SHADOW")]));
  ok(result);
  assert.deepEqual(result.value, {
    blur: { unit: "px", value: 8 },
    color: "#00000029",
    inset: false,
    offsetX: { unit: "px", value: 0 },
    offsetY: { unit: "px", value: 2 },
    spread: { unit: "px", value: 0 },
  });
});

test("several shadows become an array in source order, so composite-ness survives", () => {
  const result = shadowValue(
    effectStyle("S:1", "elevation/2", [
      shadow("DROP_SHADOW", { radius: 2, offsetY: 1 }),
      shadow("DROP_SHADOW", { radius: 16, offsetY: 8 }),
    ])
  );
  ok(result);
  assert.equal(Array.isArray(result.value), true);
  const shadows = result.value as Array<{ blur: { value: number } }>;
  assert.equal(shadows.length, 2);
  assert.deepEqual(shadows.map((item) => item.blur.value), [2, 16]);
});

test("an inner shadow sets inset, and a drop shadow always says inset: false", () => {
  const inner = shadowValue(effectStyle("S:1", "a", [shadow("INNER_SHADOW")]));
  ok(inner);
  assert.equal((inner.value as { inset: boolean }).inset, true);

  const drop = shadowValue(effectStyle("S:2", "b", [shadow("DROP_SHADOW")]));
  ok(drop);
  assert.equal((drop.value as { inset: boolean }).inset, false);
});

test("invisible effects are skipped silently — they are off in Figma too", () => {
  const result = shadowValue(
    effectStyle("S:1", "a", [shadow("DROP_SHADOW", { visible: false }), shadow("DROP_SHADOW")])
  );
  ok(result);
  assert.equal(Array.isArray(result.value), false);
  assert.deepEqual(result.omitted, []);
});

test("a blur-only effect style is not written, and says which effects blocked it", () => {
  const result = shadowValue(effectStyle("S:1", "a", [blur("LAYER_BLUR"), blur("BACKGROUND_BLUR")]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unsupported-effect");
    assert.match(result.message, /layer blur/);
  }
});

test("shadows mixed with blurs write the shadows and report what was left out", () => {
  const result = shadowValue(effectStyle("S:1", "a", [shadow("DROP_SHADOW"), blur("LAYER_BLUR")]));
  ok(result);
  assert.equal(Array.isArray(result.value), false);
  assert.deepEqual(result.omitted, ["LAYER_BLUR"]);
  assert.match(result.note, /no DTCG representation/);
});

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

test("layout grids map to an array in source order with lowercased patterns", () => {
  const result = gridValue(
    gridStyle("S:1", "layout/desktop", [
      columnsGrid(),
      { pattern: "GRID", visible: true, sectionSize: 8 },
    ])
  );
  ok(result);
  assert.deepEqual(result.value, [
    {
      pattern: "columns",
      alignment: "stretch",
      count: 12,
      gutter: { unit: "px", value: 16 },
      offset: { unit: "px", value: 24 },
    },
    { pattern: "grid", sectionSize: { unit: "px", value: 8 } },
  ]);
});

test("keys Figma leaves absent stay absent rather than being defaulted", () => {
  const result = gridValue(
    gridStyle("S:1", "a", [columnsGrid({ offset: undefined, sectionSize: undefined })])
  );
  ok(result);
  const grid = result.value[0];
  assert.equal("offset" in grid, false);
  assert.equal("sectionSize" in grid, false);
});

test("a grid style with no visible grid is reported, not written as an empty array", () => {
  const empty = gridValue(gridStyle("S:1", "a", []));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty-grid");

  const hidden = gridValue(gridStyle("S:2", "b", [columnsGrid({ visible: false })]));
  assert.equal(hidden.ok, false);
  if (!hidden.ok) assert.equal(hidden.reason, "empty-grid");
});

test("an unknown grid pattern is left out and reported rather than passed through", () => {
  const mixed = gridValue(
    gridStyle("S:1", "a", [columnsGrid(), { pattern: "SPIRAL", visible: true }])
  );
  ok(mixed);
  assert.equal(mixed.value.length, 1);
  assert.deepEqual(mixed.omitted, ["SPIRAL"]);

  const only = gridValue(gridStyle("S:2", "b", [{ pattern: "SPIRAL", visible: true }]));
  assert.equal(only.ok, false);
  if (!only.ok) assert.equal(only.reason, "unsupported-grid");
});
