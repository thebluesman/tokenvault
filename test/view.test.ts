// The merged browser's view model — UX local-editor §4, §11.
//
// Half of this runs against the real Folio capture in `test/fixtures/styles-import/`, because the
// merged view exists to solve a problem only a real file has: `Theme/Light` and `Theme/Dark` hold
// the same 289 dotted paths, and a naive merge lists each of them twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FileScan, FileSnapshot, Manifest, StylesSnapshot, Subtype } from "../src/tokens/types";
import {
  buildPathRows,
  buildTree,
  describeSets,
  flattenImport,
  hasMixedTypes,
  treeIndex,
} from "../src/tokens/view";
import { buildMergedImport } from "../src/tokens/merge";

const ROOT = join(process.cwd(), "test/fixtures/styles-import");
const IMPORTED_AT = "2026-09-01T00:00:00.000Z";

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const scan: FileScan = {
  variables: JSON.parse(read("variables-snapshot.json")) as FileSnapshot,
  styles: JSON.parse(read("styles-snapshot.json")) as StylesSnapshot,
};
const userSubtypes = JSON.parse(read("user-subtypes.json")) as Record<string, Subtype>;

const result = buildMergedImport(scan, { userSubtypes, importedAt: IMPORTED_AT });
const sets = describeSets(result.manifest);
const flat = flattenImport(treeIndex(result.files), result.manifest);
const rows = buildPathRows(flat, sets);

// ---------------------------------------------------------------------------
// Set codes — §4.2
// ---------------------------------------------------------------------------

test("set codes drop `Mode 1` and keep the mode name where it distinguishes", () => {
  const byId = new Map(sets.map((info) => [info.id, info] as const));
  assert.equal(byId.get("Base/Mode 1")?.code, "Base");
  assert.equal(byId.get("Theme/Light")?.code, "Light");
  assert.equal(byId.get("Theme/Dark")?.code, "Dark");
  assert.equal(byId.get("Spacing/Mode 1")?.code, "Spacing");
});

test("style sets are labelled as the derived things they are", () => {
  const text = sets.filter((info) => info.source === "styles" && info.code === "Text")[0];
  assert.ok(text, "the Folio capture has text styles");
  assert.equal(text.file.startsWith("styles/"), true);
});

test("sets follow tokenSetOrder, so Light precedes Dark on every row", () => {
  assert.deepEqual(
    sets.map((info) => info.id),
    result.manifest.tokenSetOrder
  );
});

test("a code that would name two sets falls back to the full set id", () => {
  const manifest: Manifest = {
    version: 2,
    generatedBy: "tokenvault",
    tokenSetOrder: ["A/Light", "B/Light"],
    collections: [
      {
        name: "A",
        slug: "a",
        $figmaCollectionId: "a",
        modes: [
          { name: "Light", slug: "light", set: "A/Light", $figmaModeId: "1", file: "a/light.json" },
          { name: "Dark", slug: "dark", set: "A/Dark", $figmaModeId: "2", file: "a/dark.json" },
        ],
      },
      {
        name: "B",
        slug: "b",
        $figmaCollectionId: "b",
        modes: [
          { name: "Light", slug: "light", set: "B/Light", $figmaModeId: "3", file: "b/light.json" },
          { name: "Dark", slug: "dark", set: "B/Dark", $figmaModeId: "4", file: "b/dark.json" },
        ],
      },
    ],
    themes: [],
  };
  // A code that names two different sets is worse than a long one.
  assert.deepEqual(
    describeSets(manifest).map((info) => info.code),
    ["A/Light", "B/Light"]
  );
});

// ---------------------------------------------------------------------------
// The path-keyed merge — §4.2
// ---------------------------------------------------------------------------

test("every token in the generated files reaches the flattened view", () => {
  assert.equal(flat.length, result.counts.tokens);
});

test("a path held by both themes is one row with two value lines, not two rows", () => {
  const accent = rows.filter((row) => row.path === "folio.color.border.accent.default")[0];
  assert.ok(accent, "the fixture has this path in both themes");
  assert.deepEqual(
    accent.lines.map((line) => line.setId),
    ["Theme/Light", "Theme/Dark"],
    "value lines follow tokenSetOrder so the eye can rely on position"
  );
});

test("the merge folds the duplicated theme paths away", () => {
  // The Folio capture's two theme modes hold the same 120 dotted paths. Without the fold those
  // are 120 pairs of adjacent rows differing only in a swatch, which is what §4.2 exists to stop.
  // (UX §4 says 289; the committed capture says 120 — the shape of the problem is the same.)
  const duplicated = flat.length - rows.length;
  assert.equal(duplicated, 120);
  assert.equal(flat.length, 1316);
  // Every row keeps at least one line, and no line is lost in the fold.
  assert.equal(
    rows.reduce((total, row) => total + row.lines.length, 0),
    flat.length
  );
});

test("single-set paths stay single-line — the common case pays nothing for the merge", () => {
  const single = rows.filter((row) => row.lines.length === 1).length;
  assert.ok(single > rows.length / 2, "most of the Folio tree is single-set");
});

test("rows are keyed case-insensitively, matching collision detection", () => {
  for (const row of rows) assert.equal(row.key, row.path.toLowerCase());
});

test("sets that agree on $type report no type disagreement", () => {
  const accent = rows.filter((row) => row.path === "folio.color.border.accent.default")[0];
  assert.equal(hasMixedTypes(accent), false);
});

test("a path whose sets disagree on $type is detected, so the shared glyph can drop", () => {
  const mixed = {
    path: "a.b",
    key: "a.b",
    segments: ["a", "b"],
    lines: [
      { ...flat[0], token: { ...flat[0].token, $type: "color" as const } },
      { ...flat[0], token: { ...flat[0].token, $type: "number" as const } },
    ],
  };
  assert.equal(hasMixedTypes(mixed), true);
});

// ---------------------------------------------------------------------------
// The tree — §4.4
// ---------------------------------------------------------------------------

test("groups merge by name across sets, and count paths rather than tokens", () => {
  const tree = buildTree(rows);
  const folio = tree.filter((node) => node.name === "folio")[0];
  assert.ok(folio && folio.kind === "group");
  assert.equal(folio.pathCount, rows.filter((row) => row.path.startsWith("folio.")).length);
});

test("the tree follows DTCG group nesting exactly", () => {
  const tree = buildTree([
    { path: "a.b.c", key: "a.b.c", segments: ["a", "b", "c"], lines: [] },
    { path: "a.b.d", key: "a.b.d", segments: ["a", "b", "d"], lines: [] },
    { path: "a.e", key: "a.e", segments: ["a", "e"], lines: [] },
  ]);

  assert.equal(tree.length, 1);
  const a = tree[0];
  assert.equal(a.kind, "group");
  if (a.kind !== "group") return;
  assert.equal(a.pathCount, 3);
  // Sorted by byte comparison, groups and tokens interleaved — the same order the files use.
  assert.deepEqual(a.children.map((child) => child.name), ["b", "e"]);
  assert.equal(a.children[0].kind, "group");
  assert.equal(a.children[1].kind, "token");
});

test("the tree is empty for an empty import", () => {
  assert.deepEqual(buildTree([]), []);
});
