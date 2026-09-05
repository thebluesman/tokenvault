// Subtype confirmations surviving a push/pull round trip to a second machine — issue #23.
//
// The bug this pins was a wiring gap, not a schema gap: `build.ts` has always committed
// `subtypeSource: "user"` into `$extensions."com.tokenvault"`, so the tags were *in* every push.
// Nothing read them back, so machine B rebuilt those tokens as `default`, re-asked for all of them,
// and — because the rebuilt `$extensions` differed from the repo's — read an untouched tree as a
// file to push. Both halves are asserted here: the push-side write, and the pull-side read.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImport } from "../src/tokens/build";
import { localTree } from "../src/git/local";
import { emptyOverlay } from "../src/tokens/overlay";
import { stableStringify } from "../src/tokens/serialize";
import { adoptUserSubtypes, extractUserSubtypesFromFiles } from "../src/tokens/subtype";
import type { FileSnapshot, ImportResult, SubtypeSelection, TokenGroup } from "../src/tokens/types";
import { IMPORTED_AT, collection, snapshot, variable } from "./helpers";

/**
 * Two numbers Figma says nothing useful about, so both arrive `subtypeSource: "default"` and both
 * are queued for confirmation — the exact population this bug re-asked about on every machine.
 */
function file(): FileSnapshot {
  const core = collection("VariableCollectionId:1:1", "Core", [["1:0", "Value"]]);
  return snapshot(
    [core],
    [
      variable("VariableID:1:15", "tv/motion/duration-fast", core.id, "FLOAT", { "1:0": 150 }),
      variable("VariableID:1:16", "tv/space/4", core.id, "FLOAT", { "1:0": 4 }),
    ]
  );
}

function build(userSubtypes: Record<string, SubtypeSelection>): ImportResult {
  return buildImport(file(), { userSubtypes, importedAt: IMPORTED_AT });
}

/** The bytes a push would write, keyed by repo path — the same function the push itself calls. */
function pushed(result: ImportResult): Map<string, string> {
  const files = result.files.map((f) => ({ path: f.path, json: stableStringify(f.content) }));
  return localTree(files, emptyOverlay(), "tokens");
}

function trees(bytes: Map<string, string>): TokenGroup[] {
  return Array.from(bytes.keys())
    .sort()
    .filter((path) => !path.startsWith("tokens/$") && !path.split("/").pop()?.startsWith("$"))
    .map((path) => JSON.parse(bytes.get(path) as string) as TokenGroup);
}

function unconfirmed(result: ImportResult): string[] {
  return result.candidates.filter((c) => c.needsConfirmation).map((c) => c.variableId);
}

// ---------------------------------------------------------------------------
// Push side — the tags reach the repo
// ---------------------------------------------------------------------------

test("a confirmed subtype is written into the pushed token JSON, not just clientStorage", () => {
  const bytes = pushed(build({ "VariableID:1:15": "duration" }));
  const json = Array.from(bytes.values()).join("\n");

  assert.ok(json.indexOf(`"subtype": "duration"`) !== -1, "the tag is in the pushed bytes");
  assert.ok(json.indexOf(`"subtypeSource": "user"`) !== -1, "and is marked as a human decision");
});

test("a deliberate untagged decision is pushed as a source with no subtype", () => {
  const bytes = pushed(build({ "VariableID:1:15": "untagged" }));
  assert.deepEqual(extractUserSubtypesFromFiles(trees(bytes)), { "VariableID:1:15": "untagged" });
});

// ---------------------------------------------------------------------------
// Pull side — the second machine reads them back
// ---------------------------------------------------------------------------

test("a second machine adopts the repo's confirmations and stops asking about them", () => {
  // Machine A confirms both, and pushes.
  const repo = pushed(build({ "VariableID:1:15": "duration", "VariableID:1:16": "spacing" }));

  // Machine B: same Figma file, empty clientStorage. Before the fix, this is the whole bug.
  const before = build({});
  assert.deepEqual(unconfirmed(before), ["VariableID:1:15", "VariableID:1:16"]);

  const adoption = adoptUserSubtypes({}, extractUserSubtypesFromFiles(trees(repo)));
  assert.deepEqual(adoption.adopted, ["VariableID:1:15", "VariableID:1:16"]);

  const after = build(adoption.subtypes);
  assert.deepEqual(unconfirmed(after), [], "nothing is re-queued for confirmation");
});

test("the round trip is diff-stable — an unchanged tree produces no spurious diff", () => {
  const repo = pushed(build({ "VariableID:1:15": "duration", "VariableID:1:16": "unitless" }));

  // Without the adoption, machine B's identical Figma file serializes to different bytes: the
  // `$extensions` say `default`/`spacing` where the repo says `user`/`duration`. That difference is
  // what made an untouched tree read as a file to push.
  const naive = pushed(build({}));
  assert.notDeepEqual(Array.from(naive.entries()), Array.from(repo.entries()));

  const adopted = pushed(build(adoptUserSubtypes({}, extractUserSubtypesFromFiles(trees(repo))).subtypes));
  assert.deepEqual(Array.from(adopted.entries()), Array.from(repo.entries()));
});

test("an untagged decision survives the round trip without being re-guessed as spacing", () => {
  const repo = pushed(build({ "VariableID:1:15": "untagged" }));
  const adopted = build(adoptUserSubtypes({}, extractUserSubtypesFromFiles(trees(repo))).subtypes);

  const token = adopted.candidates.filter((c) => c.variableId === "VariableID:1:15")[0];
  assert.equal(token.subtype, undefined);
  assert.equal(token.subtypeSource, "user");
  assert.equal(token.needsConfirmation, false);
});

test("a repo written before this fix carries no user tags, and adoption is a no-op", () => {
  // Every token in it is `auto` or `default`, which is not a decision anybody made.
  const repo = pushed(build({}));
  const adoption = adoptUserSubtypes({}, extractUserSubtypesFromFiles(trees(repo)));
  assert.deepEqual(adoption, { subtypes: {}, adopted: [], kept: [] });
});
