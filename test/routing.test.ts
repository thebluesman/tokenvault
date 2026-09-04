// Push routing and per-repo projections — ADR-0008 §1, §3, §5.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest, Token, TokenGroup } from "../src/tokens/types";
import {
  parseRoutingRules,
  projectManifest,
  projectTrees,
  routeToken,
  type RoutingRule,
} from "../src/git/routing";
import { varToken } from "./helpers";

const ALL = ["c_web", "c_android", "c_ios"];

function routing(id: string, match: RoutingRule["match"], repos: string[], on?: "path" | "source"): RoutingRule {
  return { id, enabled: true, match, repos, on };
}

// ---------------------------------------------------------------------------
// The router — §5
// ---------------------------------------------------------------------------

test("a token matched by no rule goes to every enabled connection", () => {
  // Default-all is what makes the empty rule set behave exactly like ADR-0006's single repo.
  assert.deepEqual(routeToken({ path: "color.bg" }, [], ALL), { repos: ALL });
  assert.deepEqual(
    routeToken({ path: "color.bg" }, [routing("r", { kind: "segment", value: "abc" }, ["c_android"])], ALL).repos,
    ALL
  );
});

test("a matching rule replaces the destination set outright and names itself", () => {
  const decision = routeToken(
    { path: "abc.color.bg" },
    [routing("android-only", { kind: "segment", value: "abc" }, ["c_android"])],
    ALL
  );
  assert.deepEqual(decision, { repos: ["c_android"], routedBy: "android-only" });
});

test("rules are ordered and the last match wins, replacing rather than composing", () => {
  // Union and intersection semantics were rejected as a mini-language: the later rule wins.
  const rules = [
    routing("first", { kind: "segment", value: "abc" }, ["c_android"]),
    routing("second", { kind: "segment", value: "abc" }, ["c_ios"]),
  ];
  assert.deepEqual(routeToken({ path: "abc.thing" }, rules, ALL), {
    repos: ["c_ios"],
    routedBy: "second",
  });
});

test("a disabled rule does not route", () => {
  const rules: RoutingRule[] = [
    { ...routing("off", { kind: "segment", value: "abc" }, ["c_android"]), enabled: false },
  ];
  assert.deepEqual(routeToken({ path: "abc.thing" }, rules, ALL).repos, ALL);
});

test("repos: [] is legal and means the token is committed nowhere", () => {
  // The only way to keep a token local, and it is shown as *not pushed anywhere* rather than as an
  // error (§5).
  const decision = routeToken(
    { path: "wip.thing" },
    [routing("keep-local", { kind: "segment", value: "wip" }, [])],
    ALL
  );
  assert.deepEqual(decision, { repos: [], routedBy: "keep-local" });
});

test("a rule naming a disabled or unknown connection routes nowhere, not somewhere else", () => {
  const decision = routeToken(
    { path: "abc.thing" },
    [routing("gone", { kind: "segment", value: "abc" }, ["c_deleted"])],
    ALL
  );
  assert.deepEqual(decision.repos, []);
  // `routedBy` survives, so the review screen can say *why* rather than leaving it arbitrary.
  assert.equal(decision.routedBy, "gone");
});

test("on: source matches the Figma name, which is the only way to route on a stripped segment", () => {
  // §5: a segment a naming rule removes as output noise may be precisely the one carrying the
  // destination, so the rule declares which string it matches rather than guessing.
  const rules = [routing("by-source", { kind: "segment", value: "xyz" }, ["c_android"], "source")];
  assert.deepEqual(
    routeToken({ path: "base.color", sourceName: "xyz/base/color" }, rules, ALL).repos,
    ["c_android"]
  );
  // With no source name known, the rule abstains rather than matching against the path — which
  // would silently route on the wrong string.
  assert.deepEqual(routeToken({ path: "base.color" }, rules, ALL).repos, ALL);
});

test("path matching segments the dotted path the same way it segments a Figma name", () => {
  // One matcher, one segmentation: `segment: "abc"` means the same thing on both sides.
  const rules = [routing("android", { kind: "segment", value: "abc" }, ["c_android"])];
  assert.deepEqual(routeToken({ path: "a.abc.b" }, rules, ALL).repos, ["c_android"]);
  assert.deepEqual(routeToken({ path: "a.abcd.b" }, rules, ALL).repos, ALL);
});

test("stored routing rules survive a malformed entry without inventing one", () => {
  const parsed = parseRoutingRules([
    { id: "ok", match: { kind: "segment", value: "abc" }, repos: ["c_android"] },
    { id: "no-repos", match: { kind: "segment", value: "abc" } },
    { match: { kind: "segment", value: "abc" }, repos: [] },
  ]);
  assert.deepEqual(parsed.map((rule) => rule.id), ["ok"]);
  assert.equal(parsed[0].on, "path");
  assert.deepEqual(parseRoutingRules(undefined), []);
});

// ---------------------------------------------------------------------------
// Projection — §3
// ---------------------------------------------------------------------------

function token(value: unknown, variableId = "VariableID:1:1"): Token {
  return varToken("number", value, { variableId });
}

const MANIFEST: Manifest = {
  version: 1,
  generatedBy: "tokenvault",
  tokenSetOrder: ["Core/Value", "Theme/Light"],
  collections: [
    {
      name: "Core",
      slug: "core",
      $figmaCollectionId: "VariableCollectionId:1:1",
      modes: [{ name: "Value", slug: "value", set: "Core/Value", $figmaModeId: "1:0", file: "core/value.json" }],
    },
    {
      name: "Theme",
      slug: "theme",
      $figmaCollectionId: "VariableCollectionId:2:1",
      modes: [{ name: "Light", slug: "light", set: "Theme/Light", $figmaModeId: "2:0", file: "theme/light.json" }],
    },
  ],
  themes: [{ name: "Light", selectedTokenSets: ["Core/Value", "Theme/Light"] }],
};

function trees(): Map<string, TokenGroup> {
  return new Map<string, TokenGroup>([
    [
      "tokens/core/value.json",
      { abc: { size: token(4, "VariableID:1:10") }, shared: { size: token(8, "VariableID:1:11") } },
    ],
    ["tokens/theme/light.json", { abc: { bg: token(1, "VariableID:2:10") } }],
  ]);
}

test("each repo receives a subset of the local file, never a different file", () => {
  const result = projectTrees({
    trees: trees(),
    manifest: MANIFEST,
    rules: [routing("android", { kind: "segment", value: "abc" }, ["c_android"])],
    connectionIds: ["c_web", "c_android"],
  });

  const web = result.projections[0];
  const android = result.projections[1];

  assert.deepEqual(Array.from(web.files.keys()), ["tokens/core/value.json"]);
  assert.deepEqual(Object.keys(web.files.get("tokens/core/value.json") as TokenGroup), ["shared"]);
  assert.deepEqual(android.tokens.map((entry) => entry.path).sort(), [
    "abc.bg",
    "abc.size",
    "shared.size",
  ]);
});

test("an empty projection writes no file at all, not an empty object", () => {
  const result = projectTrees({
    trees: trees(),
    manifest: MANIFEST,
    rules: [routing("android", { kind: "segment", value: "abc" }, ["c_android"])],
    connectionIds: ["c_web", "c_android"],
  });
  // `theme/light.json` holds only `abc.*`, which routes away from web.
  assert.equal(result.projections[0].files.has("tokens/theme/light.json"), false);
});

test("the manifest is projected too, so an export never globs a file that is not there", () => {
  const result = projectTrees({
    trees: trees(),
    manifest: MANIFEST,
    rules: [routing("android", { kind: "segment", value: "abc" }, ["c_android"])],
    connectionIds: ["c_web"],
  });

  const manifest = result.projections[0].manifest;
  assert.deepEqual(manifest.tokenSetOrder, ["Core/Value"]);
  assert.deepEqual(manifest.collections.map((collection) => collection.name), ["Core"]);
  assert.deepEqual(manifest.themes[0].selectedTokenSets, ["Core/Value"]);
});

test("a theme that loses every set is dropped rather than left pointing at nothing", () => {
  const projected = projectManifest(MANIFEST, new Set());
  assert.deepEqual(projected.themes, []);
  assert.deepEqual(projected.collections, []);
  assert.deepEqual(projected.tokenSetOrder, []);
});

test("tokens routed nowhere are collected, not silently dropped", () => {
  const result = projectTrees({
    trees: trees(),
    manifest: MANIFEST,
    rules: [routing("local-only", { kind: "segment", value: "abc" }, [])],
    connectionIds: ["c_web"],
  });

  assert.deepEqual(
    result.routedNowhere.map((entry) => `${entry.setId}:${entry.path}`).sort(),
    ["Core/Value:abc.size", "Theme/Light:abc.bg"]
  );
  assert.equal(result.routedNowhere[0].routedBy, "local-only");
});

test("an on: source rule routes off the Figma name the token remembers by id", () => {
  const result = projectTrees({
    trees: trees(),
    manifest: MANIFEST,
    rules: [routing("by-source", { kind: "segment", value: "xyz" }, ["c_android"], "source")],
    connectionIds: ["c_web", "c_android"],
    sourceNames: new Map([["VariableID:1:10", "xyz/abc/size"]]),
  });

  assert.deepEqual(result.projections[0].tokens.map((entry) => entry.path).sort(), [
    "abc.bg",
    "shared.size",
  ]);
});

test("with no rules every enabled repo gets the whole tree — the ADR-0006 case, unchanged", () => {
  const result = projectTrees({
    trees: trees(),
    manifest: MANIFEST,
    rules: [],
    connectionIds: ["c_web", "c_android"],
  });
  for (const projection of result.projections) {
    assert.equal(projection.tokens.length, 3);
    assert.deepEqual(projection.manifest.tokenSetOrder, MANIFEST.tokenSetOrder);
  }
});
