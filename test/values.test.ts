import { test } from "node:test";
import assert from "node:assert/strict";

import { isAlias, isRgba, normalizeFloat, rgbaToHex, toReference } from "../src/tokens/values";

test("opaque colours are #rrggbb, translucent ones #rrggbbaa", () => {
  assert.equal(rgbaToHex({ r: 0, g: 0, b: 0 }), "#000000");
  assert.equal(rgbaToHex({ r: 1, g: 1, b: 1, a: 1 }), "#ffffff");
  assert.equal(rgbaToHex({ r: 0, g: 0, b: 0, a: 0.5 }), "#00000080");
  assert.equal(rgbaToHex({ r: 0, g: 0, b: 0, a: 0 }), "#00000000");
});

test("8-bit hex authored in Figma's UI round-trips exactly", () => {
  // #2d7ff9 as Figma stores it.
  assert.equal(rgbaToHex({ r: 45 / 255, g: 127 / 255, b: 249 / 255 }), "#2d7ff9");
});

test("out-of-range channels are clamped rather than producing invalid hex", () => {
  assert.equal(rgbaToHex({ r: 1.4, g: -0.2, b: 0.5 }), "#ff0080");
});

test("toReference turns a Figma name into a mode-free dotted reference", () => {
  assert.equal(toReference("tv/ref/palette/blue-500"), "{tv.ref.palette.blue-500}");
  assert.equal(toReference("/a//b/"), "{a.b}");
});

test("isAlias only accepts a well-formed VARIABLE_ALIAS", () => {
  assert.equal(isAlias({ type: "VARIABLE_ALIAS", id: "VariableID:1:2" }), true);
  assert.equal(isAlias({ r: 0, g: 0, b: 0 }), false);
  assert.equal(isAlias("VARIABLE_ALIAS"), false);
  assert.equal(isAlias(null), false);
});

test("isRgba accepts RGB and RGBA, rejects aliases", () => {
  assert.equal(isRgba({ r: 0, g: 0, b: 0 }), true);
  assert.equal(isRgba({ r: 0, g: 0, b: 0, a: 0.2 }), true);
  assert.equal(isRgba({ type: "VARIABLE_ALIAS", id: "x" }), false);
  assert.equal(isRgba(4), false);
});

test("float32 storage noise is recovered to the decimal a human typed", () => {
  // Figma hands back the double nearest to float32(0.4) — writing that verbatim would make
  // every numeric token unreadable and every Figma re-save a spurious git diff.
  assert.equal(normalizeFloat(0.4000000059604645), 0.4);
  assert.equal(normalizeFloat(0.10000000149011612), 0.1);
  assert.equal(normalizeFloat(0.699999988079071), 0.7);
  assert.equal(normalizeFloat(1.5), 1.5);
});

test("normalizing a float never changes the value Figma would store back", () => {
  for (const raw of [0.4000000059604645, 0.10000000149011612, 0.699999988079071, 0.3333333432674408]) {
    assert.equal(Math.fround(normalizeFloat(raw)), Math.fround(raw));
  }
});

test("integers and non-finite values pass through untouched", () => {
  assert.equal(normalizeFloat(150), 150);
  assert.equal(normalizeFloat(0), 0);
  assert.equal(normalizeFloat(-24), -24);
  assert.equal(Number.isNaN(normalizeFloat(Number.NaN)), true);
});
