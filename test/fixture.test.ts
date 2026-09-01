// Regression test over a snapshot captured from a real Figma file.
//
// `test/fixtures/variables-import/figma-snapshot.json` is the verbatim output of
// `src/figma/scan.ts` run against the file at
// https://www.figma.com/design/1ttG81lWKg74GUHq4aBnxl — three collections, four modes, cross-
// collection aliases, every auto-detectable number scope, and one collection built to trigger
// all three collision kinds. `tokens/` beside it is the tree the importer produced from it.
//
// This is the determinism guarantee of ADR §7 held against real Figma data rather than
// hand-written doubles: rebuild from the snapshot, and every byte must match.
//
// To regenerate after an intentional schema change:
//   UPDATE_FIXTURE=1 npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildImport } from "../src/tokens/build";
import { stableStringify } from "../src/tokens/serialize";
import { extractUserSubtypesFromFiles } from "../src/tokens/subtype";
import type { FileSnapshot, Subtype, TokenGroup } from "../src/tokens/types";

// npm scripts run from the repo root.
const ROOT = join(process.cwd(), "test/fixtures/variables-import");
const IMPORTED_AT = "2026-09-01T00:00:00.000Z";
const UPDATE = process.env.UPDATE_FIXTURE === "1";

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const snapshot = JSON.parse(read("figma-snapshot.json")) as FileSnapshot;
const userSubtypes = JSON.parse(read("user-subtypes.json")) as Record<string, Subtype>;

function run() {
  return buildImport(snapshot, { userSubtypes, importedAt: IMPORTED_AT });
}

test("the tree generated from a real Figma file matches the committed fixture byte for byte", () => {
  const result = run();

  for (const file of result.files) {
    const serialized = stableStringify(file.content);
    const target = join(ROOT, file.path);

    if (UPDATE) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, serialized);
      continue;
    }

    assert.equal(
      serialized,
      readFileSync(target, "utf8"),
      `${file.path} differs from the committed fixture. If the schema change is intentional, regenerate with UPDATE_FIXTURE=1 npm test`
    );
  }
});

test("the real file exercises every collision kind ADR §5 defines", () => {
  const reported = run().report.entries.map((entry) => entry.reason);
  for (const reason of ["same-set-case", "token-group", "cross-set"]) {
    assert.ok(reported.includes(reason), `expected a "${reason}" entry, got: ${reported.join(", ")}`);
  }
});

test("every collision in the real file records which criterion picked the winner", () => {
  for (const entry of run().report.entries) {
    if (entry.kind !== "collision") continue;
    assert.ok(entry.winnerRule, `${entry.reason} has no winnerRule`);
  }
});

test("the legitimate token wins the cross-set clash regardless of collection name", () => {
  // The bug Amendment 1 §F fixes, held against real data. This collection was originally called
  // "Collision Lab", which sorts before "Core" — under the superseded alphabetical rule the junk
  // collection evicted the real palette token and dangled the Theme alias pointing at it. Now
  // Core's token wins on inbound alias count, and renaming the collection cannot change that.
  const renamed: FileSnapshot = {
    ...snapshot,
    collections: snapshot.collections.map((collection) =>
      collection.name === "Lab" ? { ...collection, name: "Aaa Collision Lab" } : collection
    ),
  };

  const result = buildImport(renamed, { userSubtypes, importedAt: IMPORTED_AT });
  const clash = result.report.entries.find((entry) => entry.reason === "cross-set");
  assert.ok(clash);
  assert.equal(clash.winnerRule, "alias-references");
  assert.equal(clash.participants?.find((p) => p.outcome === "written")?.collectionName, "Core");

  // And the Theme alias that pointed at it still resolves — nothing dangles.
  assert.equal(
    result.report.entries.some((entry) => entry.kind === "dangling-reference"),
    false
  );
});

test("re-import reads its own user tags back out of the fixture it generated", () => {
  // ADR §3's round trip: the tags in `user-subtypes.json` are exactly the ones recoverable from
  // the generated token files, so a re-import preserves them without being told again.
  const result = run();
  const trees = result.files
    .filter((file) => !file.path.startsWith("tokens/$"))
    .map((file) => file.content as TokenGroup);

  assert.deepEqual(extractUserSubtypesFromFiles(trees), userSubtypes);
});

test("Figma's float32 storage does not leak into the fixture's token values", () => {
  const json = run()
    .files.map((file) => stableStringify(file.content))
    .join("");
  assert.equal(/\d\.\d{12,}/.test(json), false, "a float32 artefact reached a $value");
});
