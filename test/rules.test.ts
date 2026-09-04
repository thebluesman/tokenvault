// The shared matcher and the path-rule pipeline — ADR-0002 Amendment 2 §A, §B, §C, §F, §I.
//
// This is the matcher ADR-0008 §Context requires routing to reuse, so anything asserted here is
// also an assertion about how a routing rule matches. That is the point of the shared module: two
// matchers that could disagree about what `segment: "abc"` means would be a bug invisible from
// either side.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPathRules,
  derivePath,
  makeRuleSetFile,
  matchedSegments,
  matchesName,
  parseRuleSet,
  rulesEqual,
  usableRules,
  validateRules,
  type PathRule,
} from "../src/tokens/rules";

function rule(id: string, match: PathRule["match"], action: PathRule["action"]): PathRule {
  return { id, enabled: true, match, action };
}

// ---------------------------------------------------------------------------
// The matcher — §A
// ---------------------------------------------------------------------------

test("a segment match is a segment, not a substring", () => {
  // The whole reason `segment` exists beside `name`: `xyz` must not match `xyzzy`, and a name
  // carrying `.` or `(` must need no escaping.
  const match = { kind: "segment" as const, value: "xyz" };
  assert.equal(matchesName(match, "xyz/base/color"), true);
  assert.equal(matchesName(match, "a/xyz/b"), true);
  assert.equal(matchesName(match, "xyzzy/base"), false);
  assert.equal(matchesName(match, "base/color"), false);
  assert.equal(matchesName({ kind: "segment", value: "a.b(c)" }, "x/a.b(c)/y"), true);
});

test("segment matching is case-insensitive unless the rule says otherwise", () => {
  assert.equal(matchesName({ kind: "segment", value: "XYZ" }, "xyz/base"), true);
  assert.equal(
    matchesName({ kind: "segment", value: "XYZ", caseSensitive: true }, "xyz/base"),
    false
  );
});

test("a name match is a regex over the whole /-delimited name", () => {
  const match = { kind: "name" as const, pattern: "^semantic/.*/(ios|android)$" };
  assert.equal(matchesName(match, "semantic/typography/ios"), true);
  assert.equal(matchesName(match, "semantic/typography/web"), false);
});

test("an uncompilable pattern matches nothing rather than throwing", () => {
  // It is still reported — `validateRules` is what stops it being a silently inert rule.
  assert.equal(matchesName({ kind: "name", pattern: "([" }, "anything"), false);
});

test("a name match selects the segments its match actually covers", () => {
  // Segment-level actions need a well-defined selection even when the gate is a whole-name regex.
  assert.deepEqual(matchedSegments({ kind: "name", pattern: "base" }, "xyz/base/color"), [1]);
  assert.deepEqual(matchedSegments({ kind: "name", pattern: "^xyz/base" }, "xyz/base/color"), [0, 1]);
  assert.deepEqual(matchedSegments({ kind: "name", pattern: "^.*$" }, "a/b/c"), [0, 1, 2]);
});

// ---------------------------------------------------------------------------
// The four actions — §B
// ---------------------------------------------------------------------------

test("drop-matched-segments removes every matched segment, wherever it occurs", () => {
  const rules = [rule("strip", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" })];
  assert.equal(derivePath("xyz/base/color/bg/primary", rules).path, "base.color.bg.primary");
  assert.equal(derivePath("semantic/typography/xyz/title", rules).path, "semantic.typography.title");
  assert.equal(derivePath("a/xyz/b/xyz/c", rules).path, "a.b.c");
});

test("replace-segment rewrites matched segments to a literal, splitting on /", () => {
  assert.equal(
    derivePath("xyz/color", [
      rule("rename", { kind: "segment", value: "xyz" }, { kind: "replace-segment", with: "brand" }),
    ]).path,
    "brand.color"
  );
  // A `/` in the replacement is insertion, which §B says needs no action of its own.
  assert.equal(
    derivePath("xyz/color", [
      rule("expand", { kind: "segment", value: "xyz" }, { kind: "replace-segment", with: "a/b" }),
    ]).path,
    "a.b.color"
  );
});

test("rewrite is the general form, and prepending is one of its cases", () => {
  // §B's own example: insertion needs no fifth action.
  const rules = [
    rule(
      "brand",
      { kind: "name", pattern: "^color/" },
      { kind: "rewrite", pattern: "^color/(.*)$", replacement: "brand/color/$1" }
    ),
  ];
  assert.equal(derivePath("color/bg/primary", rules).path, "brand.color.bg.primary");
  assert.equal(derivePath("space/4", rules).path, "space.4");
});

test("exclude means no token at all, and short-circuits the pipeline", () => {
  const rules = [
    rule("drop-scaffolding", { kind: "segment", value: "*" }, { kind: "exclude" }),
    rule("strip", { kind: "segment", value: "base" }, { kind: "drop-matched-segments" }),
  ];
  const outcome = applyPathRules("*/base/thing", rules);
  assert.equal(outcome.kind, "excluded");
  if (outcome.kind !== "excluded") return;
  assert.equal(outcome.ruleId, "drop-scaffolding");
  // The path it *would* have had, so §I's reference to an excluded target still has something to
  // name — and the later `strip` rule did not run, which is what "terminal" means.
  assert.equal(outcome.name, "*/base/thing");
});

// ---------------------------------------------------------------------------
// The pipeline — §B
// ---------------------------------------------------------------------------

test("every enabled rule runs in order, each on the previous rule's output", () => {
  // A pipeline, not first-match-wins: precedence is array order, so "two rules disagree" is not a
  // question anyone has to answer.
  const rules = [
    rule("one", { kind: "segment", value: "xyz" }, { kind: "replace-segment", with: "brand" }),
    rule("two", { kind: "segment", value: "brand" }, { kind: "drop-matched-segments" }),
  ];
  assert.equal(derivePath("xyz/color/bg", rules).path, "color.bg");
});

test("a disabled rule is skipped without disturbing the ones around it", () => {
  const rules: PathRule[] = [
    { ...rule("off", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" }), enabled: false },
    rule("on", { kind: "segment", value: "base" }, { kind: "drop-matched-segments" }),
  ];
  assert.equal(derivePath("xyz/base/color", rules).path, "xyz.color");
});

test("an empty rule set reproduces the Figma name verbatim", () => {
  // The Phase 2 behaviour, and what keeps §7's byte-identical guarantee true for a rule-free file.
  assert.equal(derivePath("atlas/ref/palette/neutral/black").path, "atlas.ref.palette.neutral.black");
});

test("the pipeline is a pure function of name and rules, not of how often it runs", () => {
  const rules = [rule("strip", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" })];
  const once = derivePath("xyz/a/b", rules).path;
  assert.equal(derivePath("xyz/a/b", rules).path, once);
  // Re-running the engine over its own output would be a different question, and is not what a
  // scan does — the input is always the untouched source name.
  assert.equal(derivePath(once.split(".").join("/"), rules).path, "a.b");
});

// ---------------------------------------------------------------------------
// Invalid results — §C
// ---------------------------------------------------------------------------

test("a rule that empties the path is not applied, and names itself", () => {
  // §C: a mangled path is never written. The verbatim source name is used instead.
  const outcome = applyPathRules("xyz", [
    rule("strip", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" }),
  ]);
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind !== "invalid") return;
  assert.equal(outcome.ruleId, "strip");
  assert.equal(outcome.reason, "empty-path");
  assert.equal(outcome.name, "xyz");
});

test("a rewrite that leaves an empty segment or a stray separator is refused whole", () => {
  const outcome = applyPathRules("color/bg", [
    rule(
      "bad",
      { kind: "name", pattern: "^color" },
      { kind: "rewrite", pattern: "^color/(.*)$", replacement: "a//$1" }
    ),
  ]);
  assert.equal(outcome.kind, "invalid");
  if (outcome.kind !== "invalid") return;
  assert.equal(outcome.reason, "empty-segment");
});

// ---------------------------------------------------------------------------
// Rule validation
// ---------------------------------------------------------------------------

test("a broken rule is reported once and then dropped, never left silently inert", () => {
  const rules = [
    rule("bad-regex", { kind: "name", pattern: "([" }, { kind: "drop-matched-segments" }),
    rule("bad-rewrite", { kind: "segment", value: "a" }, { kind: "rewrite", pattern: "(", replacement: "x" }),
    rule("empty", { kind: "segment", value: "a" }, { kind: "replace-segment", with: "  " }),
    rule("ok", { kind: "segment", value: "a" }, { kind: "drop-matched-segments" }),
  ];
  const issues = validateRules(rules);
  assert.deepEqual(
    issues.map((issue) => issue.reason).sort(),
    ["bad-match-pattern", "bad-rewrite-pattern", "empty-replacement"]
  );
  assert.deepEqual(usableRules(rules).map((r) => r.id), ["ok"]);
});

test("two rules sharing an id are flagged — an id is how a rule names itself in the report", () => {
  const issues = validateRules([
    rule("same", { kind: "segment", value: "a" }, { kind: "drop-matched-segments" }),
    rule("same", { kind: "segment", value: "b" }, { kind: "drop-matched-segments" }),
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, "duplicate-id");
});

// ---------------------------------------------------------------------------
// `$rules.json` — §F
// ---------------------------------------------------------------------------

test("the rule set round-trips through the committed file shape, order preserved", () => {
  const rules = [
    rule("one", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" }),
    rule("two", { kind: "name", pattern: "^a" }, { kind: "rewrite", pattern: "^a", replacement: "b" }),
  ];
  const parsed = parseRuleSet(makeRuleSetFile(rules));
  assert.deepEqual(parsed.map((r) => r.id), ["one", "two"]);
  assert.deepEqual(parsed, rules);
});

test("a malformed rule is dropped rather than reinterpreted", () => {
  // The file is authored configuration a teammate may hand-edit, so it must survive a stray key
  // without inventing a rule nobody wrote.
  const parsed = parseRuleSet({
    pathRules: [
      { id: "no-match", action: { kind: "exclude" } },
      { id: "no-action", match: { kind: "segment", value: "a" } },
      { match: { kind: "segment", value: "a" }, action: { kind: "exclude" } },
      { id: "fine", match: { kind: "segment", value: "a" }, action: { kind: "exclude" }, stray: 1 },
    ],
  });
  assert.deepEqual(parsed.map((r) => r.id), ["fine"]);
  assert.deepEqual(parseRuleSet(null), []);
  assert.deepEqual(parseRuleSet({ pathRules: "nope" }), []);
});

test("the mismatch check compares what changes a path, and ignores what cannot", () => {
  const a = [rule("one", { kind: "segment", value: "xyz" }, { kind: "drop-matched-segments" })];
  const withNote = [{ ...a[0], note: "explains itself" }];
  const disabled = [a[0], { ...rule("two", { kind: "segment", value: "q" }, { kind: "exclude" }), enabled: false }];

  // A comment cannot move a token, and blocking a whole repo over an edited note would be the
  // gate crying wolf. Neither can a rule that is switched off.
  assert.equal(rulesEqual(a, withNote), true);
  assert.equal(rulesEqual(a, disabled), true);
  // Order is meaningful data (§B), so a reordering is a different rule set.
  const b = [rule("two", { kind: "segment", value: "q" }, { kind: "exclude" }), a[0]];
  assert.equal(rulesEqual(a.concat([b[0]]), b), false);
  assert.equal(rulesEqual(a, []), false);
});
