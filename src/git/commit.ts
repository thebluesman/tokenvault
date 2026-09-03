// SyncPlan → the Git Data API call sequence, and the commit message — ADR-0006 §8, UX §7.3.
//
// Pure. This module decides *what* the four-call sequence will contain; `api.ts` performs it.
// Splitting them is what makes "does a push of these three files send the right tree?" a unit test
// rather than a thing you find out by pushing.
//
// Why the Git Data API and not `PUT /contents/{path}` (§8): the Contents API commits one file per
// call, so a twelve-set change lands as twelve commits nobody can review, and it caps a file at
// 1MB. Four calls plus one per changed file buys one atomic commit with no size ceiling — and,
// because the sequence only becomes visible at the final ref update, a failure before that leaves
// the repo exactly as it was.

import type { FileStatus } from "./types";

/** Git's mode for a normal file. Trees are `040000`; nothing here writes one. */
const FILE_MODE = "100644";

export interface TreeEntry {
  path: string;
  mode: typeof FILE_MODE;
  type: "blob";
  /** `null` deletes the path from the tree. Mutually exclusive with `content`. */
  sha: string | null;
}

export interface CommitRequest {
  /** The files whose content has to be uploaded first, in path order. */
  blobs: Array<{ path: string; content: string }>;
  /** Paths removed from the tree — no blob, `sha: null`. */
  deletions: string[];
  message: string;
  /** The commit this one's parent is. `force: false` at the ref makes a stale parent fail (§8). */
  parent: string;
  /** The head commit's tree, so files outside `tokensDir` are carried through untouched (§8). */
  baseTree: string;
}

export interface BuildCommitInput {
  /** The files the user checked on the Review & push screen. */
  selected: FileStatus[];
  /** Repo-relative path → the exact bytes to write. */
  local: Map<string, string>;
  message: string;
  parent: string;
  baseTree: string;
}

/**
 * The commit, as data.
 *
 * A diverged file must never reach here: §6 refuses it, and the Review & push screen renders it
 * unchecked and blocked. This asserts the same thing one layer down, because "the UI wouldn't do
 * that" is not a guarantee, and a diverged file pushed by accident is a silent overwrite of
 * somebody else's commit.
 */
export function buildCommit(input: BuildCommitInput): CommitRequest {
  const blobs: Array<{ path: string; content: string }> = [];
  const deletions: string[] = [];

  for (const file of input.selected) {
    if (file.state === "diverged") {
      throw new Error(`Refusing to commit a diverged file: ${file.path}`);
    }
    const content = input.local.get(file.path);
    if (content === undefined) deletions.push(file.path);
    else blobs.push({ path: file.path, content });
  }

  blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  deletions.sort();

  return {
    blobs,
    deletions,
    message: input.message,
    parent: input.parent,
    baseTree: input.baseTree,
  };
}

/** The `POST /git/trees` payload, once the blobs have SHAs. */
export function treeEntries(
  request: CommitRequest,
  blobShas: Record<string, string>
): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const blob of request.blobs) {
    const sha = blobShas[blob.path];
    if (sha === undefined) throw new Error(`No blob SHA for ${blob.path}`);
    entries.push({ path: blob.path, mode: FILE_MODE, type: "blob", sha });
  }
  for (const path of request.deletions) {
    entries.push({ path, mode: FILE_MODE, type: "blob", sha: null });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The commit message — UX §7.3
// ---------------------------------------------------------------------------

/** One file's contribution to the message, in the user's units rather than git's. */
export interface MessageFile {
  path: string;
  /** The set this file holds, as the panel names it — `Theme / Light`, `Styles / Text`. */
  set?: string;
  /** Token-level changes inside the file. */
  changed: number;
  added: number;
  removed: number;
  /** True for `$manifest.json`, which is about sets rather than tokens. */
  manifest?: boolean;
}

export interface CommitMessage {
  summary: string;
  body: string;
}

/**
 * The generated default — good enough to accept without reading, specific enough to be worth
 * reading later (UX §7.3). That is the bar for a default, and ADR-0006 §8's reason for having one:
 * *"a repo whose history is 200 identical `Update tokens` commits is a history nobody reads."*
 *
 * No `Tokenvault` byline, no emoji, no trailer. The commit author is already the PAT's owner.
 */
export function generateCommitMessage(files: MessageFile[]): CommitMessage {
  const real = files.filter((file) => file.manifest !== true);
  const names = uniqueSetNames(real);

  let summary: string;
  if (names.length === 0) {
    summary = files.length === 0 ? "Update tokens" : "Update token sets";
  } else if (real.every((file) => file.changed === 0 && file.removed === 0 && file.added > 0)) {
    summary = `Add ${joinNames(names)}`;
  } else if (names.length > 2) {
    // The collapsed form already contains the noun — "Update 3 token sets tokens" is what happens
    // if the suffix is appended unconditionally, and it is the kind of sentence a generated default
    // has to not produce, because nobody reads a default carefully enough to catch it.
    summary = `Update ${joinNames(names)}`;
  } else {
    summary = `Update ${joinNames(names)} tokens`;
  }

  const parts: string[] = [];
  for (const file of real) {
    const bits: string[] = [];
    if (file.changed > 0) bits.push(`${file.changed} value${file.changed === 1 ? "" : "s"}`);
    if (file.added > 0) bits.push(`${file.added} added`);
    if (file.removed > 0) bits.push(`${file.removed} removed`);
    if (bits.length > 0) parts.push(`${bits.join(", ")} in ${file.set ?? file.path}`);
  }
  const manifestChanged = files.length - real.length;
  if (manifestChanged > 0) parts.push("manifest updated");

  return { summary, body: parts.length === 0 ? "" : `${parts.join("; ")}.` };
}

/**
 * Collection names, not mode names: `Theme / Light` and `Theme / Dark` in one commit is a change to
 * *Theme*, and a summary reading "Update Theme / Light and Theme / Dark tokens" spends its whole
 * width on the part the body already says better.
 */
function uniqueSetNames(files: MessageFile[]): string[] {
  const names: string[] = [];
  for (const file of files) {
    const set = file.set;
    if (set === undefined) continue;
    const head = set.split("/")[0].trim();
    if (head.length > 0 && names.indexOf(head) === -1) names.push(head);
  }
  return names;
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  // Three or more collapses rather than listing: a 50-character summary line is the budget, and a
  // seven-set commit's summary should say how many, not recite them.
  return `${names.length} token sets`;
}

/**
 * The full message git receives.
 *
 * The summary can never be empty (UX §7.3): clearing it restores the generated text rather than
 * blocking the button, because an empty commit message is not a state anyone wants — it is one they
 * arrived at by selecting all and typing.
 */
export function composeMessage(message: CommitMessage, fallback: CommitMessage): string {
  const summary = message.summary.trim().length === 0 ? fallback.summary : message.summary.trim();
  const body = message.body.trim();
  return body.length === 0 ? summary : `${summary}\n\n${body}`;
}
