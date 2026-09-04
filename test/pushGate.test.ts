// The pre-push gate — ADR-0002 Amendment 3, ADR-0008 §3, §4, ADR-0002 Amendment 2 §F.
//
// The gate is stated over the tree, not over a list of report kinds: every reference resolves to a
// token that exists, and no chain closes on itself. These tests are written the same way — by
// constructing trees that do and do not have that property, rather than by enumerating causes.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest, Token } from "../src/tokens/types";
import type { Projection } from "../src/git/routing";
import { projectTrees } from "../src/git/routing";
import {
  evaluatePushGate,
  localTreeBlocks,
  projectionBlocks,
  ruleSetMismatchBlock,
} from "../src/git/pushGate";
import type { PathRule } from "../src/tokens/rules";
import { flat, varToken } from "./helpers";

function num(value: unknown): Token {
  return varToken("number", value);
}

const STRIP: PathRule = {
  id: "strip-xyz",
  enabled: true,
  match: { kind: "segment", value: "xyz" },
  action: { kind: "drop-matched-segments" },
};

// ---------------------------------------------------------------------------
// The local tree — Amendment 3 §A
// ---------------------------------------------------------------------------

test("a tree whose references all resolve is not blocked", () => {
  const blocks = localTreeBlocks([
    flat("base.black", "Core/Value", num("#000000")),
    flat("semantic.text", "Core/Value", num("{base.black}")),
  ]);
  assert.deepEqual(blocks, []);
});

test("any unresolved reference blocks the push, whatever caused it", () => {
  // The gate is over the tree, so a collision loser, an unsupported type and a rule exclusion all
  // reach it as the same condition — which is the property that makes it stable.
  const blocks = localTreeBlocks([flat("semantic.text", "Core/Value", num("{base.black}"))]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "unresolved-reference");
  assert.equal(blocks[0].path, "semantic.text");
  assert.equal(blocks[0].target, "base.black");
  // The message names the token and the missing target — a block whose cause is not on screen is
  // a block the user cannot clear (ADR-0008 §7).
  assert.equal(blocks[0].message.indexOf("base.black") !== -1, true);
});

test("a reference resolves against the whole tree, not against one theme's stack", () => {
  // A theme-scoped miss is ADR-0007's `unresolved-in-theme` warning — frequently the correct state
  // of a correct token — and deliberately does not block.
  const blocks = localTreeBlocks([
    flat("base.black", "Theme/Dark", num("#000000")),
    flat("semantic.text", "Theme/Light", num("{base.black}")),
  ]);
  assert.deepEqual(blocks, []);
});

test("a cycle blocks, because a tree with one already fails the export build", () => {
  const blocks = localTreeBlocks([
    flat("a", "Core/Value", num("{b}")),
    flat("b", "Core/Value", num("{a}")),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "reference-cycle");
  assert.equal(blocks[0].message.indexOf("→") !== -1, true);
});

test("an expression's operands are edges too, so a cycle through math blocks as well", () => {
  const blocks = localTreeBlocks([
    flat("a", "Core/Value", num("{b} * 2")),
    flat("b", "Core/Value", num("{a} + 1")),
  ]);
  assert.equal(blocks.some((block) => block.kind === "reference-cycle"), true);
});

test("one token referencing the same missing target twice is one block", () => {
  const blocks = localTreeBlocks([
    flat("a", "Core/Value", num("{missing} + {missing}")),
  ]);
  assert.equal(blocks.length, 1);
});

// ---------------------------------------------------------------------------
// One repo's projection — ADR-0008 §3
// ---------------------------------------------------------------------------

const MANIFEST: Manifest = {
  version: 1,
  generatedBy: "tokenvault",
  tokenSetOrder: ["Core/Value"],
  collections: [
    {
      name: "Core",
      slug: "core",
      $figmaCollectionId: "VariableCollectionId:1:1",
      modes: [{ name: "Value", slug: "value", set: "Core/Value", $figmaModeId: "1:0", file: "core/value.json" }],
    },
  ],
  themes: [{ name: "Default", selectedTokenSets: ["Core/Value"] }],
};

function routedProjections(): Projection[] {
  // `abc.black` routes to android only; `semantic.text` references it and routes everywhere.
  return projectTrees({
    trees: new Map([
      [
        "tokens/core/value.json",
        {
          abc: { black: num("#000000") },
          semantic: { text: num("{abc.black}") },
        },
      ],
    ]),
    manifest: MANIFEST,
    rules: [{ id: "android-only", enabled: true, on: "path", match: { kind: "segment", value: "abc" }, repos: ["c_android"] }],
    connectionIds: ["c_web", "c_android"],
  }).projections;
}

test("a routing rule is a hard wall: the reference is named, not quietly widened", () => {
  // Silently widening the projection to include the target was rejected — it would make the rules
  // describe something other than what happens.
  const [web, android] = routedProjections();

  const webBlocks = projectionBlocks(web);
  assert.equal(webBlocks.length, 1);
  assert.equal(webBlocks[0].kind, "routing-dangling-reference");
  assert.equal(webBlocks[0].reason, "cross-repo");
  assert.equal(webBlocks[0].connectionId, "c_web");
  assert.equal(webBlocks[0].target, "abc.black");
  // The repo that has both ends is unaffected — §4's per-repo independence.
  assert.deepEqual(projectionBlocks(android), []);
});

test("a routing dangle blocks its repo and lets the others push", () => {
  const result = evaluatePushGate({
    tokens: [
      flat("abc.black", "Core/Value", num("#000000")),
      flat("semantic.text", "Core/Value", num("{abc.black}")),
    ],
    projections: routedProjections(),
  });

  assert.deepEqual(result.global, []);
  assert.deepEqual(Array.from(result.perRepo.keys()), ["c_web"]);
  assert.deepEqual(result.pushable, ["c_android"]);
});

test("an unresolvable local tree blocks every repo at once", () => {
  // Unlike a routing dangle, the breakage is in the tree itself and is identical in every
  // projection — so it is one message above the per-repo list, and nothing is pushable.
  const result = evaluatePushGate({
    tokens: [flat("semantic.text", "Core/Value", num("{gone}"))],
    projections: routedProjections(),
  });

  assert.equal(result.global.length, 1);
  assert.deepEqual(result.pushable, []);
});

// ---------------------------------------------------------------------------
// Rule-set mismatch — Amendment 2 §F
// ---------------------------------------------------------------------------

test("a repo whose rule set differs blocks that whole repo, and says why", () => {
  const block = ruleSetMismatchBlock("c_web", [STRIP], []);
  assert.notEqual(block, null);
  assert.equal(block?.kind, "rule-set-mismatch");
  assert.equal(block?.connectionId, "c_web");
});

test("a matching rule set, and a repo that has no rules file yet, both pass", () => {
  assert.equal(ruleSetMismatchBlock("c_web", [STRIP], [STRIP]), null);
  // A repo with no `$rules.json` is one this feature has not reached; the push that introduces
  // the file is how it gets one. Blocking here would make rules impossible to adopt.
  assert.equal(ruleSetMismatchBlock("c_web", [STRIP], null), null);
});

test("a mismatch blocks one repo, not the others", () => {
  const projections = routedProjections();
  const result = evaluatePushGate({
    tokens: [
      flat("abc.black", "Core/Value", num("#000000")),
      flat("semantic.text", "Core/Value", num("{abc.black}")),
    ],
    projections: [projections[1]],
    localRules: [STRIP],
    remoteRules: new Map([["c_android", []]]),
  });

  assert.deepEqual(result.pushable, []);
  assert.equal(
    (result.perRepo.get("c_android") ?? []).some((block) => block.kind === "rule-set-mismatch"),
    true
  );
});
