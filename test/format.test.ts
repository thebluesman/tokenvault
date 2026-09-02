// The shared value formatter.
//
// Five surfaces used to carry a private copy of this — the drift report sentence, the apply
// dialog's diff line, the Changes list, the delete confirmation and the detail view — and they had
// quietly drifted apart. One of them had lost the empty-string branch, so a string token set to
// `""` rendered as nothing at all on the one screen whose whole job is showing a value before it
// stops existing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { describeValue } from "../src/tokens/format";

test("an empty string says so, on every surface", () => {
  // Without this branch the row reads `#b4342a → ` and looks like a broken render rather than
  // like a value.
  assert.equal(describeValue(""), "empty");
  assert.equal(describeValue("", { unset: "unset" }), "empty");
  assert.equal(describeValue("", { limit: 8 }), "empty");
});

test("the absent placeholder is the caller's, because prose and table cells differ", () => {
  assert.equal(describeValue(undefined), "—");
  assert.equal(describeValue(undefined, { unset: "unset" }), "unset");
});

test("an object is serialized deterministically and flattened to one line", () => {
  assert.equal(describeValue({ b: 2, a: 1 }), '{ "a": 1, "b": 2 }');
});

test("truncation is opt-in and fits the stated budget, ellipsis included", () => {
  const long = describeValue({ colour: "#c33a2e", offsetX: 0, offsetY: 2, radius: 8 }, { limit: 20 });
  assert.equal(long.length, 20);
  assert.equal(long.endsWith("…"), true);
  // Under budget is left exactly as it is — no ellipsis on a value that fit.
  assert.equal(describeValue({ a: 1 }, { limit: 40 }), '{ "a": 1 }');
});

test("a scalar is its own string", () => {
  assert.equal(describeValue("#c33a2e"), "#c33a2e");
  assert.equal(describeValue(16), "16");
  assert.equal(describeValue(false), "false");
});
