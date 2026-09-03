// The local-vs-remote comparison — ADR-0006 §4, and the repo-path translation it runs over.
//
// Four states fall out of comparing three SHAs per path, and every one of them decides whether a
// user is offered a push, a pull, or a refusal. The table below is ADR-0006 §4's, tested row by row
// rather than trusted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { advanceBase, computeStatus, isExcluded, seedBlobShas } from "../src/git/diff";
import { blobSha } from "../src/git/blob";
import {
  fromRepoPath,
  inTokensDir,
  isTokenFilePath,
  normalizeTokensDir,
  toRepoPath,
} from "../src/git/paths";

const A = "{}\n";
const B = '{"a":1}\n';
const shaA = blobSha(A);
const shaB = blobSha(B);

function status(local: Record<string, string>, remote: Record<string, string>, base: Record<string, string>) {
  return computeStatus({ local: new Map(Object.entries(local)), remote, base });
}

test("ADR-0006 §4's table, row by row", () => {
  // same / same → in sync
  assert.equal(status({ "tokens/a.json": A }, { "tokens/a.json": shaA }, { "tokens/a.json": shaA }).files[0].state, "in-sync");
  // differs / same → to push
  assert.equal(status({ "tokens/a.json": B }, { "tokens/a.json": shaA }, { "tokens/a.json": shaA }).files[0].state, "to-push");
  // same / differs → to pull
  assert.equal(status({ "tokens/a.json": A }, { "tokens/a.json": shaB }, { "tokens/a.json": shaA }).files[0].state, "to-pull");
  // differs / differs → diverged
  assert.equal(
    status({ "tokens/a.json": B }, { "tokens/a.json": shaB + "x" }, { "tokens/a.json": shaA }).files[0].state,
    "diverged"
  );
});

test("two sides that agree are never reported as a conflict about nothing", () => {
  // Both moved, but to the same content. Reporting this as diverged would be the design's silliest
  // possible failure, and it is exactly what a naive base comparison produces.
  const result = status({ "tokens/a.json": B }, { "tokens/a.json": shaB }, { "tokens/a.json": shaA });
  assert.equal(result.files[0].state, "in-sync");
  assert.equal(result.clean, true);
});

test("a file only one side has is push or pull, not diverged", () => {
  assert.equal(status({ "tokens/new.json": A }, {}, {}).files[0].state, "to-push");
  assert.equal(status({}, { "tokens/gone.json": shaA }, {}).files[0].state, "to-pull");
});

test("a file deleted locally but present in the base and the repo is a push", () => {
  const result = status({}, { "tokens/a.json": shaA }, { "tokens/a.json": shaA });
  assert.equal(result.files[0].state, "to-push");
  assert.equal(result.files[0].localSha, undefined);
});

test("with no base, both sides differing reads as diverged — which is what first connect is for", () => {
  // §6: technically right and useless as a bootstrap, which is why connect asks once and seeds the
  // base rather than dropping twelve files into a conflict queue.
  const result = status({ "tokens/a.json": A }, { "tokens/a.json": shaB }, {});
  assert.equal(result.files[0].state, "diverged");
});

test("the file list is sorted, so two identical checks never look like they found something", () => {
  const result = status(
    { "tokens/z.json": A, "tokens/a.json": A },
    { "tokens/m.json": shaB },
    {}
  );
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["tokens/a.json", "tokens/m.json", "tokens/z.json"]
  );
});

test("$import-report.json can never reach a diff list, whatever the folder is called", () => {
  // Excluded at the boundary rather than filtered in the UI (ADR-0006 §5, UX §14). The basename
  // match is what makes that true for a repo whose tokens folder is `design/` or the root itself.
  assert.equal(isExcluded("tokens/$import-report.json"), true);
  assert.equal(isExcluded("design/$import-report.json"), true);
  assert.equal(isExcluded("$import-report.json"), true);
  assert.equal(isExcluded("tokens/$manifest.json"), false);

  const result = status(
    { "tokens/$import-report.json": B, "tokens/a.json": A },
    { "tokens/$import-report.json": shaA, "tokens/a.json": shaA },
    { "tokens/a.json": shaA }
  );
  assert.deepEqual(result.files.map((file) => file.path), ["tokens/a.json"]);
  assert.equal(result.clean, true);
});

test("adopting the repo makes its differences arrive as a pull, not as an overwrite", () => {
  // The inversion that is easy to get backwards, and getting it backwards would offer to overwrite
  // the repo the user just chose to defer to (ADR-0006 §6, UX §5.3).
  const base = seedBlobShas("repo", { "tokens/a.json": shaA }, { "tokens/a.json": shaB });
  assert.equal(status({ "tokens/a.json": A }, { "tokens/a.json": shaB }, base).files[0].state, "to-pull");
});

test("publishing this Figma file makes our version the thing to push", () => {
  const base = seedBlobShas("figma", { "tokens/a.json": shaA }, { "tokens/a.json": shaB });
  assert.equal(status({ "tokens/a.json": A }, { "tokens/a.json": shaB }, base).files[0].state, "to-push");
});

test("an empty repo seeds an empty base, so everything reads as to push", () => {
  // *"The modal doesn't open; connect succeeds with an empty baseline and the chip reads `↑ 12` —
  // everything to push, which is exactly right"* (UX §5.3).
  const base = seedBlobShas("figma", { "tokens/a.json": shaA }, {});
  assert.deepEqual(base, {});
  assert.equal(status({ "tokens/a.json": A }, {}, base).files[0].state, "to-push");
});

test("a never-scanned file adopting the repo pulls everything", () => {
  const base = seedBlobShas("repo", {}, { "tokens/a.json": shaB });
  assert.deepEqual(base, {});
  assert.equal(status({}, { "tokens/a.json": shaB }, base).files[0].state, "to-pull");
});

test("advanceBase takes what was written, not what we hoped to write", () => {
  // A push that committed three of five checked files leaves the other two still to push, and a
  // base claiming otherwise would lose them.
  const next = advanceBase(
    { "a.json": "1", "b.json": "2", "c.json": "3" },
    { "a.json": "9", "c.json": null }
  );
  assert.deepEqual(next, { "a.json": "9", "b.json": "2" });
});

test("advanceBase does not mutate the base it was given", () => {
  const base = { "a.json": "1" };
  advanceBase(base, { "a.json": "2" });
  assert.deepEqual(base, { "a.json": "1" });
});

// ---------------------------------------------------------------------------
// Repo paths — the blast-radius promise, enforced rather than trusted
// ---------------------------------------------------------------------------

test("the tokens folder is normalised to one shape", () => {
  for (const raw of ["tokens", "tokens/", "/tokens", " /tokens/ "]) {
    assert.equal(normalizeTokensDir(raw), "tokens");
  }
  assert.equal(normalizeTokensDir(""), "");
});

test("build paths map into the configured folder and back", () => {
  assert.equal(toRepoPath("tokens/theme/light.json", "design"), "design/theme/light.json");
  assert.equal(fromRepoPath("design/theme/light.json", "design"), "tokens/theme/light.json");
  assert.equal(toRepoPath("tokens/theme/light.json", "tokens"), "tokens/theme/light.json");
  // A repo whose token folder is the root: the round trip still has to survive.
  assert.equal(toRepoPath("tokens/a.json", ""), "a.json");
  assert.equal(fromRepoPath("a.json", ""), "tokens/a.json");
});

test("nothing outside the configured folder is ever in scope", () => {
  // UX §5.2's sentence — *"nothing outside this folder is ever touched"* — is this predicate plus
  // `base_tree`, not care at each call site.
  assert.equal(inTokensDir("src/index.ts", "tokens"), false);
  assert.equal(inTokensDir("tokensfoo/a.json", "tokens"), false);
  assert.equal(inTokensDir("tokens/a.json", "tokens"), true);
  assert.equal(fromRepoPath("README.md", "tokens"), null);
});

test("only .json files inside the folder are token files", () => {
  assert.equal(isTokenFilePath("tokens/a.json", "tokens"), true);
  assert.equal(isTokenFilePath("tokens/README.md", "tokens"), false);
  assert.equal(isTokenFilePath("tokens/nested/deep.json", "tokens"), true);
});
