// Settings and sync state — ADR-0006 §3, §9, and §1's masked credential.
//
// Small functions, all of them guarding something a user can get wrong in the panel: a pasted URL,
// a switched branch, a stale sync state, and the four characters of a secret.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RepoSettings, SyncState } from "../src/git/types";
import {
  DEFAULT_TOKENS_DIR,
  PAT_KEY,
  SETTINGS_KEY,
  lastFour,
  parseRepo,
  parseSettings,
  parseSyncState,
  syncKey,
  syncStateApplies,
} from "../src/git/state";

test("every shape GitHub hands out normalises to owner/repo", () => {
  // *"Nobody has `owner/repo` on their clipboard; they have `https://github.com/owner/repo`."*
  // Refusing a paste to enforce a format is the panel making its parsing the user's problem.
  for (const raw of [
    "thebluesman/folio-tokens",
    "https://github.com/thebluesman/folio-tokens",
    "http://github.com/thebluesman/folio-tokens.git",
    "https://www.github.com/thebluesman/folio-tokens/",
    "git@github.com:thebluesman/folio-tokens.git",
    "  thebluesman/folio-tokens  ",
  ]) {
    assert.deepEqual(parseRepo(raw), { owner: "thebluesman", repo: "folio-tokens" }, raw);
  }
});

test("a repo URL with a path past the repo still resolves to the repo", () => {
  assert.deepEqual(parseRepo("https://github.com/owner/repo/tree/main/tokens"), {
    owner: "owner",
    repo: "repo",
  });
});

test("nonsense is refused in the panel rather than surfacing later as a 404", () => {
  // §11 says a missing repo and a token without access are indistinguishable in GitHub's response,
  // so a typo that *can* be caught locally must be.
  assert.equal(parseRepo(""), null);
  assert.equal(parseRepo("folio-tokens"), null);
  assert.equal(parseRepo("owner/repo with spaces"), null);
  assert.equal(parseRepo("own er/repo"), null);
});

test("stored settings survive a missing branch or folder with sane defaults", () => {
  const parsed = parseSettings({ owner: "a", repo: "b" }) as RepoSettings;
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.tokensDir, DEFAULT_TOKENS_DIR);
  assert.equal(parseSettings({ repo: "b" }), null);
  assert.equal(parseSettings(null), null);
  assert.equal(parseSettings("nope"), null);
});

test("the tokens folder is normalised on the way out of storage", () => {
  const parsed = parseSettings({ owner: "a", repo: "b", tokensDir: "/design/" }) as RepoSettings;
  assert.equal(parsed.tokensDir, "design");
});

test("a sync state for another branch is not a base", () => {
  // §9: *"a different branch is a different base."* Filtered on read rather than deleted on write,
  // so switching branch and back does not throw away a base the user still had.
  const state: SyncState = {
    owner: "a",
    repo: "b",
    branch: "main",
    baseCommitSha: "c",
    blobShas: {},
    at: "",
  };
  const settings = parseSettings({ owner: "a", repo: "b", branch: "main" });
  assert.equal(syncStateApplies(state, settings), true);
  assert.equal(syncStateApplies(state, parseSettings({ owner: "a", repo: "b", branch: "next" })), false);
  assert.equal(syncStateApplies(state, parseSettings({ owner: "z", repo: "b", branch: "main" })), false);
  assert.equal(syncStateApplies(null, settings), false);
});

test("a malformed sync state is rejected rather than half-read", () => {
  assert.equal(parseSyncState({ owner: "a" }), null);
  const parsed = parseSyncState({
    owner: "a",
    repo: "b",
    branch: "main",
    baseCommitSha: "c",
    blobShas: { "tokens/a.json": "sha", "tokens/b.json": 7 },
  }) as SyncState;
  // A non-string SHA is dropped, not coerced: a base entry that is not a SHA would silently make
  // one file permanently diverged.
  assert.deepEqual(parsed.blobShas, { "tokens/a.json": "sha" });
});

test("the storage keys are the three ADR-0006 §3 names, and sync state is file-scoped", () => {
  assert.equal(SETTINGS_KEY, "tokenvault:github");
  assert.equal(PAT_KEY, "tokenvault:github-pat");
  assert.equal(syncKey("file-123"), "tokenvault:sync:file-123");
});

test("the masked field never leaks more than four characters of a short secret", () => {
  assert.equal(lastFour("github_pat_11ABCDEFG_abcdefgh"), "efgh");
  // A short token would otherwise have a large fraction of itself rendered — so it renders none.
  assert.equal(lastFour("short"), "");
  assert.equal(lastFour(""), "");
});
