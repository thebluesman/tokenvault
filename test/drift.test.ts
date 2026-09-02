// Drift detection — ADR-0005 §7, §8.
//
// The load-bearing claim is the *negative* one: drift is the imported side moving, so a token that
// carries a local edit is not compared here at all. ADR-0004's three-way merge already reports it
// as `edit-conflict`, and a second mechanism that could disagree with the first about what
// "changed" means is precisely what §7 refused to build.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDrift, emptyDrift } from "../src/tokens/drift";
import { targetKey } from "../src/tokens/overlay";
import { flat, styleToken, varToken } from "./helpers";

const NONE = new Set<string>();

const LIGHT = { variableId: "VariableID:1:1", modeId: "1:0" };
const OTHER = { variableId: "VariableID:2:2", modeId: "1:0" };

test("a value Figma changed under an unedited token is drift-value", () => {
  const result = detectDrift(
    [flat("a.b", "Theme/Light", varToken("color", "#c33a2e", LIGHT))],
    [flat("a.b", "Theme/Light", varToken("color", "#b4342a", LIGHT))],
    NONE
  );

  assert.equal(result.entries.length, 1);
  assert.deepEqual(
    { ...result.entries[0], key: undefined },
    {
      kind: "drift-value",
      key: undefined,
      path: "a.b",
      set: "Theme/Light",
      reason: "value-changed",
      baseline: "#c33a2e",
      current: "#b4342a",
    }
  );
  assert.equal(result.keys.has(targetKey(LIGHT) as string), true);
});

test("an unchanged token produces nothing at all", () => {
  const token = varToken("color", "#c33a2e", LIGHT);
  const result = detectDrift([flat("a.b", "S", token)], [flat("a.b", "S", token)], NONE);
  assert.deepEqual(result.entries, []);
});

test("a token that also carries a local edit is left to the three-way merge", () => {
  // Reporting it here as well would put two badges with two different vocabularies on one value
  // line — and the conflict is the more precise thing to say, because it names both sides.
  const result = detectDrift(
    [flat("a.b", "S", varToken("color", "#c33a2e", LIGHT))],
    [flat("a.b", "S", varToken("color", "#b4342a", LIGHT))],
    new Set([targetKey(LIGHT) as string])
  );
  assert.deepEqual(result.entries, []);
});

test("a Variable that appeared since the baseline is drift-added", () => {
  const result = detectDrift(
    [],
    [flat("c.d", "Theme/Light", varToken("color", "#0d99ff", OTHER))],
    NONE
  );
  assert.equal(result.entries[0].kind, "drift-added");
  assert.equal(result.entries[0].current, "#0d99ff");
});

test("a Variable that disappeared since the baseline is drift-removed", () => {
  const result = detectDrift(
    [flat("c.d", "Theme/Light", varToken("color", "#0d99ff", OTHER))],
    [],
    NONE
  );
  assert.equal(result.entries[0].kind, "drift-removed");
  assert.equal(result.entries[0].baseline, "#0d99ff");
});

test("a renamed Variable is drift, not a remove plus an add — the key is the id, not the path", () => {
  // ADR-0004 §2's rule, holding on this side too: a designer renaming a variable moves the path
  // and not the id, and a path-keyed comparison would report a rename as a deletion.
  const result = detectDrift(
    [flat("old.name", "S", varToken("color", "#c33a2e", LIGHT))],
    [flat("new.name", "S", varToken("color", "#c33a2e", LIGHT))],
    NONE
  );
  assert.deepEqual(result.entries, []);
});

test("descriptions drift too, and say which half changed", () => {
  const before = varToken("color", "#c33a2e", LIGHT);
  const after = { ...varToken("color", "#c33a2e", LIGHT), $description: "Accent" };
  const result = detectDrift([flat("a.b", "S", before)], [flat("a.b", "S", after)], NONE);
  assert.equal(result.entries[0].reason, "description-changed");
  assert.match(result.report[0].message, /description/);
});

test("styles drift on their own provenance half", () => {
  const result = detectDrift(
    [flat("brand", "Styles/Paint", styleToken("color", "#c33a2e"))],
    [flat("brand", "Styles/Paint", styleToken("color", "#b4342a"))],
    NONE
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].key, targetKey({ styleId: "S:abc" }));
});

test("composite values compare structurally, so key order alone is not drift", () => {
  // Routed through the same serializer as everything else, so "equal" means "byte-identical when
  // written to disk" (ADR-0002 §7) and the comparator can never disagree with a diff.
  const a = styleToken("shadow", { blur: { unit: "px", value: 8 }, color: "#00000029", inset: false });
  const b = styleToken("shadow", { color: "#00000029", inset: false, blur: { unit: "px", value: 8 } });
  assert.deepEqual(detectDrift([flat("s", "S", a)], [flat("s", "S", b)], NONE).entries, []);
});

test("the report never says the word drift", () => {
  // UX §3: a designer doesn't think "this token has drifted", they think "someone changed it in
  // Figma". `drift` stays in code, ADRs and the report's kind slug — never in a sentence.
  const result = detectDrift(
    [flat("a.b", "S", varToken("color", "#c33a2e", LIGHT))],
    [flat("a.b", "S", varToken("color", "#b4342a", LIGHT))],
    NONE
  );
  for (const row of result.report) {
    assert.equal(/drift/i.test(row.message), false, row.message);
    assert.match(row.kind, /^drift-/);
  }
});

test("entries come back in a deterministic order", () => {
  const result = detectDrift(
    [],
    [
      flat("z.last", "S", varToken("color", "#000000", { variableId: "VariableID:9:9" })),
      flat("a.first", "S", varToken("color", "#000000", { variableId: "VariableID:8:8" })),
    ],
    NONE
  );
  assert.deepEqual(result.entries.map((each) => each.path), ["a.first", "z.last"]);
});

test("emptyDrift is the no-baseline shape, and is not the same claim as no drift", () => {
  // §8's corollary: a missing import cache means drift is *unknown*. The caller distinguishes the
  // two — this only guarantees the empty value carries no entries to mistake for an all-clear.
  const empty = emptyDrift();
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.keys.size, 0);
});
