import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adoptUserSubtypes,
  extractUserSubtypes,
  extractUserSubtypesFromFiles,
  resolveSubtype,
} from "../src/tokens/subtype";
import type { SubtypeSelection, TokenGroup } from "../src/tokens/types";

test("OPACITY scope auto-tags opacity — the one rule PRD §6.1 names explicitly", () => {
  assert.deepEqual(resolveSubtype("number", ["OPACITY"], undefined), {
    subtype: "opacity",
    subtypeSource: "auto",
  });
});

test("the other unambiguous scopes auto-tag per ADR §3", () => {
  assert.deepEqual(resolveSubtype("number", ["CORNER_RADIUS"], undefined), {
    subtype: "radius",
    subtypeSource: "auto",
  });
  assert.deepEqual(resolveSubtype("number", ["WIDTH_HEIGHT"], undefined), {
    subtype: "sizing",
    subtypeSource: "auto",
  });
  assert.deepEqual(resolveSubtype("number", ["GAP"], undefined), {
    subtype: "spacing",
    subtypeSource: "auto",
  });
});

test("OPACITY wins when a variable carries several mappable scopes", () => {
  assert.deepEqual(resolveSubtype("number", ["GAP", "OPACITY", "CORNER_RADIUS"], undefined), {
    subtype: "opacity",
    subtypeSource: "auto",
  });
});

test("ALL_SCOPES and non-numeric scopes fall back to the unconfirmed default", () => {
  for (const scopes of [["ALL_SCOPES"], [], ["TEXT_CONTENT"], ["STROKE_FLOAT"], ["EFFECT_FLOAT"]]) {
    assert.deepEqual(
      resolveSubtype("number", scopes, undefined),
      { subtype: "spacing", subtypeSource: "default" },
      `scopes ${JSON.stringify(scopes)} should default`
    );
  }
});

test("a user tag always beats auto-detection", () => {
  assert.deepEqual(resolveSubtype("number", ["OPACITY"], "duration"), {
    subtype: "duration",
    subtypeSource: "user",
  });
});

test("duration and easing are only ever reachable through a user tag", () => {
  // No VariableScope implies either, so nothing auto-detects them (commits e7098cf/eb32ea9).
  const everyScope = [
    "ALL_SCOPES",
    "TEXT_CONTENT",
    "CORNER_RADIUS",
    "WIDTH_HEIGHT",
    "GAP",
    "OPACITY",
    "STROKE_FLOAT",
    "EFFECT_FLOAT",
    "FONT_SIZE",
    "LINE_HEIGHT",
  ];
  for (const scope of everyScope) {
    const tag = resolveSubtype("number", [scope], undefined);
    assert.notEqual(tag.subtype, "duration", `${scope} must not auto-detect duration`);
  }
  assert.deepEqual(resolveSubtype("string", ["ALL_SCOPES"], "easing"), {
    subtype: "easing",
    subtypeSource: "user",
  });
});

test("an untagged string stays untagged, and colours/booleans have no subtype at all", () => {
  assert.deepEqual(resolveSubtype("string", ["ALL_SCOPES"], undefined), {});
  assert.deepEqual(resolveSubtype("color", ["ALL_FILLS"], undefined), {});
  assert.deepEqual(resolveSubtype("boolean", [], undefined), {});
});

test("a subtype that is invalid for the token type is ignored, not written through", () => {
  // `easing` is string-only; `spacing` is number-only.
  assert.deepEqual(resolveSubtype("number", [], "easing"), {
    subtype: "spacing",
    subtypeSource: "default",
  });
  assert.deepEqual(resolveSubtype("string", [], "spacing"), {});
});

function tree(): TokenGroup {
  return {
    tv: {
      global: {
        "duration-fast": {
          $type: "number",
          $value: 150,
          $extensions: {
            "com.tokenvault": {
              subtype: "duration",
              subtypeSource: "user",
              figma: { variableId: "VariableID:1:15", collectionId: "c", modeId: "m", scopes: [] },
            },
          },
        },
        "space-4": {
          $type: "number",
          $value: 4,
          $extensions: {
            "com.tokenvault": {
              subtype: "spacing",
              subtypeSource: "default",
              figma: { variableId: "VariableID:1:13", collectionId: "c", modeId: "m", scopes: [] },
            },
          },
        },
        opacity: {
          $type: "number",
          $value: 0.4,
          $extensions: {
            "com.tokenvault": {
              subtype: "opacity",
              subtypeSource: "auto",
              figma: { variableId: "VariableID:1:14", collectionId: "c", modeId: "m", scopes: [] },
            },
          },
        },
      },
    },
  };
}

test("re-import reads back only user tags, keyed by variable id", () => {
  // ADR §3: user tags are preserved; auto and default tags are recomputed.
  assert.deepEqual(extractUserSubtypes(tree()), { "VariableID:1:15": "duration" });
});

test("extracting from an empty tree yields nothing", () => {
  assert.deepEqual(extractUserSubtypes({}), {});
});

test("user tags merge across the token files of a whole tree", () => {
  const second: TokenGroup = {
    a: {
      $type: "string",
      $value: "ease-out",
      $extensions: {
        "com.tokenvault": {
          subtype: "easing",
          subtypeSource: "user",
          figma: { variableId: "VariableID:2:1", collectionId: "c", modeId: "m", scopes: [] },
        },
      },
    },
  };
  assert.deepEqual(extractUserSubtypesFromFiles([tree(), second]), {
    "VariableID:1:15": "duration",
    "VariableID:2:1": "easing",
  });
});

test("an explicit untagged choice leaves a number genuinely unset, not re-guessed as spacing", () => {
  // The UI's "untagged" option used to fall through to DEFAULT_NUMBER_SUBTYPE, silently
  // reclassifying a cleared "duration" as "spacing".
  assert.deepEqual(resolveSubtype("number", ["ALL_SCOPES"], "untagged"), { subtypeSource: "user" });
  assert.deepEqual(resolveSubtype("string", ["ALL_SCOPES"], "untagged"), { subtypeSource: "user" });
});

test("untagged beats auto-detection, the same way a real tag does", () => {
  assert.deepEqual(resolveSubtype("number", ["OPACITY"], "untagged"), { subtypeSource: "user" });
});

test("clearing the choice entirely is different from choosing untagged", () => {
  // `undefined` means nobody has said anything, so auto-detection runs again.
  assert.deepEqual(resolveSubtype("number", ["OPACITY"], undefined), {
    subtype: "opacity",
    subtypeSource: "auto",
  });
});

test("an untagged decision round-trips through the generated token files", () => {
  const untagged: TokenGroup = {
    a: {
      $type: "number",
      $value: 12,
      $extensions: {
        "com.tokenvault": {
          subtypeSource: "user",
          figma: { variableId: "VariableID:9:1", collectionId: "c", modeId: "m", scopes: [] },
        },
      },
    },
  };
  assert.deepEqual(extractUserSubtypes(untagged), { "VariableID:9:1": "untagged" });
});

// ---------------------------------------------------------------------------
// Adoption — issue #23
// ---------------------------------------------------------------------------

test("adoption fills the gaps: a device with no answers takes every one of the repo's", () => {
  const result = adoptUserSubtypes({}, { "VariableID:1:1": "duration", "VariableID:1:2": "easing" });
  assert.deepEqual(result.subtypes, { "VariableID:1:1": "duration", "VariableID:1:2": "easing" });
  assert.deepEqual(result.adopted, ["VariableID:1:1", "VariableID:1:2"]);
  assert.deepEqual(result.kept, []);
});

test("a local answer is never overwritten by the repo's — it is kept and reported", () => {
  const result = adoptUserSubtypes({ "VariableID:1:1": "radius" }, { "VariableID:1:1": "spacing" });
  assert.deepEqual(result.subtypes, { "VariableID:1:1": "radius" });
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.kept, ["VariableID:1:1"]);
});

test("agreement is neither an adoption nor a disagreement", () => {
  const result = adoptUserSubtypes({ "VariableID:1:1": "radius" }, { "VariableID:1:1": "radius" });
  assert.deepEqual(result.adopted, []);
  assert.deepEqual(result.kept, []);
});

test("a local tag the repo says nothing about is left alone", () => {
  const result = adoptUserSubtypes({ "VariableID:1:1": "duration" }, {});
  assert.deepEqual(result.subtypes, { "VariableID:1:1": "duration" });
  assert.deepEqual(result.adopted, []);
});

test("an untagged decision is adopted like any other — it is an answer, not an absence", () => {
  const result = adoptUserSubtypes({}, { "VariableID:1:1": "untagged" });
  assert.deepEqual(result.subtypes, { "VariableID:1:1": "untagged" });
  assert.deepEqual(result.adopted, ["VariableID:1:1"]);
});

test("locally untagged beats a repo tag, the same as any other local answer", () => {
  const result = adoptUserSubtypes({ "VariableID:1:1": "untagged" }, { "VariableID:1:1": "spacing" });
  assert.deepEqual(result.subtypes, { "VariableID:1:1": "untagged" });
  assert.deepEqual(result.kept, ["VariableID:1:1"]);
});

test("adoption does not mutate the store it was handed", () => {
  const local: Record<string, SubtypeSelection> = { "VariableID:1:1": "radius" };
  adoptUserSubtypes(local, { "VariableID:1:2": "spacing" });
  assert.deepEqual(local, { "VariableID:1:1": "radius" });
});

test("the reports are sorted, so two devices reading the same repo agree on the order", () => {
  const result = adoptUserSubtypes({}, {
    "VariableID:1:9": "spacing",
    "VariableID:1:2": "radius",
    "VariableID:1:5": "duration",
  });
  assert.deepEqual(result.adopted, ["VariableID:1:2", "VariableID:1:5", "VariableID:1:9"]);
});
