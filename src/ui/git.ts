// The iframe half of git sync — ADR-0006 §1, and the only place an operation is sequenced.
//
// `api.ts` performs requests and `diff.ts` / `commit.ts` / `pull.ts` decide what they should
// contain; this module is the thing that holds the connection, decides *when* to ask, and owns the
// view model the Repo tab and the header chip render. It runs in the iframe because that is where
// `fetch` lives, and it talks to the sandbox for `clientStorage` because that is where storage
// lives (§1) — a split neither half can avoid.
//
// **The credential rule, implemented rather than described.** `withToken` asks the sandbox for the
// PAT, hands it to `createClient`, and lets both go out of scope when the operation ends. There is
// no module-level token variable in this file, and there is no code path that keeps a client alive
// past its operation. That is ADR-0006 §1's *"held in a closure for one operation and dropped"*,
// and `test/gitInvariant.test.ts` asserts the parts of it that source inspection can reach.
//
// **Cadence** (§5, UX §8.5): the status check runs on panel open, on Repo tab open, and after every
// push and pull. Push and pull run when the user asks and never otherwise. There is no timer here
// and there must never be one.

import type { GitConfig, SerializedFile } from "../messages";
import type { OverlayEntry } from "../tokens/overlay";
import type { Manifest, TokenGroup } from "../tokens/types";
import type { PullResult } from "../git/pull";
import type {
  FileStatus,
  GitFailure,
  RateLimit,
  RemoteTree,
  RepoSettings,
  SyncState,
  SyncStatus,
} from "../git/types";
import { GitError } from "../git/types";
import { createClient, type GitClient } from "../git/api";
import { blobSha } from "../git/blob";
import { advanceBase, computeStatus, seedBlobShas } from "../git/diff";
import { buildCommit, generateCommitMessage, type MessageFile } from "../git/commit";
import { localTree, localTrees } from "../git/local";
import { buildPull } from "../git/pull";
import { DEFAULT_TOKENS_DIR } from "../git/state";
import { fromRepoPath, isTokenFilePath, toRepoPath } from "../git/paths";
import { flattenTree } from "../git/filediff";
import { getModel, importedFiles, importedManifest, send } from "./state";

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

export interface GitView {
  settings: RepoSettings | null;
  sync: SyncState | null;
  hasToken: boolean;
  /** Configured, credentialled and based: everything an operation needs before it can be offered. */
  connected: boolean;
  status: SyncStatus | null;
  checking: boolean;
  /** What the panel is doing right now, in the words it should say. `null` when idle. */
  busy: string | null;
  checkedAt: number | null;
  failure: GitFailure | null;
  rateLimit: RateLimit | null;
  /** The last pull's report — §8.4's unmatched list, shown once and not turned into a badge. */
  lastPull: PullResult | null;
  /**
   * What the sandbox actually did with that pull's entries, from `git-pull-result`.
   *
   * `lastPull.entries` is a prediction made before `applyPull` ran; an entry that landed on a local
   * edit becomes a conflict rather than a pending change, and only the sandbox knows how many did.
   * `null` until the reply lands, so the report never reports numbers it hasn't been told.
   */
  lastPullMerge: { applied: number; conflicts: number } | null;
  /** Repo files that aren't valid token JSON. Named, and excluded from every operation (UX §11). */
  unreadable: string[];
  /** True when GitHub truncated the recursive tree listing — a repo too big to answer in one call. */
  truncated: boolean;
}

let view: GitView = {
  settings: null,
  sync: null,
  hasToken: false,
  connected: false,
  status: null,
  checking: false,
  busy: null,
  checkedAt: null,
  failure: null,
  rateLimit: null,
  lastPull: null,
  lastPullMerge: null,
  unreadable: [],
  truncated: false,
};

/** The fetched tree, in memory for this session only. §3: the pulled tree is never persisted. */
let remoteTree: RemoteTree | null = null;

/**
 * Bumped whenever the connection this file has changes identity — disconnect, or a move to another
 * repo or branch. An in-flight operation started under an older generation is about a connection
 * that no longer exists, and must not write its result back.
 */
let connectionGeneration = 0;

let listeners: Array<() => void> = [];

export function onGitChange(listener: () => void): void {
  listeners.push(listener);
}

function update(next: Partial<GitView>): void {
  view = { ...view, ...next };
  view.connected =
    view.settings !== null && view.hasToken && view.sync !== null && view.status !== null;
  for (const listener of listeners) listener();
}

export function getGit(): GitView {
  return view;
}

/**
 * Whether drift, conflicts and bulk actions should speak in repo terms — UX §10.2, §14.
 *
 * Deliberately *not* `view.connected`: the labels follow whether there is a repo to name, and a
 * configured file whose status check hasn't landed yet still has one. A file with no settings at
 * all is the disconnected case, and it keeps Phase 5's wording exactly (ADR-0006 §7).
 */
export function isConnected(): boolean {
  return view.settings !== null && view.sync !== null;
}

export function branchName(): string {
  return view.settings?.branch ?? "main";
}

export function tokensDir(): string {
  return view.settings?.tokensDir ?? DEFAULT_TOKENS_DIR;
}

// ---------------------------------------------------------------------------
// The message boundary
// ---------------------------------------------------------------------------

let tokenWaiters: Array<(token: string | null) => void> = [];

/**
 * Woken by `git-pull-result`, so a pull can wait for its own merge.
 *
 * `git-pull` is a one-way message; the sandbox merges, persists, and posts `overlay-state` and then
 * `git-pull-result` back. Anything that reads the overlay before that lands reads the *pre-pull*
 * overlay — which is how the baseline refresh was re-fetching every path the pull had just brought
 * into agreement, roughly doubling the blob fetches on every pull.
 */
let pullWaiters: Array<() => void> = [];

/** One status check per panel open, fired from the first `git-config` that can support one. */
let openChecked = false;

/** Routed here from `main.ts`'s pump. Returns true when the message was a git one. */
export function handleGitMessage(message: {
  type: string;
  config?: GitConfig;
  token?: string | null;
  applied?: number;
  conflicts?: number;
}): boolean {
  if (message.type === "git-config" && message.config !== undefined) {
    const config = message.config;
    update({ settings: config.settings, sync: config.sync, hasToken: config.hasToken });
    // *"A status check runs on panel open"* (UX §14) — and this is the earliest moment it can. The
    // sandbox sends `plugin-ready` before it has read `clientStorage`, so a check fired there always
    // found `settings === null` and returned without doing anything. Once, per panel open: later
    // `git-config` messages are settings saves, which run their own check.
    if (!openChecked && config.settings !== null && config.hasToken) {
      openChecked = true;
      void checkStatus();
    }
    return true;
  }
  if (message.type === "git-token") {
    const waiters = tokenWaiters;
    tokenWaiters = [];
    for (const resolve of waiters) resolve(message.token ?? null);
    return true;
  }
  if (message.type === "git-pull-result") {
    // The pull's own report was a prediction; this is what the merge actually did with it (§8.2).
    update({
      lastPullMerge: { applied: message.applied ?? 0, conflicts: message.conflicts ?? 0 },
    });
    const waiters = pullWaiters;
    pullWaiters = [];
    for (const resolve of waiters) resolve();
    return true;
  }
  return false;
}

/**
 * The PAT, for the length of one operation — ADR-0006 §1.
 *
 * Requested per operation rather than cached, so there is no variable in this module holding a
 * credential between two user actions and nothing for a stray `console.log` to find. The cost is
 * one `postMessage` round trip per operation, which is invisible next to a network call.
 */
function requestToken(): Promise<string | null> {
  return new Promise((resolve) => {
    tokenWaiters.push(resolve);
    send({ type: "git-request-token" });
  });
}

/**
 * Runs one operation against a client bound to the stored credential, then drops both.
 *
 * Every failure lands as a `GitFailure` on the view — §10's *"every failure is named, never a bare
 * status code"* — and never as a thrown error the caller has to remember to catch. The one thing
 * that must never happen here is the token reaching the returned value or the failure payload,
 * which is why `api.ts` writes every message itself and this function never touches a response.
 */
async function withToken<T>(
  busy: string,
  run: (client: GitClient) => Promise<T>
): Promise<T | null> {
  const settings = view.settings;
  if (settings === null) {
    update({
      failure: {
        kind: "not-configured",
        message: "This file isn't connected to a repo yet.",
      },
    });
    return null;
  }

  // Claimed **before** the first `await`, not after it. Every gated button is disabled off
  // `view.busy`, so setting it only once the token reply came back left a window in which two
  // operations could be started and race over this module's `remoteTree` and `view.sync`.
  if (view.busy !== null) return null;
  update({ busy, failure: null });

  const token = await requestToken();
  if (token === null) {
    update({
      busy: null,
      failure: {
        kind: "not-configured",
        message: "Add a GitHub access token in settings before syncing.",
      },
    });
    return null;
  }

  try {
    const client = createClient({ owner: settings.owner, repo: settings.repo, token });
    const result = await run(client);
    update({ busy: null, rateLimit: client.rateLimit() });
    return result;
  } catch (error) {
    const failure: GitFailure =
      error instanceof GitError
        ? error.failure
        : { kind: "unknown", message: "Something went wrong talking to GitHub. Nothing was changed." };
    update({ busy: null, failure });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status — the one automatic thing (§4, UX §6.2)
// ---------------------------------------------------------------------------

/** Repo-relative path → the exact bytes a push would write, for the tree the panel is showing. */
export function localFiles(): Map<string, string> {
  const model = getModel();
  if (!model.ready) return new Map();
  return localTree(importedFiles(), model.overlay, tokensDir());
}

/** The remote tree, reduced to the token files inside the configured folder. */
function remoteTokenFiles(tree: RemoteTree): Record<string, string> {
  const out: Record<string, string> = {};
  const dir = tokensDir();
  for (const path of Object.keys(tree.blobs)) {
    // Everything outside the folder is somebody else's — source, CI config, the Phase 8 export.
    // Sync must not see it, let alone report it as a file to pull (UX §5.2's blast radius).
    if (isTokenFilePath(path, dir)) out[path] = tree.blobs[path];
  }
  return out;
}

/**
 * Re-answers the status question from the tree already in hand — **no request at all**.
 *
 * An edit changes the local side of §4's comparison, so the chip and the Repo tab would otherwise
 * keep reporting a push count for a tree that no longer exists. Recomputing locally is not a
 * "check": nothing is fetched, no rate limit is spent, and the remote half of the comparison is the
 * same tree the last real check returned. The network check stays on its stated cadence — panel
 * open, Repo tab open, after every push and pull, and never on a timer (§5, UX §14).
 */
export function recomputeStatus(): void {
  if (remoteTree === null || view.settings === null || view.sync === null) return;
  update({
    status: computeStatus({
      local: localFiles(),
      remote: remoteTokenFiles(remoteTree),
      base: view.sync.blobShas,
      tokensDir: tokensDir(),
    }),
  });
}

/**
 * *"Are we in sync?"* — one request and no measurable transfer (§4).
 *
 * Runs on panel open, on Repo tab open, and after every push and pull. Never on a timer: a status
 * check is cheap but not free, and the answer is only interesting when the user is about to act
 * (ADR-0006 §10, ADR-0005 §9).
 */
export async function checkStatus(): Promise<void> {
  if (view.settings === null || !view.hasToken) return;
  // An operation already in flight ends with its own status check, so a second one started while it
  // runs would be refused by `withToken` and then clear the status it never actually re-checked.
  if (view.busy !== null) return;
  update({ checking: true });

  const tree = await withToken("Checking…", (client) => client.getTree(branchName()));
  if (tree === null) {
    update({ checking: false, status: null });
    return;
  }

  remoteTree = tree;
  const status = computeStatus({
    local: localFiles(),
    remote: remoteTokenFiles(tree),
    base: view.sync?.blobShas ?? {},
    tokensDir: tokensDir(),
  });

  update({
    checking: false,
    status,
    checkedAt: Date.now(),
    truncated: tree.truncated,
    failure: null,
    unreadable: [],
  });
}

// ---------------------------------------------------------------------------
// Connecting — §5.3's one-time bootstrap
// ---------------------------------------------------------------------------

export interface ConnectProbe {
  tree: RemoteTree;
  /** Token files already in the configured folder. Zero means the question is skipped entirely. */
  remoteFiles: number;
  localFiles: number;
}

/** Reads the repo without committing to anything, so the connect question can carry numbers. */
export async function probeRepo(): Promise<ConnectProbe | null> {
  const tree = await withToken("Checking…", (client) => client.getTree(branchName()));
  if (tree === null) return null;
  remoteTree = tree;
  return {
    tree,
    remoteFiles: Object.keys(remoteTokenFiles(tree)).length,
    localFiles: localFiles().size,
  };
}

/**
 * Seeds the merge base — the whole of first connect, in one decision.
 *
 * `"repo"` adopts, so everything the repo says differently arrives as a **pull**; `"figma"`
 * publishes, so everything we hold differently reads as a **push**. Nothing is written to the repo
 * either way — the choice is only about which side the comparison starts from (ADR-0006 §6,
 * UX §5.3). The mapping from that answer to a base is inverted and lives in `seedBlobShas`, which
 * explains why.
 */
export async function seedBase(side: "repo" | "figma"): Promise<void> {
  const tree = remoteTree;
  const settings = view.settings;
  if (tree === null || settings === null) return;

  const blobShas = seedBlobShas(side, shasOf(localFiles()), remoteTokenFiles(tree));

  const state: SyncState = {
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch,
    baseCommitSha: tree.commitSha,
    blobShas,
    at: new Date().toISOString(),
  };
  send({ type: "git-save-sync", state });
  update({ sync: state });

  if (side === "repo") await refreshRepoBaseline();
  await checkStatus();
}

function shasOf(files: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  // Computed with the same function the status check uses, so the base a connect seeds and the
  // SHAs it is later compared against can never be produced by two different code paths.
  for (const [path, content] of files) out[path] = blobSha(content);
  return out;
}

// ---------------------------------------------------------------------------
// Repo content — fetched for the files that differ, and only then (§4)
// ---------------------------------------------------------------------------

/**
 * The repo's version of the given repo-relative paths, parsed.
 *
 * A file whose blob SHA matches ours is *byte-identical* by definition, so its content is already
 * in hand and is taken locally rather than downloaded — which is what keeps "give me the whole repo
 * tree" to N requests where N is the number of files that actually differ.
 */
async function fetchRepoTrees(paths: string[]): Promise<Map<string, TokenGroup> | null> {
  const tree = remoteTree;
  if (tree === null) return null;
  const remote = remoteTokenFiles(tree);
  const dir = tokensDir();
  const unreadable: string[] = [];

  const result = await withToken("Fetching…", async (client) => {
    const out = new Map<string, TokenGroup>();
    for (const repoPath of paths) {
      const sha = remote[repoPath];
      if (sha === undefined) continue;
      const buildPath = fromRepoPath(repoPath, dir);
      if (buildPath === null) continue;
      const text = await client.getBlob(sha);
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          unreadable.push(repoPath);
          continue;
        }
        out.set(buildPath, parsed as TokenGroup);
      } catch {
        // *"Can't read tokens/theme/light.json — it isn't valid token JSON. Other files pulled
        // normally."* (UX §11.) One bad file costs itself and nothing else.
        unreadable.push(repoPath);
      }
    }
    return out;
  });

  // Accumulated rather than replaced: a review that fetches five files one at a time must not let
  // the fifth call's clean result erase the second's *"can't read tokens/theme/light.json"*. The
  // list is cleared by the next status check, which is when the question is asked afresh.
  const merged = view.unreadable.slice();
  for (const path of unreadable) {
    if (merged.indexOf(path) === -1) merged.push(path);
  }
  update({ unreadable: merged });
  return result;
}

/**
 * Rebuilds the drift baseline from the repo — ADR-0006 §7's argument swap.
 *
 * Files that match ours are taken locally (same SHA means same bytes); the rest are fetched. The
 * result is handed to the sandbox as content and held **in memory only** — §3 refuses to persist a
 * second ~700KB tree into a 5MB store to cache something one request re-derives.
 */
export async function refreshRepoBaseline(): Promise<void> {
  const tree = remoteTree;
  if (tree === null || view.settings === null) return;
  // The fetch below is several round trips long, and a disconnect (or a move to another
  // repo/branch) can land in the middle of it. The generation this refresh started in is what
  // decides whether its result is still about the connection the user currently has.
  const generation = connectionGeneration;

  const dir = tokensDir();
  const remote = remoteTokenFiles(tree);
  const local = localFiles();

  const differing = Object.keys(remote).filter(
    (path) => local.get(path) !== undefined && blobSha(local.get(path) as string) !== remote[path]
  );
  const fetched = await fetchRepoTrees(
    Object.keys(remote).filter((path) => local.get(path) === undefined || differing.indexOf(path) !== -1)
  );
  if (fetched === null) return;

  const files: SerializedFile[] = [];
  for (const path of Object.keys(remote)) {
    const buildPath = fromRepoPath(path, dir);
    if (buildPath === null) continue;
    const parsed = fetched.get(buildPath);
    if (parsed !== undefined) {
      files.push({ path: buildPath, json: JSON.stringify(parsed) });
      continue;
    }
    const same = local.get(path);
    if (same !== undefined) files.push({ path: buildPath, json: same });
  }

  if (generation !== connectionGeneration || view.settings === null) return;
  send({ type: "git-repo-baseline", files });
}

// ---------------------------------------------------------------------------
// Push — §5, §8
// ---------------------------------------------------------------------------

export interface PushOutcome {
  commitSha: string;
  url: string;
  files: number;
  rows: number;
}

/**
 * One commit, one push, the selected files whole (§5, §8).
 *
 * A diverged file never reaches here — `buildCommit` throws on one rather than trusting the screen
 * to have unchecked it, because "the UI wouldn't do that" is not a guarantee and a diverged file
 * pushed by accident is a silent overwrite of somebody else's commit.
 */
export async function push(
  selected: FileStatus[],
  message: string,
  rows: number
): Promise<PushOutcome | null> {
  const tree = remoteTree;
  const settings = view.settings;
  const sync = view.sync;
  if (tree === null || settings === null || sync === null) return null;

  const request = buildCommit({
    selected,
    local: localFiles(),
    message,
    // The head we just observed, not the recorded base: `force: false` at the ref is what catches a
    // branch that moved under us, and it can only do that if the parent is what we believe head is.
    parent: tree.commitSha,
    baseTree: tree.treeSha,
  });

  const result = await withToken(`Pushing to ${settings.branch}…`, (client) =>
    client.push(request, settings.branch)
  );
  if (result === null) return null;

  const changes: Record<string, string | null> = {};
  for (const blob of request.blobs) changes[blob.path] = result.blobShas[blob.path];
  for (const path of request.deletions) changes[path] = null;

  const next: SyncState = {
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch,
    baseCommitSha: result.commitSha,
    blobShas: advanceBase(sync.blobShas, changes),
    at: new Date().toISOString(),
  };
  send({ type: "git-save-sync", state: next });
  update({ sync: next });

  // *"A status check runs after every push and pull"* (UX §14). If it fails, the push still
  // succeeded — §11's *"Pushed. Couldn't re-check status."* — which is why this is not awaited into
  // the return value.
  await checkStatus();
  return { commitSha: result.commitSha, url: result.url, files: selected.length, rows };
}

// ---------------------------------------------------------------------------
// Pull — §5, UX §8
// ---------------------------------------------------------------------------

export interface PullOutcome {
  result: PullResult;
  files: number;
}

/**
 * Fetches the repo's version of the given files and lands it as **pending changes**.
 *
 * Pull never writes to Figma. It produces overlay entries with `origin: "pulled"`, and getting them
 * onto the canvas is Phase 5's apply flow — the same preview modal, the same executor, the same
 * per-entry report (ADR-0006 §5). There is no second write path, and this function is where that
 * would have to appear if there were.
 */
export async function pull(paths: string[]): Promise<PullOutcome | null> {
  const settings = view.settings;
  const sync = view.sync;
  const manifest = importedManifest();
  if (settings === null || sync === null || manifest === null || remoteTree === null) return null;

  const trees = await fetchRepoTrees(paths);
  if (trees === null) return null;

  const result = buildPull({
    remote: trees as Map<string, unknown>,
    imported: getModel().imported,
    manifest,
    paths: new Set(trees.keys()),
  });

  const merged =
    result.entries.length > 0
      ? new Promise<void>((resolve) => {
          pullWaiters.push(resolve);
          send({ type: "git-pull", entries: result.entries });
        })
      : Promise.resolve();

  // The base advances for every file actually read, whether or not it produced an entry: the two
  // sides now agree on what that file said, which is exactly what a merge base records.
  const remote = remoteTokenFiles(remoteTree);
  const changes: Record<string, string | null> = {};
  for (const path of paths) {
    if (remote[path] !== undefined && view.unreadable.indexOf(path) === -1) {
      changes[path] = remote[path];
    }
  }

  const next: SyncState = {
    ...sync,
    baseCommitSha: remoteTree.commitSha,
    blobShas: advanceBase(sync.blobShas, changes),
    at: new Date().toISOString(),
  };
  send({ type: "git-save-sync", state: next });
  // The merge outcome is unknown until `git-pull-result` comes back; nulled so the report never
  // shows the previous pull's numbers next to this pull's list.
  update({ sync: next, lastPull: result, lastPullMerge: null });

  // Sequenced after the merge, not after the request: the baseline is computed from the overlay,
  // and reading it before the sandbox has merged reads a tree that still disagrees with every path
  // this pull just reconciled — every one of which would then be fetched a second time.
  await merged;
  await refreshRepoBaseline();
  await checkStatus();
  return { result, files: Object.keys(changes).length };
}

// ---------------------------------------------------------------------------
// Divergence — refused per file, resolved whole file (§6, UX §9)
// ---------------------------------------------------------------------------

/**
 * *Keep mine* — clears one diverged file to push (UX §9.2).
 *
 * The base for that path becomes the repo's current blob, so the file reads as an ordinary
 * *to push* and the next push commits over the repo's version with the current head as its parent.
 * Nothing is lost from the repo's history, which is why this button is not styled destructive.
 */
export async function keepMineForFile(path: string): Promise<void> {
  const sync = view.sync;
  if (sync === null || remoteTree === null) return;
  const remote = remoteTokenFiles(remoteTree);
  const sha = remote[path];
  if (sha === undefined) return;

  const next: SyncState = {
    ...sync,
    baseCommitSha: remoteTree.commitSha,
    blobShas: advanceBase(sync.blobShas, { [path]: sha }),
    at: new Date().toISOString(),
  };
  send({ type: "git-save-sync", state: next });
  update({ sync: next });
  await checkStatus();
}

/** Overlay entries belonging to the sets a repo file holds — what *Take the repo's* discards. */
export function entriesForFile(path: string): OverlayEntry[] {
  const buildPath = fromRepoPath(path, tokensDir());
  const manifest = importedManifest();
  if (buildPath === null || manifest === null) return [];

  const sets = new Set<string>();
  for (const collection of manifest.collections) {
    for (const mode of collection.modes) {
      if (`tokens/${mode.file}` === buildPath) sets.add(mode.set);
    }
  }
  for (const style of manifest.styleSets ?? []) {
    if (`tokens/${style.file}` === buildPath) sets.add(style.set);
  }

  return getModel().overlay.entries.filter((entry) => entry.set !== undefined && sets.has(entry.set));
}

// ---------------------------------------------------------------------------
// The commit message and the review screen's contents
// ---------------------------------------------------------------------------

/** The repo path of a set's file, so a file row can name the set the user knows it by. */
export function setsForFile(path: string): string[] {
  const buildPath = fromRepoPath(path, tokensDir());
  const manifest = importedManifest();
  if (buildPath === null || manifest === null) return [];

  const names: string[] = [];
  for (const collection of manifest.collections) {
    for (const mode of collection.modes) {
      if (`tokens/${mode.file}` === buildPath) names.push(`${collection.name} / ${mode.name}`);
    }
  }
  for (const style of manifest.styleSets ?? []) {
    if (`tokens/${style.file}` === buildPath) names.push(`Styles / ${style.name}`);
  }
  return names;
}

export function isManifestPath(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1) === "$manifest.json";
}

/** The generated commit message for a selection — regenerated live until the user types (UX §7.3). */
export function messageFor(files: Array<{ path: string; changed: number; added: number; removed: number }>): {
  summary: string;
  body: string;
} {
  const described: MessageFile[] = files.map((file) => ({
    path: file.path,
    set: setsForFile(file.path)[0],
    changed: file.changed,
    added: file.added,
    removed: file.removed,
    manifest: isManifestPath(file.path),
  }));
  return generateCommitMessage(described);
}

/** The parsed local trees, keyed by repo path — the "after" side of every diff this phase shows. */
export function localParsedTrees(): Map<string, TokenGroup> {
  const model = getModel();
  if (!model.ready) return new Map();
  const dir = tokensDir();
  const out = new Map<string, TokenGroup>();
  for (const [buildPath, tree] of localTrees(importedFiles(), model.overlay)) {
    out.set(toRepoPath(buildPath, dir), tree);
  }
  return out;
}

/** The repo's parsed version of one file, for the commit diff and the compare view. */
export async function repoTreeFor(path: string): Promise<TokenGroup | null> {
  const trees = await fetchRepoTrees([path]);
  if (trees === null) return null;
  const buildPath = fromRepoPath(path, tokensDir());
  return buildPath === null ? null : (trees.get(buildPath) ?? null);
}

/** Token counts per set, for the manifest row's human sentence (UX §7.2). */
export function tokenCounts(trees: Map<string, TokenGroup>, manifest: Manifest | null): Map<string, number> {
  const counts = new Map<string, number>();
  if (manifest === null) return counts;
  const dir = tokensDir();
  const fileOf = (file: string): string => toRepoPath(`tokens/${file}`, dir);

  for (const collection of manifest.collections) {
    for (const mode of collection.modes) {
      const tree = trees.get(fileOf(mode.file));
      if (tree !== undefined) counts.set(mode.set, flattenTree(tree).size);
    }
  }
  for (const style of manifest.styleSets ?? []) {
    const tree = trees.get(fileOf(style.file));
    if (tree !== undefined) counts.set(style.set, flattenTree(tree).size);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function saveSettings(settings: RepoSettings, token?: string | null): void {
  const previous = view.settings;
  send({ type: "git-save-settings", settings, token });
  // Changing branch, repo, owner or tokens folder invalidates the base — *"a different branch is a
  // different base"* (§9), and a different folder is a different set of paths, so every blob SHA in
  // the base is keyed to files the panel is no longer looking at. The sandbox filters a stale state
  // on read; the view drops it now so the panel never renders a status computed against a base that
  // no longer applies. `tokensDir` belongs here for a second reason: leaving `sync` non-null keeps
  // `maybeFirstConnect` from re-baselining, so the panel would report drift against the old folder
  // until the user disconnected and reconnected.
  const moved =
    previous !== null &&
    (previous.owner !== settings.owner ||
      previous.repo !== settings.repo ||
      previous.branch !== settings.branch ||
      previous.tokensDir !== settings.tokensDir);
  if (moved) {
    connectionGeneration += 1;
    remoteTree = null;
    update({ settings, sync: null, status: null, checkedAt: null, lastPull: null, lastPullMerge: null });
  } else {
    update({ settings });
  }
}

export function disconnect(): void {
  send({ type: "git-save-settings", settings: null, token: null });
  connectionGeneration += 1;
  remoteTree = null;
  update({
    settings: null,
    sync: null,
    hasToken: false,
    status: null,
    checkedAt: null,
    failure: null,
    lastPull: null,
    lastPullMerge: null,
    unreadable: [],
  });
}

/** `[ Test connection ]` — the branch list doubles as the cheapest possible proof of access. */
export async function testConnection(): Promise<string[] | null> {
  return withToken("Testing…", (client) => client.getBranches());
}

export function clearLastPull(): void {
  update({ lastPull: null, lastPullMerge: null });
}
