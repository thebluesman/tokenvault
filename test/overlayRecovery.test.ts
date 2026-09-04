// Reading a corrupt overlay — UX `error-states.md` §4, ADR-0004 §1 and §6.
//
// This is the one of Phase 9's three new error states where getting it wrong loses user data, and it
// is pure, so it is tested properly rather than inspected. The property that matters is not "bad
// input doesn't throw" — Phase 4 already had that — it is that **the four outcomes stay distinct**.
// `"empty"` and `"unreadable"` both produce an empty overlay, and collapsing them is exactly the bug
// this shipped to fix: a file whose edits failed to load used to open looking like a file that had
// none, and the next edit overwrote the evidence.

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyOverlay, parseOverlay, readOverlay } from "../src/tokens/overlay";
import type { OverlayEntry } from "../src/tokens/overlay";

function entry(variableId: string): OverlayEntry {
  return {
    target: { variableId, modeId: "1:0" },
    op: "set-value",
    value: "#c33a2e",
    base: "#b4342a",
    at: "2026-09-04T10:00:00.000Z",
  } as OverlayEntry;
}

test("a store that was never written is empty, not corrupt", () => {
  for (const stored of [undefined, null]) {
    const read = readOverlay(stored);
    assert.equal(read.outcome, "empty");
    assert.deepEqual(read.overlay, emptyOverlay());
    assert.equal(read.kept, 0);
    assert.equal(read.dropped, 0);
  }
});

test("a well-formed overlay reads clean, including a well-formed empty one", () => {
  const read = readOverlay({ version: 1, entries: [entry("VariableID:1:4"), entry("VariableID:1:5")] });
  assert.equal(read.outcome, "ok");
  assert.equal(read.kept, 2);
  assert.equal(read.dropped, 0);

  // Read correctly, holds nothing: `"ok"`, never `"empty"`. Nothing is reported either way, but the
  // two are different facts and the notice logic keys off the difference.
  const none = readOverlay({ version: 1, entries: [] });
  assert.equal(none.outcome, "ok");
  assert.equal(none.kept, 0);
});

test("a blob that is not an overlay at all is unreadable, not empty", () => {
  // The distinction the whole state exists for: an empty overlay here means the user's edits failed
  // to load, and the panel has to say so rather than opening as if there were none.
  for (const stored of ["nonsense", 42, { version: 2, entries: [] }, { version: 1 }, { version: 1, entries: {} }]) {
    const read = readOverlay(stored);
    assert.equal(read.outcome, "unreadable", `${JSON.stringify(stored)} should be unreadable`);
    assert.deepEqual(read.overlay, emptyOverlay());
  }
});

test("one bad entry costs one entry, not the whole overlay", () => {
  // The recovery policy in a sentence (§4.1.1). Forty edits are not discarded because the
  // thirty-ninth is malformed.
  const read = readOverlay({
    version: 1,
    entries: [
      entry("VariableID:1:4"),
      null,
      "not an entry",
      { op: "rename", target: { variableId: "VariableID:1:9", modeId: "1:0" } },
      { op: "set-value", target: {} },
      entry("VariableID:1:5"),
    ],
  });

  assert.equal(read.outcome, "partial");
  assert.equal(read.kept, 2);
  assert.equal(read.dropped, 4);
  assert.deepEqual(
    read.overlay.entries.map((each) => each.target.variableId),
    ["VariableID:1:4", "VariableID:1:5"]
  );
});

test("dropped entries are counted, not silently skipped", () => {
  // Phase 4 dropped these on the floor with a `continue`. The count is the whole difference between
  // a notice that can be written and a loss that cannot be reported.
  const read = readOverlay({ version: 1, entries: [{ op: "set-value", target: {} }] });
  assert.equal(read.outcome, "partial");
  assert.equal(read.kept, 0);
  assert.equal(read.dropped, 1);
  // Still usable — nothing recovered is not the same as nothing works.
  assert.deepEqual(read.overlay, emptyOverlay());
});

test("kept + dropped accounts for every entry in the blob", () => {
  // The notice says "38 of 41 were recovered", so the arithmetic has to close over the stored list
  // or the sentence is a lie. Asserted as a property rather than on one example.
  const entries: unknown[] = [];
  for (let index = 0; index < 41; index += 1) {
    entries.push(index % 7 === 0 ? { op: "nope" } : entry(`VariableID:1:${index}`));
  }
  const read = readOverlay({ version: 1, entries });
  assert.equal(read.kept + read.dropped, entries.length);
  assert.equal(read.kept, read.overlay.entries.length);
});

test("parseOverlay keeps Phase 4's behaviour exactly", () => {
  // Kept as a wrapper so every existing caller and test is unaffected by the richer read.
  assert.deepEqual(parseOverlay(null), emptyOverlay());
  assert.deepEqual(parseOverlay("nonsense"), emptyOverlay());
  assert.deepEqual(parseOverlay({ version: 1, entries: [entry("VariableID:1:4")] }).entries.length, 1);
});
