import { test } from "node:test";
import assert from "node:assert/strict";

import { stableStringify } from "../src/tokens/serialize";

test("keys are alphabetical at every level, 2-space indented, with a trailing newline", () => {
  const output = stableStringify({ b: { d: 1, c: 2 }, a: 3 });
  assert.equal(output, '{\n  "a": 3,\n  "b": {\n    "c": 2,\n    "d": 1\n  }\n}\n');
});

test("numeric-looking keys sort alphabetically, not in JavaScript's integer-key order", () => {
  // This is the reason we cannot use JSON.stringify with a sorted replacer: JS objects
  // enumerate integer-like keys first, ascending, whatever the insertion order.
  const output = stableStringify({ "12": 1, base: 2, "4": 3, "8": 4 });
  assert.deepEqual(output.match(/"[^"]+":/g), ['"12":', '"4":', '"8":', '"base":']);
});

test("output is stable regardless of insertion order", () => {
  const a = stableStringify({ z: 1, a: { y: 2, b: 3 } });
  const b = stableStringify({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
});

test("undefined-valued keys are omitted, matching JSON.stringify", () => {
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{\n  "b": 1\n}\n');
});

test("empty objects and arrays stay inline", () => {
  assert.equal(stableStringify({ a: {}, b: [] }), '{\n  "a": {},\n  "b": []\n}\n');
});

test("arrays keep their order — array order is meaningful, key order is not", () => {
  assert.equal(stableStringify(["b", "a"]), '[\n  "b",\n  "a"\n]\n');
});

test("round-trips through JSON.parse unchanged", () => {
  const value = { a: [1, { b: "x" }], c: true, d: null, e: 0.5 };
  assert.deepEqual(JSON.parse(stableStringify(value)), value);
});

test("negative zero serializes as 0 so it round-trips to one literal", () => {
  assert.equal(stableStringify({ a: -0 }), '{\n  "a": 0\n}\n');
});

test("non-finite numbers throw rather than silently becoming null", () => {
  assert.throws(() => stableStringify({ a: Number.NaN }), /non-finite/);
});
