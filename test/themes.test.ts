// Read-only theme selection and canvas switching — ADR-0007 §7(a), §7(c).

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest } from "../src/tokens/types";
import {
  effectiveThemes,
  multiModeCollections,
  themeModePlan,
  themeOnCanvas,
  themeSetStack,
  themeState,
  tokensInStack,
  unknownSets,
} from "../src/tokens/themes";
import { flat, varToken } from "./helpers";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 2,
    generatedBy: "tokenvault",
    tokenSetOrder: ["Base/Base", "Theme/Light", "Theme/Dark", "Styles/Text"],
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
    styleSets: [
      { file: "styles/text.json", kind: "TEXT", name: "Text", set: "Styles/Text", slug: "text" },
    ],
    themes: [
      { name: "Light", selectedTokenSets: ["Base/Base", "Theme/Light", "Styles/Text"] },
      { name: "Dark", selectedTokenSets: ["Base/Base", "Theme/Dark", "Styles/Text"] },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Selection — §7(a)
// ---------------------------------------------------------------------------

test("the default is the first theme in the manifest", () => {
  const state = themeState(manifest(), null);
  assert.equal(state.active?.name, "Light");
  assert.equal(state.fellBackFrom, undefined);
});

test("a stored theme is honoured", () => {
  assert.equal(themeState(manifest(), "Dark").active?.name, "Dark");
});

test("a stored theme that is gone falls back to the first — and says so", () => {
  // Silently resolving against a stack the user did not choose would change every displayed value
  // with no explanation (ADR-0007 §7a, UX §8.3).
  const state = themeState(manifest(), "Brand");
  assert.equal(state.active?.name, "Light");
  assert.equal(state.fellBackFrom, "Brand");
});

test("a file with no themes has no active theme, and that is a state rather than an error", () => {
  const state = themeState(manifest({ themes: [] }), "Light");
  assert.deepEqual(state.themes, []);
  assert.equal(state.active, null);
});

test("a theme naming a set this build doesn't have keeps its other sets", () => {
  // A pulled `$manifest.json` (ADR-0006 §5) can name a set that is gone. A theme with one stale set
  // is still a usable theme — the same partial-plus-named rule §7c applies to the canvas switch.
  const withStale = manifest({
    themes: [{ name: "Light", selectedTokenSets: ["Base/Base", "Gone/Set", "Theme/Light"] }],
  });
  assert.deepEqual(effectiveThemes(withStale)[0].selectedTokenSets, ["Base/Base", "Theme/Light"]);
  assert.deepEqual(unknownSets(withStale, withStale.themes[0]), ["Gone/Set"]);
});

// ---------------------------------------------------------------------------
// The set stack — ADR-0002 §1's order, last-wins
// ---------------------------------------------------------------------------

test("the stack is selectedTokenSets order, which is the order that decides the answer", () => {
  const state = themeState(manifest(), "Dark");
  assert.deepEqual(themeSetStack(manifest(), state.active), [
    "Base/Base",
    "Theme/Dark",
    "Styles/Text",
  ]);
});

test("no themes resolves through every set, in order — UX §8.5's promise, kept", () => {
  const none = manifest({ themes: [] });
  assert.deepEqual(themeSetStack(none, null), none.tokenSetOrder);
});

test("tokens are ordered by stack position, so last-wins means what it says", () => {
  const tokens = [
    flat("a", "Theme/Dark", varToken("number", 2)),
    flat("a", "Base/Base", varToken("number", 1)),
    flat("a", "Styles/Text", varToken("number", 3)),
  ];
  const stacked = tokensInStack(tokens, ["Base/Base", "Theme/Dark"]);
  assert.deepEqual(
    stacked.map((entry) => entry.setId),
    ["Base/Base", "Theme/Dark"]
  );
  // A set the theme doesn't select is simply absent, which is what makes `unresolved-in-theme` a
  // real state rather than a synthetic one.
  assert.equal(stacked.length, 2);
});

// ---------------------------------------------------------------------------
// Canvas switching — §7(c)
// ---------------------------------------------------------------------------

test("a switch is a list of (collection, mode) pairs the manifest already carries", () => {
  const state = themeState(manifest(), "Dark");
  const plan = themeModePlan(manifest(), state.active);
  assert.deepEqual(plan.targets, [
    {
      collectionId: "C:base",
      collectionName: "Base",
      modeId: "M:base",
      modeName: "Base",
      set: "Base/Base",
    },
    {
      collectionId: "C:theme",
      collectionName: "Theme",
      modeId: "M:dark",
      modeName: "Dark",
      set: "Theme/Dark",
    },
  ]);
});

test("style-backed sets are excluded silently — Figma Styles have no modes", () => {
  // Reporting them every time is how you teach someone to stop reading the toast (§7c).
  const plan = themeModePlan(manifest(), themeState(manifest(), "Light").active);
  assert.deepEqual(plan.unmapped, []);
  assert.equal(plan.targets.every((target) => target.set !== "Styles/Text"), true);
});

test("a hand-composed set with no Figma mode is named, and never refuses the whole switch", () => {
  const withHand = manifest({
    tokenSetOrder: ["Base/Base", "Theme/Dark", "Hand/Written"],
    themes: [{ name: "Dark", selectedTokenSets: ["Base/Base", "Theme/Dark", "Hand/Written"] }],
  });
  const plan = themeModePlan(withHand, effectiveThemes(withHand)[0]);
  assert.deepEqual(plan.unmapped, ["Hand/Written"]);
  assert.equal(plan.targets.length, 2);
});

test("a theme naming two modes of one collection sets the last — a node holds one mode per collection", () => {
  const both = manifest({
    themes: [{ name: "Both", selectedTokenSets: ["Theme/Light", "Theme/Dark"] }],
  });
  const plan = themeModePlan(both, effectiveThemes(both)[0]);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].modeId, "M:dark");
});

test("no theme means nothing to switch", () => {
  assert.deepEqual(themeModePlan(manifest(), null), { targets: [], unmapped: [] });
});

// ---------------------------------------------------------------------------
// `on canvas` — UX §8.2
// ---------------------------------------------------------------------------

test("a theme is on canvas only when every collection it maps is set to its mode", () => {
  const m = manifest();
  const themes = effectiveThemes(m);
  assert.equal(themeOnCanvas(m, themes, { "C:base": "M:base", "C:theme": "M:dark" }), "Dark");
  // A partial match is not a match: claiming `on canvas` for a theme two of whose three collections
  // are set elsewhere would be a false statement about the canvas.
  assert.equal(themeOnCanvas(m, themes, { "C:theme": "M:dark" }), null);
  assert.equal(themeOnCanvas(m, themes, {}), null);
});

// ---------------------------------------------------------------------------
// The no-themes explanation — UX §8.5
// ---------------------------------------------------------------------------

test("the ambiguous case can name its own cause back to the user", () => {
  const ambiguous = manifest({
    collections: manifest().collections.concat([
      {
        name: "Density",
        slug: "density",
        $figmaCollectionId: "C:density",
        modes: [
          { name: "Cosy", slug: "cosy", set: "Density/Cosy", $figmaModeId: "M:cosy", file: "d/c.json" },
          { name: "Compact", slug: "compact", set: "Density/Compact", $figmaModeId: "M:compact", file: "d/x.json" },
        ],
      },
    ]),
    themes: [],
  });
  assert.deepEqual(multiModeCollections(ambiguous), ["Theme", "Density"]);
});
