// Path derivation inside the build — ADR-0002 Amendment 2 §A, §C, §D, §F, §I.
//
// The rules module is tested in isolation next door; this is the half that matters to the acceptance
// criteria: that a rule changes the *path* and nothing else. Identity keys on `figma.variableId`
// (§A), references move with their targets (§D), exclusions are aggregated (§I), and a rule-free
// build is byte-identical to Phase 2's.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImport } from "../src/tokens/build";
import { stableStringify } from "../src/tokens/serialize";
import type { PathRule } from "../src/tokens/rules";
import type { Token, TokenGroup } from "../src/tokens/types";
import { IMPORTED_AT, alias, collection, fileAt, snapshot, tokenAt, variable } from "./helpers";

const CORE = collection("VariableCollectionId:1:1", "Core", [["1:0", "Value"]]);

function rule(id: string, match: PathRule["match"], action: PathRule["action"]): PathRule {
  return { id, enabled: true, match, action };
}

const STRIP_XYZ = rule("strip-xyz", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" });

function build(variables: Parameters<typeof snapshot>[1], pathRules: PathRule[] = []) {
  return buildImport(snapshot([CORE], variables), { importedAt: IMPORTED_AT, pathRules });
}

function coreTree(result: ReturnType<typeof build>): TokenGroup {
  return fileAt(result.files, "tokens/core/value.json");
}

// ---------------------------------------------------------------------------
// §A — source name and token path are two things
// ---------------------------------------------------------------------------

test("the token path is pathRules(sourceName), not the Figma name", () => {
  const result = build(
    [variable("VariableID:1:10", "xyz/base/color/bg/primary", CORE.id, "COLOR", { "1:0": { r: 1, g: 0, b: 0 } })],
    [STRIP_XYZ]
  );
  const tree = coreTree(result);
  assert.notEqual(tokenAt(tree, "base.color.bg.primary"), undefined);
  assert.equal(tokenAt(tree, "xyz.base.color.bg.primary"), undefined);
});

test("identity still keys on variableId, so a rule change cannot break re-import matching", () => {
  // §A's load-bearing claim: rules cannot break re-import matching, drift detection or apply
  // targeting, all of which key on the id rather than on the path.
  const variables = [
    variable("VariableID:1:10", "xyz/base/space/4", CORE.id, "FLOAT", { "1:0": 4 }),
  ];
  const before = tokenAt(coreTree(build(variables)), "xyz.base.space.4") as Token;
  const after = tokenAt(coreTree(build(variables, [STRIP_XYZ])), "base.space.4") as Token;

  const idOf = (token: Token): unknown => token.$extensions["com.tokenvault"].figma.variableId;
  assert.equal(idOf(before), "VariableID:1:10");
  assert.equal(idOf(after), idOf(before));
  // Nothing on the token records which rules produced its path — that is what "re-evaluated live"
  // means, and it is what keeps §7's determinism intact.
  assert.equal(JSON.stringify(after).indexOf("strip-xyz"), -1);
});

test("a rule-free build is byte-identical to what Phase 2 wrote", () => {
  const variables = [variable("VariableID:1:10", "a/b/c", CORE.id, "FLOAT", { "1:0": 4 })];
  assert.equal(
    stableStringify(coreTree(build(variables, []))),
    stableStringify(coreTree(build(variables)))
  );
  // And no `$rules.json` appears in a file that has no rules — an absent file is a truthful "none".
  assert.equal(build(variables).files.some((file) => file.path.endsWith("$rules.json")), false);
});

// ---------------------------------------------------------------------------
// §D — references go through the same function
// ---------------------------------------------------------------------------

test("a reference is rewritten by the same pipeline as its target's path", () => {
  // §D is the load-bearing consequence of the whole amendment: if paths move and references do
  // not, every alias in the file dangles.
  const result = build(
    [
      variable("VariableID:1:10", "xyz/base/color/black", CORE.id, "COLOR", { "1:0": { r: 0, g: 0, b: 0 } }),
      variable("VariableID:1:11", "xyz/semantic/color/text", CORE.id, "COLOR", {
        "1:0": alias("VariableID:1:10"),
      }),
    ],
    [STRIP_XYZ]
  );

  const referrer = tokenAt(coreTree(result), "semantic.color.text") as Token;
  assert.equal(referrer.$value, "{base.color.black}");
  // No dangling entry, because both ends moved together.
  assert.equal(result.report.entries.some((entry) => entry.kind === "dangling-reference"), false);
});

test("an alias into a team library is transformed too, so both ends stay in step", () => {
  const result = buildImport(
    snapshot(
      [CORE],
      [
        variable("VariableID:1:11", "xyz/semantic/color/text", CORE.id, "COLOR", {
          "1:0": alias("VariableID:9:9"),
        }),
      ],
      { "VariableID:9:9": "xyz/library/black" }
    ),
    { importedAt: IMPORTED_AT, pathRules: [STRIP_XYZ] }
  );

  const referrer = tokenAt(coreTree(result), "semantic.color.text") as Token;
  assert.equal(referrer.$value, "{library.black}");
});

// ---------------------------------------------------------------------------
// §I — exclusion
// ---------------------------------------------------------------------------

test("an excluded variable produces no token anywhere", () => {
  const result = build(
    [
      variable("VariableID:1:10", "*/scaffolding/thing", CORE.id, "FLOAT", { "1:0": 1 }),
      variable("VariableID:1:11", "real/thing", CORE.id, "FLOAT", { "1:0": 2 }),
    ],
    [rule("drop-scaffolding", { kind: "segment", value: "*" }, { kind: "exclude" })]
  );

  assert.equal(tokenAt(coreTree(result), "real.thing")?.$value, 2);
  assert.equal(result.counts.tokens, 1);
  // Nothing in any set file, and nothing in the manifest either (§I).
  assert.equal(JSON.stringify(coreTree(result)).indexOf("scaffolding"), -1);
  assert.equal(JSON.stringify(result.manifest).indexOf("scaffolding"), -1);
});

test("exclusions are reported in aggregate — one entry per rule, with a count", () => {
  // §I: a file that excludes 400 scaffolding variables must not produce 400 report entries; that
  // is how a report stops being read.
  const variables = [];
  for (let i = 0; i < 12; i += 1) {
    variables.push(variable(`VariableID:1:${i}`, `*/junk/${i}`, CORE.id, "FLOAT", { "1:0": i }));
  }
  const result = build(variables, [
    rule("drop-scaffolding", { kind: "segment", value: "*" }, { kind: "exclude" }),
  ]);

  const excluded = result.report.entries.filter((entry) => entry.reason === "excluded");
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].kind, "path-rule");
  assert.equal(excluded[0].ruleId, "drop-scaffolding");
  assert.equal(excluded[0].count, 12);
});

test("a reference to an excluded variable is still written, and reported as its own reason", () => {
  // Import stays lossless and non-refusing (Amendment 3 §B). Only the push refuses.
  const result = build(
    [
      variable("VariableID:1:10", "*/base/black", CORE.id, "COLOR", { "1:0": { r: 0, g: 0, b: 0 } }),
      variable("VariableID:1:11", "semantic/text", CORE.id, "COLOR", { "1:0": alias("VariableID:1:10") }),
    ],
    [rule("drop-scaffolding", { kind: "segment", value: "*" }, { kind: "exclude" })]
  );

  const referrer = tokenAt(coreTree(result), "semantic.text") as Token;
  assert.equal(referrer.$value, "{*.base.black}");

  const dangling = result.report.entries.filter((entry) => entry.kind === "dangling-reference");
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].reason, "alias-target-excluded");
  assert.equal(dangling[0].message.indexOf("drop-scaffolding") !== -1, true);
});

// ---------------------------------------------------------------------------
// §C — invalid results and rule-induced collisions
// ---------------------------------------------------------------------------

test("a rule producing an unusable path is skipped for that variable and named", () => {
  const result = build(
    [
      variable("VariableID:1:10", "xyz", CORE.id, "FLOAT", { "1:0": 1 }),
      variable("VariableID:1:11", "xyz/kept", CORE.id, "FLOAT", { "1:0": 2 }),
    ],
    [STRIP_XYZ]
  );

  // The one whose path would have emptied keeps its Figma name; the other still transforms.
  assert.equal(tokenAt(coreTree(result), "xyz")?.$value, 1);
  assert.equal(tokenAt(coreTree(result), "kept")?.$value, 2);

  const entry = result.report.entries.find((item) => item.reason === "invalid-result");
  assert.notEqual(entry, undefined);
  assert.equal(entry?.kind, "path-rule");
  assert.equal(entry?.message.indexOf("strip-xyz") !== -1, true);
});

test("a rule-induced clash arrives at the existing collision detector, naming both Figma names", () => {
  // §C: rules *create* collisions, and they must arrive as ordinary collisions rather than as a
  // new failure mode. The participant's `sourceName` is what makes the report readable when
  // neither variable is *named* the contested path.
  const result = build(
    [
      variable("VariableID:1:10", "xyz/color/bg", CORE.id, "COLOR", { "1:0": { r: 1, g: 0, b: 0 } }),
      variable("VariableID:1:11", "color/bg", CORE.id, "COLOR", { "1:0": { r: 0, g: 1, b: 0 } }),
    ],
    [STRIP_XYZ]
  );

  const collisions = result.report.entries.filter((entry) => entry.kind === "collision");
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].path, "color.bg");
  const named = (collisions[0].participants ?? []).find(
    (participant) => participant.variableId === "VariableID:1:10"
  );
  assert.equal(named?.sourceName, "xyz/color/bg");
  // The unmoved participant carries no `sourceName`, so a rule-free report keeps Phase 2's bytes.
  const other = (collisions[0].participants ?? []).find(
    (participant) => participant.variableId === "VariableID:1:11"
  );
  assert.equal(other?.sourceName, undefined);
});

test("a rule that cannot run is reported once, file-scoped, and then ignored", () => {
  const result = build(
    [variable("VariableID:1:10", "a/b", CORE.id, "FLOAT", { "1:0": 1 })],
    [rule("broken", { kind: "name", pattern: "([" }, { kind: "drop-matched-segments" })]
  );

  const issues = result.report.entries.filter((entry) => entry.reason === "bad-match-pattern");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "path-rule");
  assert.equal(tokenAt(coreTree(result), "a.b")?.$value, 1);
});

// ---------------------------------------------------------------------------
// §F — the rule set is committed
// ---------------------------------------------------------------------------

test("a configured rule set is written to tokens/$rules.json alongside the manifest", () => {
  const result = build([variable("VariableID:1:10", "xyz/a", CORE.id, "FLOAT", { "1:0": 1 })], [STRIP_XYZ]);
  const file = result.files.find((item) => item.path === "tokens/$rules.json");
  assert.notEqual(file, undefined);
  assert.deepEqual(file?.content, {
    version: 1,
    generatedBy: "tokenvault",
    pathRules: [STRIP_XYZ],
  });
});
