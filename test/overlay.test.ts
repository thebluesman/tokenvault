// The local edit overlay and its rescan three-way merge — ADR-0004.
//
// The merge table (§4) is the thing worth the most test weight: it is the difference between a
// rescan that reconciles and a rescan that clobbers, and every one of its four rows has a
// user-visible consequence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Token, TokenFileOutput, TokenGroup } from "../src/tokens/types";
import type { EditOverlay, OverlayEntry } from "../src/tokens/overlay";
import type { FlatToken } from "../src/tokens/view";
import {
  applyOverlay,
  applyOverlayToFiles,
  dropEntries,
  dropEntry,
  emptyOverlay,
  entryRefs,
  localEntries,
  indexOverlay,
  keepMine,
  mergeOverlay,
  parseOverlay,
  recordEdit,
  removeEntries,
  targetKey,
  targetOfToken,
  tokenKey,
  valuesEqual,
} from "../src/tokens/overlay";

const NOW = "2026-09-01T12:00:00.000Z";

function variableToken(variableId: string, modeId: string, value: unknown): Token {
  return {
    $type: "color",
    $value: value as Token["$value"],
    $extensions: {
      "com.tokenvault": {
        figma: { variableId, modeId, collectionId: "VariableCollectionId:1:1", scopes: ["ALL_SCOPES"] },
      },
    },
  };
}

function styleToken(styleId: string, value: unknown): Token {
  return {
    $type: "shadow",
    $value: value as Token["$value"],
    $extensions: { "com.tokenvault": { figma: { styleId, styleKey: "k", styleType: "EFFECT" } } },
  };
}

function flat(path: string, setId: string, token: Token): FlatToken {
  return { path, segments: path.split("."), setId, token };
}

function overlayOf(...entries: Array<Omit<OverlayEntry, "at">>): EditOverlay {
  return { version: 1, entries: entries.map((entry) => ({ ...entry, at: NOW })) };
}

const LIGHT = flat("folio.color.accent", "Theme/Light", variableToken("VariableID:1:4", "1:0", "#c33a2e"));
const DARK = flat("folio.color.accent", "Theme/Dark", variableToken("VariableID:1:4", "1:1", "#f0a19a"));

// ---------------------------------------------------------------------------
// Identity — ADR-0004 §2
// ---------------------------------------------------------------------------

test("a Variables edit keys on variableId AND modeId", () => {
  // One variable holds a value per mode, so keying on variableId alone would let an edit to
  // `Theme/Light` leak into `Theme/Dark`.
  assert.notEqual(tokenKey(LIGHT.token), tokenKey(DARK.token));
  assert.equal(targetKey({ variableId: "VariableID:1:4", modeId: "1:0" }), tokenKey(LIGHT.token));
});

test("a Styles edit keys on styleId alone", () => {
  const token = styleToken("S:abc,", { blur: { unit: "px", value: 1 } });
  assert.deepEqual(targetOfToken(token), { styleId: "S:abc," });
  assert.equal(targetKey({ styleId: "S:abc," }), tokenKey(token));
});

test("a variable id with no mode cannot key an edit", () => {
  assert.equal(targetKey({ variableId: "VariableID:1:4" }), null);
  assert.equal(targetKey({}), null);
});

test("ids containing colons still key unambiguously", () => {
  // The joiner has to be a character the parts cannot contain; Figma ids are full of colons.
  assert.notEqual(
    targetKey({ variableId: "VariableID:1", modeId: "4:1:0" }),
    targetKey({ variableId: "VariableID:1:4", modeId: "1:0" })
  );
});

test("values compare by their serialized form, so equality means byte-identical", () => {
  assert.equal(valuesEqual({ a: 1, b: 2 } as never, { b: 2, a: 1 } as never), true);
  assert.equal(valuesEqual("#c33a2e", "#c33a2e"), true);
  assert.equal(valuesEqual("#c33a2e", "#c33a2eff"), false);
  assert.equal(valuesEqual(undefined, undefined), true);
  assert.equal(valuesEqual(undefined, ""), false);
});

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

test("an edit applies to its own set's token and no other", () => {
  const overlay = overlayOf({
    target: { variableId: "VariableID:1:4", modeId: "1:0" },
    path: LIGHT.path,
    set: LIGHT.setId,
    op: "set-value",
    value: "#000000",
    base: "#c33a2e",
  });

  const applied = applyOverlay([LIGHT, DARK], overlay);
  assert.equal(applied.tokens[0].token.$value, "#000000");
  assert.equal(applied.tokens[1].token.$value, "#f0a19a", "the Dark line must be untouched");
  assert.equal(applied.edited.size, 1);
});

test("applying an edit does not rebuild $extensions", () => {
  const overlay = overlayOf({
    target: { variableId: "VariableID:1:4", modeId: "1:0" },
    path: LIGHT.path,
    set: LIGHT.setId,
    op: "set-value",
    value: "#000000",
    base: "#c33a2e",
  });
  const applied = applyOverlay([LIGHT], overlay);
  assert.equal(
    applied.tokens[0].token.$extensions["com.tokenvault"],
    LIGHT.token.$extensions["com.tokenvault"]
  );
});

test("a tombstone removes the token from the tree", () => {
  const overlay = overlayOf({
    target: { variableId: "VariableID:1:4", modeId: "1:1" },
    path: DARK.path,
    set: DARK.setId,
    op: "delete",
  });
  const applied = applyOverlay([LIGHT, DARK], overlay);
  assert.equal(applied.tokens.length, 1);
  assert.equal(applied.tokens[0].setId, "Theme/Light");
  assert.equal(applied.deleted.size, 1);
});

test("a description edit with an empty value removes $description", () => {
  const described = flat("a.b", "S", {
    ...variableToken("VariableID:9", "1:0", "#fff"),
    $description: "old",
  });
  const overlay = overlayOf({
    target: { variableId: "VariableID:9", modeId: "1:0" },
    path: "a.b",
    set: "S",
    op: "set-description",
    value: "",
    base: "old",
  });
  const applied = applyOverlay([described], overlay);
  assert.equal("$description" in applied.tokens[0].token, false);
});

test("an orphaned entry is not applied to the tree", () => {
  const overlay: EditOverlay = {
    version: 1,
    entries: [
      {
        target: { variableId: "VariableID:1:4", modeId: "1:0" },
        path: LIGHT.path,
        set: LIGHT.setId,
        op: "set-value",
        value: "#000000",
        base: "#c33a2e",
        at: NOW,
        orphaned: true,
      },
    ],
  };
  assert.equal(indexOverlay(overlay).size, 0);
  assert.equal(applyOverlay([LIGHT], overlay).tokens[0].token.$value, "#c33a2e");
});

// ---------------------------------------------------------------------------
// The merge table — ADR-0004 §4
// ---------------------------------------------------------------------------

function valueEdit(value: string, base: string): Omit<OverlayEntry, "at"> {
  return {
    target: { variableId: "VariableID:1:4", modeId: "1:0" },
    path: LIGHT.path,
    set: LIGHT.setId,
    op: "set-value",
    value,
    base,
  };
}

test("Figma has not moved — the edit reapplies silently, the common case", () => {
  const merged = mergeOverlay([LIGHT], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  assert.equal(merged.applied, 1);
  assert.equal(merged.conflicts, 0);
  assert.equal(merged.entries.length, 0, "a silent reapply must not report anything");
  assert.equal(merged.overlay.entries.length, 1);
});

test("Figma caught up to the edit — the entry retires silently", () => {
  const caught = flat(LIGHT.path, LIGHT.setId, variableToken("VariableID:1:4", "1:0", "#000000"));
  const merged = mergeOverlay([caught], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  assert.equal(merged.overlay.entries.length, 0);
  assert.equal(merged.retired, 1);
  assert.equal(merged.entries.length, 0);
});

test("a rescan conflict keeps an outstanding repo conflict alongside it", () => {
  // A token can conflict with both sides at once: a pull landed on the edit, and then Figma moved
  // too. Overwriting one flag with the other loses the value the user is choosing against, so the
  // earlier side is carried on `previous` — one level deep, because there are only two sides.
  const moved = flat(LIGHT.path, LIGHT.setId, variableToken("VariableID:1:4", "1:0", "#b4342a"));
  const pulled = overlayOf({
    ...valueEdit("#000000", "#c33a2e"),
    conflict: { figma: "#123456" as Token["$value"], at: NOW, origin: "repo" as const },
  });

  const merged = mergeOverlay([moved], pulled, NOW);
  const conflict = merged.overlay.entries[0].conflict;
  assert.equal(conflict?.figma, "#b4342a");
  assert.equal(conflict?.previous?.origin, "repo");
  assert.equal(conflict?.previous?.figma, "#123456");

  // A second rescan is the same side again — it refreshes rather than stacking another level.
  const again = mergeOverlay([moved], merged.overlay, NOW);
  assert.equal(again.overlay.entries[0].conflict?.previous?.origin, "repo");
  assert.equal(again.overlay.entries[0].conflict?.previous?.previous, undefined);
});

test("both sides moved — the local edit wins and is reported as edit-conflict", () => {
  const moved = flat(LIGHT.path, LIGHT.setId, variableToken("VariableID:1:4", "1:0", "#b4342a"));
  const merged = mergeOverlay([moved], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);

  assert.equal(merged.conflicts, 1);
  assert.equal(merged.applied, 1, "the local edit is still applied — it is the irreplaceable side");
  assert.equal(merged.entries[0].kind, "edit-conflict");
  assert.equal(merged.entries[0].path, LIGHT.path);
  assert.deepEqual(merged.overlay.entries[0].conflict?.figma, "#b4342a");
  assert.equal(applyOverlay([moved], merged.overlay).tokens[0].token.$value, "#000000");
});

test("the target is gone — the entry is flagged orphaned and kept, not dropped", () => {
  const merged = mergeOverlay([DARK], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  assert.equal(merged.orphaned, 1);
  assert.equal(merged.entries[0].kind, "orphaned-edit");
  // Kept so the value can still be copied out before it is discarded (UX §5.5); an edit that
  // vanished with its token would be unrecoverable.
  assert.equal(merged.overlay.entries.length, 1);
  assert.equal(merged.overlay.entries[0].orphaned, true);
});

test("a tombstone whose target still exists is not a conflict", () => {
  const overlay = overlayOf({
    target: { variableId: "VariableID:1:4", modeId: "1:0" },
    path: LIGHT.path,
    set: LIGHT.setId,
    op: "delete",
  });
  const merged = mergeOverlay([LIGHT], overlay, NOW);
  assert.equal(merged.conflicts, 0);
  assert.equal(merged.overlay.entries.length, 1, "suppressing re-derivation is what it is for");
});

test("a tombstone whose target is gone from Figma retires silently — it got what it wanted", () => {
  const overlay = overlayOf({
    target: { variableId: "VariableID:1:4", modeId: "1:0" },
    path: LIGHT.path,
    set: LIGHT.setId,
    op: "delete",
  });
  const merged = mergeOverlay([DARK], overlay, NOW);
  assert.equal(merged.overlay.entries.length, 0);
  assert.equal(merged.orphaned, 0);
  assert.equal(merged.entries.length, 0);
});

test("a surviving entry's path and set are refreshed from provenance, never used to match", () => {
  // The designer renamed the variable in Figma between scans. The path moved; the id did not.
  const renamed = flat("folio.color.brand", "Theme/Light", variableToken("VariableID:1:4", "1:0", "#c33a2e"));
  const merged = mergeOverlay([renamed], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  assert.equal(merged.applied, 1);
  assert.equal(merged.overlay.entries[0].path, "folio.color.brand");
});

test("a description conflict is reported the same way a value conflict is", () => {
  const described = flat(LIGHT.path, LIGHT.setId, {
    ...variableToken("VariableID:1:4", "1:0", "#c33a2e"),
    $description: "from figma",
  });
  const overlay = overlayOf({
    target: { variableId: "VariableID:1:4", modeId: "1:0" },
    path: LIGHT.path,
    set: LIGHT.setId,
    op: "set-description",
    value: "mine",
    base: "original",
  });
  const merged = mergeOverlay([described], overlay, NOW);
  assert.equal(merged.entries[0].kind, "edit-conflict");
  assert.equal(merged.entries[0].reason, "description-diverged");
});

test("an empty overlay merges to nothing and reports nothing", () => {
  const merged = mergeOverlay([LIGHT, DARK], emptyOverlay(), NOW);
  assert.deepEqual(merged, {
    overlay: emptyOverlay(),
    entries: [],
    applied: 0,
    conflicts: 0,
    orphaned: 0,
    retired: 0,
  });
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test("re-editing an already-edited token keeps the original base", () => {
  const first = recordEdit(emptyOverlay(), valueEdit("#111111", "#c33a2e"), NOW);
  const second = recordEdit(first, valueEdit("#222222", "#111111"), NOW);
  assert.equal(second.entries.length, 1);
  assert.equal(
    second.entries[0].base,
    "#c33a2e",
    "rebasing on each edit would erase what Figma said when the edit started"
  );
  assert.equal(second.entries[0].value, "#222222");
});

test("an edit back to the imported value drops the entry instead of storing a no-op", () => {
  const first = recordEdit(emptyOverlay(), valueEdit("#111111", "#c33a2e"), NOW);
  const back = recordEdit(first, valueEdit("#c33a2e", "#c33a2e"), NOW);
  assert.equal(back.entries.length, 0, "the Local edits chip counts differences, not visits");
});

test("value and description edits on one target coexist", () => {
  let overlay = recordEdit(emptyOverlay(), valueEdit("#111111", "#c33a2e"), NOW);
  overlay = recordEdit(
    overlay,
    {
      target: { variableId: "VariableID:1:4", modeId: "1:0" },
      path: LIGHT.path,
      set: LIGHT.setId,
      op: "set-description",
      value: "mine",
      base: "",
    },
    NOW
  );
  assert.equal(overlay.entries.length, 2);
});

test("a delete supersedes the value and description edits on the same target", () => {
  let overlay = recordEdit(emptyOverlay(), valueEdit("#111111", "#c33a2e"), NOW);
  overlay = recordEdit(
    overlay,
    { target: { variableId: "VariableID:1:4", modeId: "1:0" }, path: LIGHT.path, set: LIGHT.setId, op: "delete" },
    NOW
  );
  assert.equal(overlay.entries.length, 1);
  assert.equal(overlay.entries[0].op, "delete");
});

test("an entry with an unkeyable target is refused rather than stored unmatched", () => {
  const overlay = recordEdit(
    emptyOverlay(),
    { target: {}, path: "a.b", set: "S", op: "set-value", value: 1, base: 2 },
    NOW
  );
  assert.equal(overlay.entries.length, 0);
});

test("removeEntries drops every op for a target; dropEntry drops just one", () => {
  let overlay = recordEdit(emptyOverlay(), valueEdit("#111111", "#c33a2e"), NOW);
  overlay = recordEdit(
    overlay,
    { target: { variableId: "VariableID:1:4", modeId: "1:0" }, path: LIGHT.path, set: LIGHT.setId, op: "set-description", value: "x", base: "" },
    NOW
  );
  assert.equal(dropEntry(overlay, { variableId: "VariableID:1:4", modeId: "1:0" }, "set-value").entries.length, 1);
  assert.equal(removeEntries(overlay, { variableId: "VariableID:1:4", modeId: "1:0" }).entries.length, 0);
});

test("a bulk undo is scoped to the entries it was shown, never the whole overlay", () => {
  // The regression: the Changes list's *Undo all* sits on a tab that filters conflicts out, and it
  // used to clear the entire overlay. Undoing the two edits on screen therefore also discarded a
  // conflict the button had never displayed — a resolution the user is being asked to make one at
  // a time in a different tab, silently thrown away by a button that named neither.
  //
  // The fix is that the list and the scope are the same function, which is what this asserts.
  const clean = { variableId: "VariableID:1:4", modeId: "1:0" };
  const other = { variableId: "VariableID:2:2", modeId: "1:0" };
  const disputed = { variableId: "VariableID:3:3", modeId: "1:0" };

  const overlay: EditOverlay = {
    version: 1,
    entries: [
      { target: clean, path: "a.b", set: "S", op: "set-value", value: "#c33a2e", base: "#111111", at: NOW },
      { target: clean, path: "a.b", set: "S", op: "set-description", value: "x", base: "", at: NOW },
      { target: other, path: "c.d", set: "S", op: "delete", at: NOW },
      {
        target: disputed,
        path: "e.f",
        set: "S",
        op: "set-value",
        value: "#0d99ff",
        base: "#000000",
        at: NOW,
        conflict: { figma: "#b4342a", at: NOW },
      },
    ],
  };

  const shown = localEntries(overlay);
  assert.equal(shown.length, 3);
  assert.equal(
    shown.some((entry) => targetKey(entry.target) === targetKey(disputed)),
    false
  );

  const after = dropEntries(overlay, entryRefs(shown));
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].conflict?.figma, "#b4342a");
  // And the sibling op on a target is dropped by name, not by target: a target carrying both a
  // value and a description edit has two rows in the list and both were on screen.
  assert.equal(
    after.entries.some((entry) => targetKey(entry.target) === targetKey(clean)),
    false
  );
});

test("a scoped undo of one row leaves the other rows on the same target alone", () => {
  const target = { variableId: "VariableID:1:4", modeId: "1:0" };
  const overlay: EditOverlay = {
    version: 1,
    entries: [
      { target, path: "a.b", set: "S", op: "set-value", value: "#c33a2e", base: "#111111", at: NOW },
      { target, path: "a.b", set: "S", op: "set-description", value: "x", base: "", at: NOW },
    ],
  };
  const after = dropEntries(overlay, [{ target, op: "set-value" }]);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].op, "set-description");
});

test("keep-mine rebases on Figma's value so the same conflict does not re-report", () => {
  const moved = flat(LIGHT.path, LIGHT.setId, variableToken("VariableID:1:4", "1:0", "#b4342a"));
  const merged = mergeOverlay([moved], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  const kept = keepMine(merged.overlay, { variableId: "VariableID:1:4", modeId: "1:0" }, "set-value");

  assert.equal(kept.entries[0].conflict, undefined);
  assert.equal(kept.entries[0].base, "#b4342a");
  const again = mergeOverlay([moved], kept, NOW);
  assert.equal(again.conflicts, 0, "the flag the user already answered must stop firing");
});

test("resolving a conflict either way clears the report entry, not just the conflict field", () => {
  // The `⚑ conflict` badge and the Import tab's Flagged count read the *report*, not the overlay,
  // so a resolution only clears them once the import payload is re-derived — which is why
  // `code.ts` re-emits it after a resolution instead of posting `overlay-state` alone.
  const target = { variableId: "VariableID:1:4", modeId: "1:0" };
  const moved = flat(LIGHT.path, LIGHT.setId, variableToken("VariableID:1:4", "1:0", "#b4342a"));
  const merged = mergeOverlay([moved], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  assert.equal(merged.entries.length, 1);

  const kept = keepMine(merged.overlay, target, "set-value");
  assert.deepEqual(mergeOverlay([moved], kept, NOW).entries, [], "keep mine");

  const taken = dropEntry(merged.overlay, target, "set-value");
  assert.deepEqual(mergeOverlay([moved], taken, NOW).entries, [], "take Figma's");
});

test("discarding an orphaned edit clears its report entry on the next derive", () => {
  const target = { variableId: "VariableID:1:4", modeId: "1:0" };
  const merged = mergeOverlay([DARK], overlayOf(valueEdit("#000000", "#c33a2e")), NOW);
  assert.equal(merged.entries[0].kind, "orphaned-edit");

  const again = mergeOverlay([DARK], removeEntries(merged.overlay, target), NOW);
  assert.equal(again.orphaned, 0);
  assert.deepEqual(again.entries, []);
});

test("the target-key joiner is written as an escape, so the source stays a text file", () => {
  // A literal NUL byte in the source makes git classify the file as binary, which takes it out of
  // the PR diff entirely — and every change here has to be reviewable line by line before it
  // lands. `\0` in source has identical runtime semantics.
  const source = readFileSync("src/tokens/overlay.ts", "utf8");
  assert.equal(source.indexOf("\0"), -1, "src/tokens/overlay.ts must not contain a raw NUL byte");
  assert.equal(targetKey({ styleId: "S:abc," }), `style\0S:abc,`);
});

// ---------------------------------------------------------------------------
// Serializing the edited tree
// ---------------------------------------------------------------------------

test("the copied tree carries the overlay, and a delete prunes the group it empties", () => {
  const tree: TokenGroup = {
    folio: {
      color: {
        accent: variableToken("VariableID:1:4", "1:0", "#c33a2e"),
      },
      space: {
        small: variableToken("VariableID:2:2", "1:0", "#111111"),
      },
    },
  };
  const files: TokenFileOutput[] = [
    { path: "tokens/theme/light.json", content: tree },
    { path: "tokens/$manifest.json", content: { version: 2 } as never },
  ];

  const overlay = overlayOf(
    { target: { variableId: "VariableID:1:4", modeId: "1:0" }, path: "folio.color.accent", set: "S", op: "delete" },
    {
      target: { variableId: "VariableID:2:2", modeId: "1:0" },
      path: "folio.space.small",
      set: "S",
      op: "set-value",
      value: "#999999",
      base: "#111111",
    }
  );

  const written = applyOverlayToFiles(files, overlay);
  const light = written[0].content as TokenGroup;
  const folio = light.folio as TokenGroup;
  assert.equal("color" in folio, false, "a group emptied by deletion is dropped, not left as {}");
  assert.equal(((folio.space as TokenGroup).small as Token).$value, "#999999");
  assert.equal(written[1], files[1], "the manifest and report are not overlay targets");
});

test("an empty overlay returns the files untouched", () => {
  const files: TokenFileOutput[] = [{ path: "tokens/a.json", content: {} }];
  assert.equal(applyOverlayToFiles(files, emptyOverlay()), files);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("a missing, malformed or future-versioned store reads as no edits", () => {
  assert.deepEqual(parseOverlay(null), emptyOverlay());
  assert.deepEqual(parseOverlay("nonsense"), emptyOverlay());
  assert.deepEqual(parseOverlay({ version: 2, entries: [] }), emptyOverlay());
  assert.deepEqual(parseOverlay({ version: 1 }), emptyOverlay());
});

test("stored entries that could never match a token again are dropped on load", () => {
  const parsed = parseOverlay({
    version: 1,
    entries: [
      { target: { variableId: "VariableID:1:4", modeId: "1:0" }, op: "set-value", path: "a", set: "S", value: 1 },
      { target: { variableId: "VariableID:1:4" }, op: "set-value", path: "a", set: "S", value: 1 },
      { target: { styleId: "S:x," }, op: "rename", path: "a", set: "S" },
      null,
    ],
  });
  assert.equal(parsed.entries.length, 1);
});
