// Theme enumeration for the export — issue #17, "no hand-maintained theme list".

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest } from "../src/tokens/types";
import { DEFAULT_THEME_NAME, exportThemes } from "../src/export/themes";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 2,
    generatedBy: "tokenvault",
    tokenSetOrder: ["Base/Base", "Theme/Light", "Theme/Dark"],
    collections: [
      {
        name: "Base",
        slug: "base",
        $figmaCollectionId: "C:base",
        modes: [
          { name: "Base", slug: "base", set: "Base/Base", $figmaModeId: "M:base", file: "base/base.json" },
        ],
      },
      {
        name: "Theme",
        slug: "theme",
        $figmaCollectionId: "C:theme",
        modes: [
          { name: "Light", slug: "light", set: "Theme/Light", $figmaModeId: "M:light", file: "theme/light.json" },
          { name: "Dark", slug: "dark", set: "Theme/Dark", $figmaModeId: "M:dark", file: "theme/dark.json" },
        ],
      },
    ],
    themes: [
      { name: "Light", selectedTokenSets: ["Base/Base", "Theme/Light"] },
      { name: "Dark", selectedTokenSets: ["Base/Base", "Theme/Dark"] },
    ],
    ...overrides,
  };
}

test("one build per theme in the manifest, in manifest order", () => {
  const themes = exportThemes(manifest());
  assert.deepEqual(
    themes.map((theme) => [theme.name, theme.slug]),
    [
      ["Light", "light"],
      ["Dark", "dark"],
    ]
  );
});

test("a theme's stack keeps selectedTokenSets order — last-wins depends on it", () => {
  const [light] = exportThemes(manifest());
  assert.deepEqual(light.selectedTokenSets, ["Base/Base", "Theme/Light"]);
});

test("a set the tree no longer has is dropped from the stack and named", () => {
  const themes = exportThemes(
    manifest({
      themes: [{ name: "Light", selectedTokenSets: ["Base/Base", "Brand/Acme", "Theme/Light"] }],
    })
  );
  assert.deepEqual(themes[0].selectedTokenSets, ["Base/Base", "Theme/Light"]);
  assert.deepEqual(themes[0].unknownSets, ["Brand/Acme"]);
});

test("a manifest with no themes still builds, over the whole tokenSetOrder", () => {
  // The `theme-composition` case (ADR-0002 §6): two multi-mode collections defeat theme
  // derivation, and refusing to export a perfectly ordinary token tree would be the wrong answer.
  const themes = exportThemes(manifest({ themes: [] }));
  assert.equal(themes.length, 1);
  assert.equal(themes[0].name, DEFAULT_THEME_NAME);
  assert.equal(themes[0].synthesized, true);
  assert.deepEqual(themes[0].selectedTokenSets, ["Base/Base", "Theme/Light", "Theme/Dark"]);
});

test("themes whose names slug identically get distinct file names", () => {
  // Otherwise the second silently overwrites the first, and the build reports one more theme than
  // it wrote.
  const themes = exportThemes(
    manifest({
      themes: [
        { name: "Brand A", selectedTokenSets: ["Base/Base"] },
        { name: "Brand/A", selectedTokenSets: ["Base/Base"] },
        { name: "brand a", selectedTokenSets: ["Base/Base"] },
      ],
    })
  );
  assert.deepEqual(
    themes.map((theme) => theme.slug),
    ["brand-a", "brand-a-2", "brand-a-3"]
  );
});

test("slugs are stable across runs of the same manifest", () => {
  const input = manifest({
    themes: [
      { name: "Brand A", selectedTokenSets: ["Base/Base"] },
      { name: "Brand/A", selectedTokenSets: ["Base/Base"] },
    ],
  });
  assert.deepEqual(
    exportThemes(input).map((theme) => theme.slug),
    exportThemes(input).map((theme) => theme.slug)
  );
});
