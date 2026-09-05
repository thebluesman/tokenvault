// Subtype confirmations surviving a push/pull round trip to a second machine — issue #23.
//
// The bug this pins was a wiring gap, not a schema gap: `build.ts` has always committed
// `subtypeSource: "user"` into `$extensions."com.tokenvault"`, so the tags were *in* every push.
// Nothing read them back, so machine B rebuilt those tokens as `default`, re-asked for all of them,
// and — because the rebuilt `$extensions` differed from the repo's — read an untouched tree as a
// file to push. Both halves are asserted here: the push-side write, and the pull-side read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// --- Source inspection, for the half of the fix that lives in the sandbox controller ---

const ROOT = process.cwd();

/** Strips comments, so a rule *discussed* in prose isn't mistaken for the thing it forbids. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** One function's body, brace-matched from its declaration. */
function body(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail(`${declaration} is unbalanced`);
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

// ---------------------------------------------------------------------------
// Connect before scan — the first-run order that made the fix a no-op
// ---------------------------------------------------------------------------

test("adoption needs no prior import — the tags land, and the first scan reads them", () => {
  // The order this pins: open the file, connect a repo, adopt it — all before anything has scanned
  // Figma. `maybeFirstConnect` picks `seedBase("repo")` on its own when the repo has files, so this
  // is not an exotic path; it is the second machine's *normal* first run, and the only run where
  // adoption has anything to do.
  const repo = pushed(build({ "VariableID:1:15": "duration", "VariableID:1:16": "unitless" }));

  // No `build()` anywhere above this line: nothing has been imported on this device yet.
  const adoption = adoptUserSubtypes({}, extractUserSubtypesFromFiles(trees(repo)));
  assert.deepEqual(adoption.adopted, ["VariableID:1:15", "VariableID:1:16"]);

  // Now the first scan happens, and reads the tags that were already waiting for it.
  const first = build(adoption.subtypes);
  assert.deepEqual(unconfirmed(first), [], "the first scan asks about nothing");
  assert.deepEqual(Array.from(pushed(first).entries()), Array.from(repo.entries()));
});

test("adoptRepoSubtypes is not gated on an import, and setRepoBaseline no longer doubles as a parser", () => {
  // The runtime regression lives in `src/code.ts`, which has no harness in CI — same situation as
  // `applyInvariant.test.ts`, and pinned the same way. The first shape of this fix returned the
  // parsed trees *out of* `setRepoBaseline`, which bails on `importResult === null`; so on the
  // no-scan-yet path above it returned `[]` and adoption silently did nothing. Parsing is its own
  // step now, and the two consumers carry their own preconditions.
  const controller = code(readFileSync(join(ROOT, "src/code.ts"), "utf8"));

  const adopt = body(controller, "async function adoptRepoSubtypes");
  assert.equal(/importResult/.test(adopt), false, "adoption must not depend on a prior import");
  assert.ok(/repoConnected/.test(adopt), "but it does still stop at a disconnect");

  const baseline = body(controller, "function setRepoBaseline");
  assert.ok(/function setRepoBaseline\([^)]*\): void/.test(controller), "baseline swapping returns nothing");
  assert.equal(/JSON\.parse/.test(baseline), false, "and no longer parses the repo files itself");

  // The handler parses once and feeds both, rather than threading one through the other.
  assert.ok(
    /parseRepoTrees\(message\.files\)/.test(controller) &&
      /adoptRepoSubtypes\(orderedRepoTrees\(/.test(controller),
    "the baseline message parses once and hands the same trees to both consumers"
  );
});

test("a subtype the repo and this device disagree about is not dropped in silence", () => {
  // `adoptUserSubtypes` fills gaps only, so a disagreement resolves in the local answer's favour.
  // That is the right call (ADR-0004 §4) and the wrong thing to do quietly, which is what the
  // caller did with `kept` before: nothing at all.
  const repo = pushed(build({ "VariableID:1:15": "duration" }));
  const adoption = adoptUserSubtypes(
    { "VariableID:1:15": "unitless" },
    extractUserSubtypesFromFiles(trees(repo))
  );
  assert.deepEqual(adoption.kept, ["VariableID:1:15"]);
  assert.equal(adoption.subtypes["VariableID:1:15"], "unitless", "the local answer is kept");

  const controller = code(readFileSync(join(ROOT, "src/code.ts"), "utf8"));
  assert.ok(
    /reportSubtypeConflicts\(adoption\.kept\)/.test(controller),
    "and the caller hands `kept` somewhere rather than discarding it"
  );
  assert.ok(
    /figma\.notify\(/.test(body(controller, "function reportSubtypeConflicts")),
    "which tells the user, on the lightest surface the plugin already has"
  );
});
