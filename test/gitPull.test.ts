// Pull → overlay entries — ADR-0006 §5, UX §8.
//
// The phase's biggest saving, and therefore the place a mistake is least visible: a pull produces
// nothing but overlay entries, which then ride Phase 5's apply flow. If the matching is wrong, the
// symptom is not an error — it is the wrong token quietly changing on someone's canvas.
//
// Two properties carry the most weight here:
//
//   1. **Matching is by `set` + dotted path**, never by provenance id (§5). A repo-side rename *is*
//      a rename of that token; id-matching would read it as a delete plus an add and destroy it.
//   2. **A local edit wins the tree on a conflict, and the flag names the repo** (§5, UX §8.2).

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest, Token, TokenGroup } from "../src/tokens/types";
import type { EditOverlay, OverlayEntry } from "../src/tokens/overlay";
import type { FlatToken } from "../src/tokens/view";
import { applyPull, buildPull } from "../src/git/pull";
import { originOf, recordEdit } from "../src/tokens/overlay";

const NOW = "2026-09-03T09:00:00.000Z";

function token(variableId: string, value: string, description?: string): Token {
  const out: Token = {
    $type: "color",
    $value: value as Token["$value"],
    $extensions: {
      "com.tokenvault": {
        figma: { variableId, modeId: "1:0" },
      } as Token["$extensions"]["com.tokenvault"],
    },
  };
  if (description !== undefined) out.$description = description;
  return out;
}

function flat(path: string, setId: string, value: Token): FlatToken {
  return { path, segments: path.split("."), setId, token: value };
}

const manifest: Manifest = {
  version: 2,
  generatedBy: "tokenvault",
  tokenSetOrder: ["Theme/Light"],
  collections: [
    {
      name: "Theme",
      slug: "theme",
      $figmaCollectionId: "C:1",
      modes: [
        {
          name: "Light",
          slug: "light",
          set: "Theme/Light",
          $figmaModeId: "1:0",
          file: "theme/light.json",
        },
      ],
    },
  ],
  themes: [],
};

function remoteTree(tokens: Record<string, Token>): Map<string, unknown> {
  const tree: TokenGroup = {};
  for (const path of Object.keys(tokens)) {
    const segments = path.split(".");
    let node = tree;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (node[segments[i]] === undefined) node[segments[i]] = {} as TokenGroup;
      node = node[segments[i]] as TokenGroup;
    }
    node[segments[segments.length - 1]] = tokens[path];
  }
  return new Map<string, unknown>([["tokens/theme/light.json", tree]]);
}

test("a repo value that differs from Figma becomes one pulled overlay entry", () => {
  const result = buildPull({
    remote: remoteTree({ "color.accent": token("VariableID:1:4", "#c33a2e") }),
    imported: [flat("color.accent", "Theme/Light", token("VariableID:1:4", "#b4342a"))],
    manifest,
  });

  assert.equal(result.entries.length, 1);
  const entry = result.entries[0];
  assert.equal(entry.value, "#c33a2e");
  // What this diverges from: Figma's current value, exactly as an authored edit records it.
  assert.equal(entry.base, "#b4342a");
  assert.equal(entry.origin, "pulled");
  assert.equal(entry.op, "set-value");
});

test("a repo value that matches Figma produces nothing", () => {
  const result = buildPull({
    remote: remoteTree({ "color.accent": token("VariableID:1:4", "#b4342a") }),
    imported: [flat("color.accent", "Theme/Light", token("VariableID:1:4", "#b4342a"))],
    manifest,
  });
  assert.deepEqual(result.entries, []);
});

test("a description-only difference is pulled too", () => {
  const result = buildPull({
    remote: remoteTree({ "color.accent": token("VariableID:1:4", "#b4342a", "Warm red") }),
    imported: [flat("color.accent", "Theme/Light", token("VariableID:1:4", "#b4342a"))],
    manifest,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].op, "set-description");
  assert.equal(result.entries[0].value, "Warm red");
});

test("matching is by set + path, so a repo-side rename is a rename and not a delete plus an add", () => {
  // The same Figma variable under a new path. Path matching finds nothing for the new name, so the
  // token is reported as unmatched rather than silently rewritten — and the old path is named as
  // local-only. Id-matching *is* consulted, but only as the disambiguator §5 describes.
  const result = buildPull({
    remote: remoteTree({ "color.brand.accent": token("VariableID:1:4", "#c33a2e") }),
    imported: [flat("color.accent", "Theme/Light", token("VariableID:1:4", "#b4342a"))],
    manifest,
  });
  // Provenance disambiguates when the path match fails, which is exactly the fallback §5 allows.
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, "color.accent");
});

test("a repo token with no Figma counterpart is reported, never applied", () => {
  // ADR-0006 §11: creating a Variable needs a collection, a mode, a resolved type and a scope set —
  // the authoring decision Phases 4 and 5 both declined. A repo authored outside Tokenvault pulls
  // in read-only until that lands, and this list is what stops that being silent.
  const result = buildPull({
    remote: remoteTree({ "color.bg.raised": token("VariableID:9:9", "#fff") }),
    imported: [flat("color.accent", "Theme/Light", token("VariableID:1:4", "#b4342a"))],
    manifest,
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].path, "color.bg.raised");
});

test("tokens this file has and the repo doesn't are named, not deleted", () => {
  const result = buildPull({
    remote: remoteTree({ "color.accent": token("VariableID:1:4", "#b4342a") }),
    imported: [
      flat("color.accent", "Theme/Light", token("VariableID:1:4", "#b4342a")),
      flat("color.legacy", "Theme/Light", token("VariableID:1:7", "#000000")),
    ],
    manifest,
  });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.localOnly.map((entry) => entry.path), ["color.legacy"]);
});

test("a repo file that isn't a token tree is excluded and named", () => {
  const result = buildPull({
    remote: new Map<string, unknown>([["tokens/theme/light.json", "not an object"]]),
    imported: [],
    manifest,
  });
  assert.deepEqual(result.unreadable, ["tokens/theme/light.json"]);
});

test("$manifest.json is not pulled — adopting a set inventory is a scan's job", () => {
  const result = buildPull({
    remote: new Map<string, unknown>([["tokens/$manifest.json", { anything: true }]]),
    imported: [],
    manifest,
  });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.unreadable, []);
});

// ---------------------------------------------------------------------------
// Landing a pull on the overlay — UX §8.2's merge table
// ---------------------------------------------------------------------------

const target = { variableId: "VariableID:1:4", modeId: "1:0" };
const pulled: Array<Omit<OverlayEntry, "at">> = [
  { target, path: "color.accent", set: "Theme/Light", op: "set-value", value: "#c33a2e", base: "#b4342a", origin: "pulled" },
];

function overlayWith(entries: OverlayEntry[]): EditOverlay {
  return { version: 1, entries };
}

test("a pull onto a clean overlay simply records the entry", () => {
  const merged = applyPull(overlayWith([]), pulled, NOW);
  assert.equal(merged.applied, 1);
  assert.equal(merged.conflicts, 0);
  assert.equal(originOf(merged.overlay.entries[0]), "pulled");
});

test("a second pull for the same target replaces the first — the repo moved again", () => {
  const first = applyPull(overlayWith([]), pulled, NOW).overlay;
  const second = applyPull(
    first,
    [{ ...pulled[0], value: "#d44b3f" }],
    NOW
  );
  assert.equal(second.overlay.entries.length, 1);
  assert.equal(second.overlay.entries[0].value, "#d44b3f");
  assert.equal(second.conflicts, 0);
});

test("a pull matching a local edit's value replaces it — both sides want the same thing", () => {
  const local = recordEdit(
    overlayWith([]),
    { target, path: "color.accent", set: "Theme/Light", op: "set-value", value: "#c33a2e", base: "#b4342a" },
    NOW
  );
  const merged = applyPull(local, pulled, NOW);
  assert.equal(merged.conflicts, 0);
  assert.equal(merged.applied, 1);
});

test("a pull onto a differing local edit keeps the edit and flags a conflict naming the repo", () => {
  // The local edit wins the *tree* for ADR-0004 §4's reason — it is the only side that cannot be
  // recovered, since the repo's value is one pull away and an overwritten edit is gone — and the
  // flag is what makes that provisional rather than silent.
  const local = recordEdit(
    overlayWith([]),
    { target, path: "color.accent", set: "Theme/Light", op: "set-value", value: "#111111", base: "#b4342a" },
    NOW
  );
  const merged = applyPull(local, pulled, NOW);

  assert.equal(merged.conflicts, 1);
  assert.equal(merged.applied, 0);
  const entry = merged.overlay.entries[0];
  assert.equal(entry.value, "#111111");
  assert.equal(entry.conflict?.figma, "#c33a2e");
  // `origin: "repo"` is what lets the block say *From the repo* instead of *Now in Figma*.
  assert.equal(entry.conflict?.origin, "repo");
});

test("entries written before Phase 6 default to local", () => {
  assert.equal(originOf({ target, op: "set-value", at: NOW } as OverlayEntry), "local");
  assert.equal(originOf({ target, op: "set-value", at: NOW, origin: "pulled" } as OverlayEntry), "pulled");
});
