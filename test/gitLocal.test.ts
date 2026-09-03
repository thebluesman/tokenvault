// The bytes a push writes — ADR-0006 §5, and the byte-identity ADR-0002 §7 promised.
//
// The whole blob-SHA design rests on one claim: serializing the same tree twice produces the same
// bytes. If that is ever false, every file looks changed, the status check is noise, and the push
// button is permanently lit. This file pins the claim rather than trusting it.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { EditOverlay } from "../src/tokens/overlay";
import { localTree, localTrees } from "../src/git/local";
import { stableStringify } from "../src/tokens/serialize";
import { blobSha } from "../src/git/blob";

const light = {
  color: {
    accent: {
      $type: "color",
      $value: "#b4342a",
      $extensions: {
        "com.tokenvault": { figma: { variableId: "VariableID:1:4", modeId: "1:0" } },
      },
    },
  },
};

const files = [
  { path: "tokens/theme/light.json", json: stableStringify(light) },
  { path: "tokens/$manifest.json", json: stableStringify({ version: 2 }) },
  { path: "tokens/$import-report.json", json: stableStringify({ at: "whenever" }) },
];

const empty: EditOverlay = { version: 1, entries: [] };

test("an unedited file round-trips byte for byte", () => {
  // ADR-0002 §7's guarantee, restated as the thing sync actually depends on: parse and re-serialize
  // has to be the identity, or the blob SHA of what we hold and of what we'd write disagree.
  const tree = localTree(files, empty, "tokens");
  assert.equal(tree.get("tokens/theme/light.json"), files[0].json);
  assert.equal(blobSha(tree.get("tokens/theme/light.json") as string), blobSha(files[0].json));
});

test("$import-report.json is dropped at the push boundary, not filtered later", () => {
  // UX §14: *"It should be impossible for it to reach the diff list."* Excluded here means no
  // caller can accidentally include it, whatever it renders.
  const tree = localTree(files, empty, "tokens");
  assert.deepEqual(Array.from(tree.keys()).sort(), ["tokens/$manifest.json", "tokens/theme/light.json"]);
  assert.equal(localTrees(files, empty).has("tokens/$import-report.json"), false);
});

test("the manifest is committed and the report is not", () => {
  const tree = localTree(files, empty, "tokens");
  assert.equal(tree.has("tokens/$manifest.json"), true);
});

test("paths land in the configured folder, once", () => {
  const tree = localTree(files, empty, "design/tokens");
  assert.deepEqual(Array.from(tree.keys()).sort(), [
    "design/tokens/$manifest.json",
    "design/tokens/theme/light.json",
  ]);
});

test("the overlay is applied to the bytes, so a push carries the edits", () => {
  const overlay: EditOverlay = {
    version: 1,
    entries: [
      {
        target: { variableId: "VariableID:1:4", modeId: "1:0" },
        path: "color.accent",
        set: "Theme/Light",
        op: "set-value",
        value: "#c33a2e",
        base: "#b4342a",
        at: "2026-09-03T00:00:00.000Z",
      },
    ],
  };
  const tree = localTree(files, overlay, "tokens");
  const written = tree.get("tokens/theme/light.json") as string;
  assert.equal(written.indexOf("#c33a2e") !== -1, true);
  assert.equal(written.indexOf("#b4342a"), -1);
  // The provenance block is carried across untouched — a round trip that reordered one key would
  // make every file look changed (UX §14, ADR-0002 §7).
  assert.equal(written.indexOf('"variableId": "VariableID:1:4"') !== -1, true);
});

test("an edit changes the blob SHA and reverting it changes it back", () => {
  const before = blobSha(localTree(files, empty, "tokens").get("tokens/theme/light.json") as string);
  const overlay: EditOverlay = {
    version: 1,
    entries: [
      {
        target: { variableId: "VariableID:1:4", modeId: "1:0" },
        path: "color.accent",
        set: "Theme/Light",
        op: "set-value",
        value: "#c33a2e",
        base: "#b4342a",
        at: "2026-09-03T00:00:00.000Z",
      },
    ],
  };
  const after = blobSha(localTree(files, overlay, "tokens").get("tokens/theme/light.json") as string);
  assert.notEqual(before, after);
  assert.equal(blobSha(localTree(files, empty, "tokens").get("tokens/theme/light.json") as string), before);
});
