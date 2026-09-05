// The rule-edit preview — ADR-0002 Amendment 2 §G, §I.
//
// §G's requirement is that a rule-set edit is never saved without a preview, because editing one
// rule can move every matching token's path at once and the user should not learn what they did
// after committing it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { previewRuleChange } from "../src/tokens/rulePreview";
import type { PathRule } from "../src/tokens/rules";
import { alias, variable } from "./helpers";

const COLLECTION = "VariableCollectionId:1:1";

const STRIP_XYZ: PathRule = {
  id: "strip-xyz",
  enabled: true,
  match: { kind: "segment", value: "xyz" },
  action: { kind: "drop-matched-segments" },
};

const EXCLUDE_STAR: PathRule = {
  id: "drop-scaffolding",
  enabled: true,
  match: { kind: "segment", value: "*" },
  action: { kind: "exclude" },
};

function num(id: string, name: string, value = 1) {
  return variable(id, name, COLLECTION, "FLOAT", { "1:0": value });
}

test("the preview lists every path the edit moves, with stable ids on both sides", () => {
  // Ids are stable across the change (§A), which is the only reason a `from → to` list is
  // computable at all.
  const preview = previewRuleChange(
    [num("VariableID:1:10", "xyz/a/b"), num("VariableID:1:11", "c/d")],
    [],
    [STRIP_XYZ]
  );

  assert.deepEqual(preview.remaps, [{ variableId: "VariableID:1:10", from: "xyz.a.b", to: "a.b" }]);
});

test("it counts the references that get rewritten as a consequence", () => {
  // §D moves both ends together, so the count is what tells the user how much of the tree the
  // edit touches beyond the renamed rows themselves.
  const preview = previewRuleChange(
    [
      num("VariableID:1:10", "xyz/base/black"),
      variable("VariableID:1:11", "semantic/text", COLLECTION, "COLOR", {
        "1:0": alias("VariableID:1:10"),
      }),
    ],
    [],
    [STRIP_XYZ]
  );

  assert.equal(preview.remaps.length, 1);
  assert.equal(preview.referencesRewritten, 1);
});

test("exclusions are counted per rule before the write, not discovered after it", () => {
  // §I: "this rule excludes 412 variables" is the number that has to be visible *before* the
  // write, because afterwards those variables are simply absent and the mistake is invisible.
  const variables = [];
  for (let i = 0; i < 5; i += 1) variables.push(num(`VariableID:1:${i}`, `*/junk/${i}`));
  variables.push(num("VariableID:1:99", "real/thing"));

  const preview = previewRuleChange(variables, [], [EXCLUDE_STAR]);
  assert.deepEqual(preview.excluded, [{ ruleId: "drop-scaffolding", count: 5 }]);
  assert.equal(preview.remaps.length, 0);
});

test("it names the references an exclusion would strand", () => {
  const preview = previewRuleChange(
    [
      num("VariableID:1:10", "*/base/black"),
      variable("VariableID:1:11", "semantic/text", COLLECTION, "COLOR", {
        "1:0": alias("VariableID:1:10"),
      }),
    ],
    [],
    [EXCLUDE_STAR]
  );

  assert.equal(preview.dangling.length, 1);
  assert.equal(preview.dangling[0].targetPath, "*.base.black");
  assert.equal(preview.dangling[0].referrerPath, "semantic.text");
  assert.equal(preview.dangling[0].ruleId, "drop-scaffolding");
});

test("removing an exclusion is a restoration, not a rename", () => {
  const variables = [num("VariableID:1:10", "*/junk/1")];
  const preview = previewRuleChange(variables, [EXCLUDE_STAR], []);
  assert.equal(preview.restored, 1);
  assert.deepEqual(preview.remaps, []);
  assert.deepEqual(preview.excluded, []);
});

test("new collisions are reported, and do not stop the rule being saved", () => {
  // §C and §5: it can still be saved with collisions present — a second rule may be the fix —
  // but it is never applied silently.
  const preview = previewRuleChange(
    [num("VariableID:1:10", "xyz/color/bg"), num("VariableID:1:11", "color/bg")],
    [],
    [STRIP_XYZ]
  );

  assert.deepEqual(preview.newCollisions, ["color.bg"]);
});

test("a collision that already existed is not blamed on the edit", () => {
  const variables = [num("VariableID:1:10", "color/bg"), num("VariableID:1:11", "Color/BG")];
  const preview = previewRuleChange(variables, [], [STRIP_XYZ]);
  assert.deepEqual(preview.newCollisions, []);
});

test("the preview carries the same rule problems the build would report", () => {
  const preview = previewRuleChange(
    [num("VariableID:1:10", "a/b")],
    [],
    [{ id: "broken", enabled: true, match: { kind: "name", pattern: "([" }, action: { kind: "exclude" } }]
  );
  assert.deepEqual(preview.issues.map((issue) => issue.reason), ["bad-match-pattern"]);
  // A broken rule is dropped, so it excludes nothing rather than excluding everything.
  assert.deepEqual(preview.excluded, []);
});

test("a variable a rule cannot path is listed rather than silently kept", () => {
  const preview = previewRuleChange([num("VariableID:1:10", "xyz")], [], [STRIP_XYZ]);
  assert.deepEqual(preview.invalid, [
    { variableId: "VariableID:1:10", ruleId: "strip-xyz", reason: "empty-path" },
  ]);
});

test("a no-op edit previews as no change at all", () => {
  const preview = previewRuleChange([num("VariableID:1:10", "a/b")], [STRIP_XYZ], [STRIP_XYZ]);
  assert.deepEqual(preview.remaps, []);
  assert.equal(preview.referencesRewritten, 0);
  assert.deepEqual(preview.dangling, []);
  assert.deepEqual(preview.newCollisions, []);
});
