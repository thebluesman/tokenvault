// The inverse conversion — ADR-0005 §3.
//
// The property the ADR asks for is a round trip: `toFigma(build(figma))` reproduces `figma` for
// every token import did not flag, and refuses for the ones it did. The `fixture` half of that
// lives in fixtureApply.test.ts against the committed Folio snapshot; this file pins the per-type
// rules and, above all, the refusals — the places where a lossy import must not become a lossy
// write.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Refusal } from "../src/tokens/toFigma";
import {
  styleGuards,
  toFigmaDescription,
  toFigmaRemoval,
  toFigmaValue,
} from "../src/tokens/toFigma";
import { hexToRgba, rgbaToHex } from "../src/tokens/values";
import {
  blur,
  columnsGrid,
  effectStyle,
  gridStyle,
  paintStyle,
  shadow,
  solid,
  styleToken,
  styles,
  varToken,
} from "./helpers";

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  assert.equal(result.ok, true, `expected a write, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function refusal(result: { ok: boolean }): Refusal {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  return result as Refusal;
}

// ---------------------------------------------------------------------------
// Colour, both ways
// ---------------------------------------------------------------------------

test("hexToRgba is the exact inverse of rgbaToHex for 8-bit colours", () => {
  // ADR-0002 §4: Figma stores 0–1 floats but its UI authors 8-bit hex, so the 8-bit round trip is
  // exact for anything a human typed — which is the assumption apply relies on to write back a
  // value nobody edited without producing a diff.
  for (const hex of ["#000000", "#ffffff", "#c33a2e", "#0d99ff", "#00000040", "#f0a19aff"]) {
    const rgba = hexToRgba(hex);
    assert.notEqual(rgba, null, hex);
    assert.equal(rgbaToHex(rgba as NonNullable<typeof rgba>), hex.endsWith("ff") ? hex.slice(0, 7) : hex);
  }
});

test("hexToRgba refuses anything that is not a form rgbaToHex emits", () => {
  // Strict on purpose: normalisation happens once, on the way in, in `parseHexColor`. A second
  // spelling of the same colour here would give the plugin two answers to "does this round-trip?".
  for (const bad of ["#fff", "c33a2e", "#gggggg", "", "#12345"]) {
    assert.equal(hexToRgba(bad), null, bad);
  }
});

test("a 6-digit hex leaves alpha absent rather than materialising a=1", () => {
  // Matching `rgbaToHex`'s own asymmetry, and matching Figma's `RGB`, which has no alpha at all.
  assert.deepEqual(hexToRgba("#c33a2e"), { r: 195 / 255, g: 58 / 255, b: 46 / 255 });
});

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

test("each scalar type writes into its Variable and mode", () => {
  const color = ok(toFigmaValue(varToken("color", "#c33a2e")));
  assert.deepEqual(color.write, {
    kind: "variable-value",
    variableId: "VariableID:1:1",
    modeId: "1:0",
    value: { r: 195 / 255, g: 58 / 255, b: 46 / 255 },
  });

  assert.equal(ok(toFigmaValue(varToken("number", 16))).write.kind, "variable-value");
  assert.equal(ok(toFigmaValue(varToken("boolean", true))).write.kind, "variable-value");
  assert.equal(ok(toFigmaValue(varToken("string", "Urbanist"))).write.kind, "variable-value");
});

test("a mistyped value refuses instead of being coerced", () => {
  assert.equal(refusal(toFigmaValue(varToken("number", "16"))).reason, "bad-number");
  assert.equal(refusal(toFigmaValue(varToken("boolean", "true"))).reason, "bad-boolean");
  assert.equal(refusal(toFigmaValue(varToken("color", "rebeccapurple"))).reason, "bad-color");
  assert.equal(refusal(toFigmaValue(varToken("number", Number.NaN))).reason, "bad-number");
});

test("a token with no Figma provenance refuses rather than guessing a target", () => {
  const orphan = { $type: "color", $value: "#000000", $extensions: { "com.tokenvault": { figma: {} } } };
  assert.equal(refusal(toFigmaValue(orphan as never)).reason, "no-provenance");
});

test("a math expression refuses — Phase 7 owns evaluation, and it has no Figma representation", () => {
  const refused = refusal(toFigmaValue(varToken("number", "{spacing.100} * 2" as never)));
  assert.equal(refused.reason, "expression-value");
});

// ---------------------------------------------------------------------------
// Aliases — ADR-0005 §11
// ---------------------------------------------------------------------------

test("a reference writes a native VARIABLE_ALIAS, never a flattened literal", () => {
  const token = varToken("color", "{folio.ref.red.50}");
  const result = ok(
    toFigmaValue(token, { resolveAlias: () => ({ ok: true, targetId: "VariableID:9:9" }) })
  );
  assert.deepEqual(result.write, {
    kind: "variable-alias",
    variableId: "VariableID:1:1",
    modeId: "1:0",
    targetId: "VariableID:9:9",
  });
});

test("with no resolver, a reference refuses rather than flattening", () => {
  // UX §5.6's fallback is "block", never "flatten silently": a flattened pointer is data loss the
  // user would not notice for months.
  assert.equal(refusal(toFigmaValue(varToken("color", "{folio.ref.red.50}"))).reason, "alias-unresolvable");
});

test("the resolver's refusal is passed through verbatim, not reworded", () => {
  const refused = refusal(
    toFigmaValue(varToken("color", "{gone}"), {
      resolveAlias: () => ({ ok: false, reason: "alias-target-unknown", message: "Points at gone." }),
    })
  );
  assert.equal(refused.reason, "alias-target-unknown");
  assert.equal(refused.message, "Points at gone.");
});

test("a Style can't hold a reference as its value, and says so instead of flattening", () => {
  const refused = refusal(toFigmaValue(styleToken("color", "{folio.ref.red.50}")));
  assert.equal(refused.reason, "alias-target-not-variable");
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

test("alpha goes back on paint.opacity, where Figma's RGB colour has no room for it", () => {
  const result = ok(toFigmaValue(styleToken("color", "#00000040")));
  assert.deepEqual(result.write, {
    kind: "paint-style",
    styleId: "S:abc",
    paint: { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 64 / 255 },
  });
});

test("figma.fontStyle is authoritative — fontWeight never becomes a style name", () => {
  const token = styleToken(
    "typography",
    {
      fontFamily: "Urbanist",
      fontSize: { unit: "px", value: 20 },
      fontWeight: 600,
      letterSpacing: { unit: "px", value: 0 },
      lineHeight: { unit: "px", value: 24 },
    },
    { styleType: "TEXT", fontStyle: "SemiBold Italic", text: { lineHeightUnit: "PIXELS", letterSpacingUnit: "PIXELS" } }
  );
  const result = ok(toFigmaValue(token));
  assert.deepEqual(result.write, {
    kind: "text-style",
    styleId: "S:abc",
    text: {
      family: "Urbanist",
      style: "SemiBold Italic",
      fontSize: 20,
      letterSpacing: { value: 0, unit: "PIXELS" },
      lineHeight: { value: 24, unit: "PIXELS" },
    },
  });
});

test("a text style with no recorded fontStyle refuses rather than inventing one from the weight", () => {
  const token = styleToken(
    "typography",
    {
      fontFamily: "Urbanist",
      fontSize: { unit: "px", value: 20 },
      fontWeight: 700,
      letterSpacing: { unit: "px", value: 0 },
    },
    { styleType: "TEXT" }
  );
  assert.equal(refusal(toFigmaValue(token)).reason, "missing-font-style");
});

test("an omitted lineHeight stays omitted — apply never fills a gap import left (§3 rule 1)", () => {
  // Import drops `lineHeight` when Figma's is AUTO (ADR-0003 §3). Defaulting one here would
  // silently turn an auto-height style into a fixed one, which no rescan could tell the user about.
  const token = styleToken(
    "typography",
    {
      fontFamily: "Urbanist",
      fontSize: { unit: "px", value: 20 },
      fontWeight: 400,
      letterSpacing: { unit: "px", value: 0 },
    },
    { styleType: "TEXT", fontStyle: "Regular" }
  );
  const write = ok(toFigmaValue(token)).write as { text: { lineHeight?: unknown } };
  assert.equal("lineHeight" in write.text, false);
});

test("em letter spacing and a multiplier line height go back as PERCENT", () => {
  const token = styleToken(
    "typography",
    {
      fontFamily: "Urbanist",
      fontSize: { unit: "px", value: 20 },
      fontWeight: 400,
      letterSpacing: { unit: "em", value: 0.02 },
      lineHeight: 1.5,
    },
    { styleType: "TEXT", fontStyle: "Regular", text: { lineHeightUnit: "PERCENT", letterSpacingUnit: "PERCENT" } }
  );
  const write = ok(toFigmaValue(token)).write as { text: { letterSpacing: unknown; lineHeight: unknown } };
  assert.deepEqual(write.text.letterSpacing, { value: 2, unit: "PERCENT" });
  assert.deepEqual(write.text.lineHeight, { value: 150, unit: "PERCENT" });
});

test("a single shadow and a stack both write an effect list, inset mapped to INNER_SHADOW", () => {
  const one = ok(
    toFigmaValue(
      styleToken(
        "shadow",
        {
          blur: { unit: "px", value: 8 },
          color: "#00000029",
          inset: true,
          offsetX: { unit: "px", value: 0 },
          offsetY: { unit: "px", value: 2 },
          spread: { unit: "px", value: 0 },
        },
        { styleType: "EFFECT" }
      )
    )
  ).write as { effects: Array<{ type: string; radius: number; offsetY: number }> };
  assert.equal(one.effects.length, 1);
  assert.equal(one.effects[0].type, "INNER_SHADOW");
  assert.equal(one.effects[0].radius, 8);
  assert.equal(one.effects[0].offsetY, 2);
});

test("a grid keeps absent keys absent rather than zeroing them", () => {
  const write = ok(
    toFigmaValue(styleToken("grid", [{ pattern: "grid", sectionSize: { unit: "px", value: 8 } }], { styleType: "GRID" }))
  ).write as { grids: Array<Record<string, unknown>> };
  // `count: 0` on a GRID pattern is a value the importer would never write, and it would land in
  // Figma as a real, wrong setting rather than the "unset" it is meant to mean (ADR-0003 §3).
  assert.deepEqual(write.grids, [{ pattern: "GRID", sectionSize: 8 }]);
});

// ---------------------------------------------------------------------------
// Style guards — the styles apply refuses outright
// ---------------------------------------------------------------------------

test("a paint style with an extra invisible paint is refused, not silently trimmed", () => {
  // `style.paints` is replaced wholesale — Figma has no per-element write — so writing back a
  // token that only knows about the visible paint would delete the other one.
  const guards = styleGuards(
    styles({
      paint: [
        paintStyle("S:1", "Accent", [solid({ r: 1, g: 0, b: 0 }), solid({ r: 0, g: 0, b: 1 }, { visible: false })]),
        paintStyle("S:2", "Plain", [solid({ r: 1, g: 1, b: 1 })]),
      ],
    })
  );
  assert.equal(guards.get("S:1")?.reason, "apply-lossy-style");
  assert.equal(guards.has("S:2"), false);
});

test("an effect style mixing a blur with its shadows is refused", () => {
  const guards = styleGuards(
    styles({ effect: [effectStyle("S:3", "Card", [shadow("DROP_SHADOW"), blur()])] })
  );
  assert.equal(guards.get("S:3")?.reason, "apply-lossy-style");
});

test("a grid style of only known, visible patterns is applicable", () => {
  const guards = styleGuards(styles({ grid: [gridStyle("S:4", "12 col", [columnsGrid()])] }));
  assert.equal(guards.size, 0);
});

test("text styles never need a guard — they are written field by field", () => {
  assert.equal(styleGuards(styles({})).size, 0);
});

// ---------------------------------------------------------------------------
// Descriptions and removal
// ---------------------------------------------------------------------------

test("a description writes to whichever half of the provenance is present", () => {
  assert.equal(ok(toFigmaDescription(varToken("color", "#000000"), "hi")).write.kind, "variable-description");
  assert.equal(ok(toFigmaDescription(styleToken("color", "#000000"), "hi")).write.kind, "style-description");
});

test("removal names the Variable or the Style, and refuses without provenance", () => {
  assert.equal(ok(toFigmaRemoval(varToken("color", "#000000"))).write.kind, "variable-remove");
  assert.equal(ok(toFigmaRemoval(styleToken("color", "#000000"))).write.kind, "style-remove");
  const orphan = { $type: "color", $value: "#000", $extensions: { "com.tokenvault": { figma: {} } } };
  assert.equal(refusal(toFigmaRemoval(orphan as never)).reason, "no-provenance");
});
