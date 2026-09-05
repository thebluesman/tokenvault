// Value parsing and validation for the local editor — UX local-editor §5.2, §8.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clearLineHeight,
  denormalizeShadows,
  dimensionUnit,
  formatDimension,
  gridFieldsFor,
  gridList,
  isPointerValue,
  newShadow,
  parseDimension,
  parseHexColor,
  parseNumberValue,
  parseStringValue,
  setGridField,
  setGridPattern,
  setShadowField,
  setTypographyField,
  shadowList,
  subtypeWarning,
  withDescription,
  withValue,
} from "../src/tokens/edit";
import type { GridValue, ShadowValue, Token, TypographyValue } from "../src/tokens/types";

function expectOk<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return (result as { ok: true; value: T }).value;
}

function expectFail(result: { ok: boolean; message?: string }): string {
  assert.equal(result.ok, false);
  return (result as { ok: false; message: string }).message;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

test("hex is normalized to the form the importer emits", () => {
  assert.equal(expectOk(parseHexColor("#C33A2E")), "#c33a2e");
  assert.equal(expectOk(parseHexColor("c33a2e")), "#c33a2e");
  assert.equal(expectOk(parseHexColor("  #C33A2E  ")), "#c33a2e");
  assert.equal(expectOk(parseHexColor("#00000040")), "#00000040");
});

test("shorthand hex expands", () => {
  assert.equal(expectOk(parseHexColor("#fff")), "#ffffff");
  assert.equal(expectOk(parseHexColor("#f00a")), "#ff0000aa");
});

test("a fully opaque 8-digit hex trims to 6, so retyping it produces no diff", () => {
  assert.equal(expectOk(parseHexColor("#C33A2EFF")), "#c33a2e");
});

test("anything that is not a hex colour is rejected with the UX §8 message", () => {
  assert.match(expectFail(parseHexColor("rgb(1,2,3)")), /Use #RRGGBB/);
  expectFail(parseHexColor("#12345"));
  expectFail(parseHexColor(""));
});

// ---------------------------------------------------------------------------
// Numbers and strings
// ---------------------------------------------------------------------------

test("numbers must be finite", () => {
  assert.equal(expectOk(parseNumberValue(" 16 ")), 16);
  assert.equal(expectOk(parseNumberValue("-0.5")), -0.5);
  expectFail(parseNumberValue("sixteen"));
  expectFail(parseNumberValue("Infinity"));
  expectFail(parseNumberValue(""));
});

test("strings must be non-empty", () => {
  assert.equal(expectOk(parseStringValue("ease-in")), "ease-in");
  expectFail(parseStringValue("   "));
});

test("a value contradicting its subtype warns but does not block", () => {
  assert.match(subtypeWarning("opacity", 4) ?? "", /usually 0–1/);
  assert.equal(subtypeWarning("opacity", 0.4), null);
  assert.match(subtypeWarning("radius", -2) ?? "", /not usually negative/);
  assert.equal(subtypeWarning("spacing", -2), null, "negative spacing is legitimate");
  assert.equal(subtypeWarning(undefined, 999), null);
});

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

const TYPOGRAPHY: TypographyValue = {
  fontFamily: "Urbanist",
  fontSize: { unit: "px", value: 20 },
  fontWeight: 500,
  letterSpacing: { unit: "em", value: 0 },
  lineHeight: { unit: "px", value: 24 },
};

test("editing one typography field leaves every other key untouched", () => {
  const next = expectOk(setTypographyField(TYPOGRAPHY, "fontSize", "24"));
  assert.deepEqual(next.fontSize, { unit: "px", value: 24 });
  assert.deepEqual(next.letterSpacing, TYPOGRAPHY.letterSpacing);
  assert.equal(next.fontFamily, "Urbanist");
});

test("fontWeight keeps its number | string union", () => {
  assert.equal(expectOk(setTypographyField(TYPOGRAPHY, "fontWeight", "700")).fontWeight, 700);
  assert.equal(
    expectOk(setTypographyField(TYPOGRAPHY, "fontWeight", "Black Italic")).fontWeight,
    "Black Italic"
  );
});

test("Auto removes lineHeight entirely rather than writing a sentinel", () => {
  const cleared = clearLineHeight(TYPOGRAPHY);
  assert.equal("lineHeight" in cleared, false);
  const blanked = expectOk(setTypographyField(TYPOGRAPHY, "lineHeight", "  "));
  assert.equal("lineHeight" in blanked, false);
});

test("a dimension edit keeps the existing unit unless one is named", () => {
  assert.equal(dimensionUnit(TYPOGRAPHY.letterSpacing), "em");
  assert.deepEqual(expectOk(setTypographyField(TYPOGRAPHY, "letterSpacing", "0.5")).letterSpacing, {
    unit: "em",
    value: 0.5,
  });
  assert.deepEqual(
    expectOk(setTypographyField(TYPOGRAPHY, "letterSpacing", "2", "px")).letterSpacing,
    { unit: "px", value: 2 }
  );
});

test("an unparseable typography field is rejected, not coerced", () => {
  expectFail(setTypographyField(TYPOGRAPHY, "fontSize", "big"));
  expectFail(setTypographyField(TYPOGRAPHY, "fontFamily", ""));
});

test("formatDimension and parseDimension round-trip", () => {
  assert.equal(formatDimension({ unit: "px", value: 24 }), "24");
  assert.equal(formatDimension(undefined), "");
  assert.deepEqual(expectOk(parseDimension("24", "px")), { unit: "px", value: 24 });
});

// ---------------------------------------------------------------------------
// Shadow
// ---------------------------------------------------------------------------

const SHADOW: ShadowValue = {
  blur: { unit: "px", value: 8 },
  color: "#00000029",
  inset: false,
  offsetX: { unit: "px", value: 0 },
  offsetY: { unit: "px", value: 2 },
  spread: { unit: "px", value: 0 },
};

test("a shadow $value is read as a list whether it is an object or an array", () => {
  assert.equal(shadowList(SHADOW as never).length, 1);
  assert.equal(shadowList([SHADOW, SHADOW] as never).length, 2);
});

test("one shadow stays a bare object; more than one becomes an array", () => {
  assert.deepEqual(denormalizeShadows([SHADOW]), SHADOW);
  assert.equal(Array.isArray(denormalizeShadows([SHADOW, SHADOW])), true);
});

test("editing a shadow field keeps the rest of the shadow", () => {
  const next = expectOk(setShadowField(SHADOW, "offsetY", "4"));
  assert.deepEqual(next.offsetY, { unit: "px", value: 4 });
  assert.equal(next.color, "#00000029");
  assert.equal(expectOk(setShadowField(SHADOW, "inset", "true")).inset, true);
  assert.equal(expectOk(setShadowField(SHADOW, "color", "#FFF")).color, "#ffffff");
});

// UX §14.2 retires Phase 7's blanket sub-key refusal for a shadow colour: it takes a pointer now,
// stored verbatim, exactly as §4.1's colour rule stores one on a whole token.
test("a shadow colour keeps a reference verbatim", () => {
  const next = expectOk(setShadowField(SHADOW, "color", "{folio.ref.palette.black}"));
  assert.equal(next.color, "{folio.ref.palette.black}");
});

test("a new shadow is a complete DTCG shadow", () => {
  const shadow = newShadow();
  for (const key of ["blur", "color", "inset", "offsetX", "offsetY", "spread"]) {
    assert.equal(key in shadow, true, `new shadow is missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

const COLUMNS: GridValue = {
  pattern: "columns",
  alignment: "STRETCH",
  count: 12,
  gutter: { unit: "px", value: 16 },
  offset: { unit: "px", value: 24 },
};

test("grid fields are constrained by pattern", () => {
  assert.deepEqual(gridFieldsFor("grid"), ["sectionSize"]);
  expectFail(setGridField(COLUMNS, "sectionSize", "8"));
});

test("switching a grid to `grid` removes count and alignment rather than zeroing them", () => {
  const next = setGridPattern(COLUMNS, "grid");
  assert.equal(next.pattern, "grid");
  assert.equal("count" in next, false);
  assert.equal("alignment" in next, false);
  assert.equal("gutter" in next, false);
});

test("switching between columns and rows keeps the shared keys", () => {
  const next = setGridPattern(COLUMNS, "rows");
  assert.equal(next.count, 12);
  assert.deepEqual(next.gutter, { unit: "px", value: 16 });
});

test("blanking a grid field removes the key, keeping absent keys absent", () => {
  const next = expectOk(setGridField(COLUMNS, "offset", ""));
  assert.equal("offset" in next, false);
});

test("gridList tolerates a non-array value", () => {
  assert.deepEqual(gridList([COLUMNS] as never), [COLUMNS]);
  assert.deepEqual(gridList(4 as never), []);
});

// ---------------------------------------------------------------------------
// Writing back
// ---------------------------------------------------------------------------

const TOKEN: Token = {
  $type: "color",
  $value: "#c33a2e",
  $extensions: {
    "com.tokenvault": {
      figma: { variableId: "VariableID:1:4", modeId: "1:0", collectionId: "c", scopes: ["ALL"] },
    },
  },
};

test("an edit carries $extensions across by reference — ADR-0002 §7's round-trip key", () => {
  const next = withValue(TOKEN, "#000000");
  assert.equal(next.$value, "#000000");
  assert.equal(
    next.$extensions["com.tokenvault"],
    TOKEN.$extensions["com.tokenvault"],
    "provenance must not be rebuilt by an edit"
  );
});

test("an empty description removes the key rather than writing an empty string", () => {
  const described = withDescription(TOKEN, "the accent border");
  assert.equal(described.$description, "the accent border");
  assert.equal("$description" in withDescription(described, "  "), false);
});

test("a reference value is read-only in Phase 4", () => {
  // Phase 7 lifted the read-only rule; what survives is the shape question the per-type editors
  // ask — an inert swatch beside a pointer, a readout position on a boolean (UX §4.1).
  assert.equal(isPointerValue(TOKEN), false);
  assert.equal(isPointerValue({ ...TOKEN, $value: "{folio.ref.red.50}" }), true);
});
