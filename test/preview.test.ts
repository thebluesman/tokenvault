// One-line value previews — UX local-editor §4.5.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Token, TokenType } from "../src/tokens/types";
import { previewOf, truncateReference } from "../src/tokens/preview";

function token(type: TokenType, value: unknown): Token {
  return {
    $type: type,
    $value: value as Token["$value"],
    $extensions: { "com.tokenvault": { figma: { variableId: "v", modeId: "m" } } },
  };
}

test("a colour previews as its hex, with a swatch to paint", () => {
  const preview = previewOf(token("color", "#c33a2e33"));
  assert.equal(preview.text, "#c33a2e33");
  assert.equal(preview.swatch, "#c33a2e33");
  assert.equal(preview.reference, undefined);
});

test("a reference previews verbatim and asks for an outlined swatch, never a fill", () => {
  const preview = previewOf(token("color", "{folio.ref.palette.red-warm.50}"));
  assert.equal(preview.swatch, undefined, "we can't resolve it, so we must not claim to");
  assert.equal(preview.reference, "folio.ref.palette.red-warm.50");
  assert.match(preview.text, /^\{/);
});

test("a reference path truncates from the left — the tail carries the meaning", () => {
  const long = "folio.ref.palette.transparent.red-warm.50.30";
  const short = truncateReference(long);
  assert.equal(short.startsWith("…"), true);
  assert.equal(short.endsWith("50.30"), true);
  assert.ok(short.length <= 25);
  assert.equal(truncateReference("folio.a.b"), "folio.a.b", "a short path is untouched");
});

test("scalars preview as themselves", () => {
  assert.equal(previewOf(token("number", 16)).text, "16");
  assert.equal(previewOf(token("boolean", true)).text, "true");
  assert.equal(previewOf(token("boolean", false)).text, "false");
  assert.equal(previewOf(token("string", "ease-in")).text, '"ease-in"');
});

test("a long string is truncated rather than blowing the row width", () => {
  const preview = previewOf(token("string", "a".repeat(80)));
  assert.ok(preview.text.length < 40);
  assert.equal(preview.text.endsWith('…"'), true);
});

test("typography compresses to enough to tell two styles apart", () => {
  const preview = previewOf(
    token("typography", {
      fontFamily: "Urbanist",
      fontSize: { unit: "px", value: 20 },
      fontWeight: 500,
      letterSpacing: { unit: "em", value: 0 },
      lineHeight: { unit: "px", value: 24 },
    })
  );
  assert.equal(preview.text, "Urbanist 20/24 · 500");
});

test("an absent lineHeight reads as auto rather than as a missing value", () => {
  const preview = previewOf(
    token("typography", {
      fontFamily: "Urbanist",
      fontSize: { unit: "px", value: 20 },
      fontWeight: "Black Italic",
      letterSpacing: { unit: "em", value: 0 },
    })
  );
  assert.equal(preview.text, "Urbanist 20/auto · Black Italic");
});

test("shadow previews handle the object and the array form", () => {
  const shadow = {
    blur: { unit: "px", value: 4 },
    color: "#00000040",
    inset: false,
    offsetX: { unit: "px", value: 0 },
    offsetY: { unit: "px", value: 4 },
    spread: { unit: "px", value: 0 },
  };
  assert.equal(previewOf(token("shadow", shadow)).text, "0 4 4 #00000040");
  assert.equal(previewOf(token("shadow", [shadow, shadow])).text, "2 shadows");
  assert.equal(previewOf(token("shadow", { ...shadow, inset: true })).text.startsWith("inset "), true);
});

test("a grid previews as its pattern and geometry", () => {
  assert.equal(
    previewOf(
      token("grid", [{ pattern: "columns", count: 4, gutter: { unit: "px", value: 8 } }])
    ).text,
    "columns · 4 · 8px"
  );
  assert.equal(previewOf(token("grid", [])).text, "no grids");
});
