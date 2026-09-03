// One file's token-level diff — UX §7.2's nested rows and §9.2's Compare screen.
//
// The commit's unit is a file and the user's unit is a token (§3). This is the bridge, and it has
// to be a comparison of parsed trees rather than of two serializations: a textual diff of
// `stableStringify` output is a diff of a serialization, which is a thing no designer wants to read.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest, Token, TokenGroup } from "../src/tokens/types";
import { describeManifestChange, diffTrees, flattenTree } from "../src/git/filediff";

function token(value: string, description?: string): Token {
  const out = { $type: "color", $value: value } as Token;
  if (description !== undefined) out.$description = description;
  return out;
}

const before: TokenGroup = {
  color: { accent: token("#b4342a"), surface: token("#f7f4f2") },
} as unknown as TokenGroup;

test("a value change is one row with both sides", () => {
  const after = { color: { accent: token("#c33a2e"), surface: token("#f7f4f2") } } as unknown as TokenGroup;
  const diff = diffTrees(before, after);
  assert.equal(diff.rows.length, 1);
  assert.deepEqual(diff.rows[0], {
    path: "color.accent",
    state: "changed",
    before: "#b4342a",
    after: "#c33a2e",
  });
  assert.equal(diff.changed, 1);
});

test("added and removed tokens are their own states, not empty value changes", () => {
  const after = { color: { accent: token("#b4342a"), raised: token("#fff") } } as unknown as TokenGroup;
  const diff = diffTrees(before, after);
  assert.deepEqual(
    diff.rows.map((row) => [row.path, row.state]),
    [
      ["color.raised", "added"],
      ["color.surface", "removed"],
    ]
  );
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test("a description-only change is a real row", () => {
  // A commit whose whole content is documentation must not read as an empty diff.
  const after = {
    color: { accent: token("#b4342a", "Warm red"), surface: token("#f7f4f2") },
  } as unknown as TokenGroup;
  const diff = diffTrees(before, after);
  assert.equal(diff.rows.length, 1);
  assert.equal(diff.rows[0].description, true);
  assert.equal(diff.rows[0].after, "Warm red");
});

test("an unchanged file produces no rows at all", () => {
  assert.deepEqual(diffTrees(before, before).rows, []);
});

test("a file only one side has diffs against nothing rather than throwing", () => {
  assert.equal(diffTrees(null, before).rows.length, 2);
  assert.equal(diffTrees(before, null).rows.every((row) => row.state === "removed"), true);
});

test("rows are ordered deterministically", () => {
  const tree = { z: token("#000"), a: token("#fff") } as unknown as TokenGroup;
  assert.deepEqual(Array.from(flattenTree(tree).keys()), ["a", "z"]);
});

// ---------------------------------------------------------------------------
// The manifest row — UX §7.2
// ---------------------------------------------------------------------------

const manifest: Manifest = {
  version: 2,
  generatedBy: "tokenvault",
  tokenSetOrder: ["Theme/Light", "Theme/Dark"],
  collections: [
    {
      name: "Theme",
      slug: "theme",
      $figmaCollectionId: "C:1",
      modes: [
        { name: "Light", slug: "light", set: "Theme/Light", $figmaModeId: "1:0", file: "theme/light.json" },
        { name: "Dark", slug: "dark", set: "Theme/Dark", $figmaModeId: "1:1", file: "theme/dark.json" },
      ],
    },
  ],
  themes: [],
};

test("the manifest row explains itself in the panel's own words", () => {
  // *"`tokens/$manifest.json` means nothing to a designer."* A file in the diff the user cannot
  // interpret is a file they will learn to ignore.
  const lines = describeManifestChange(
    { ...manifest, tokenSetOrder: ["Theme/Light"] },
    manifest,
    { before: new Map([["Theme/Light", 289]]), after: new Map([["Theme/Light", 290], ["Theme/Dark", 12]]) }
  );
  assert.equal(lines.indexOf("Theme / Dark · set added") !== -1, true);
  assert.equal(lines.indexOf("Theme / Light · 289 → 290 tokens") !== -1, true);
});

test("a manifest change with nothing nameable still says something", () => {
  assert.deepEqual(describeManifestChange(manifest, manifest), ["Set order or metadata changed."]);
});
