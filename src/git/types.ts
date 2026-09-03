// The shared vocabulary of git sync — ADR-0006.
//
// Nothing here is impure and nothing here knows about `fetch` or `clientStorage`. `api.ts` produces
// these shapes, `diff.ts` and `commit.ts` reason over them, and the two runtimes (sandbox and
// iframe) exchange them across `postMessage`.

/**
 * The connection, minus the credential — ADR-0006 §3's `tokenvault:github`.
 *
 * User-scoped, not file-scoped: a repo and a token belong to the person, not to the Figma file.
 * The *connection* (`SyncState`) is what belongs to the file.
 */
export interface RepoSettings {
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative, always with a trailing slash stripped. `tokens` by default. */
  tokensDir: string;
  /**
   * The last four characters of the stored PAT, and the only part of it that is ever rendered.
   *
   * ADR-0006 §1: the token itself never enters the DOM. This exists for exactly one question —
   * *is this the token I think it is* — which is the whole job a masked credential should do.
   */
  patLastFour?: string;
}

/**
 * What both sides agreed on last time — ADR-0006 §3's `tokenvault:sync:<file-id>`.
 *
 * `blobShas` is the merge base, at 40 bytes per file rather than the 60KB the content would cost.
 * The pulled tree itself is never persisted (§3); if it is wanted again, it is one cheap request.
 */
export interface SyncState {
  owner: string;
  repo: string;
  branch: string;
  /** The commit this base was established against — the parent of the next push (§8). */
  baseCommitSha: string;
  blobShas: Record<string, string>;
  at: string;
}

/** One entry of `GET /git/trees/{ref}?recursive=1`, reduced to what sync needs. */
export interface RemoteEntry {
  path: string;
  sha: string;
  size?: number;
}

export interface RemoteTree {
  commitSha: string;
  treeSha: string;
  /** Repo-relative path → blob SHA, blobs only. */
  blobs: Record<string, string>;
  /** True when GitHub truncated the recursive listing — a tree too big to answer in one call. */
  truncated: boolean;
}

/** ADR-0006 §4's table, with UX §3's copy attached to each row. */
export type FileSyncState = "in-sync" | "to-push" | "to-pull" | "diverged";

export interface FileStatus {
  path: string;
  state: FileSyncState;
  /** Absent when the file does not exist on that side. */
  localSha?: string;
  remoteSha?: string;
  baseSha?: string;
}

export interface SyncStatus {
  files: FileStatus[];
  toPush: FileStatus[];
  toPull: FileStatus[];
  diverged: FileStatus[];
  /** True when every file agrees on all three sides. */
  clean: boolean;
}

/**
 * A named failure — ADR-0006 §10, *"every failure is named"*.
 *
 * `message` is written by us from a status code and never contains GitHub's response body or a URL
 * (UX §14): a response body can echo a request header, and a URL can carry a token.
 */
export interface GitFailure {
  kind:
    | "offline"
    | "unauthorized"
    | "forbidden-write"
    | "rate-limited"
    | "not-found"
    | "non-fast-forward"
    | "not-configured"
    | "bad-json"
    | "unknown";
  message: string;
  /** Unix epoch seconds, present only on `rate-limited`. */
  rateLimitReset?: number;
}

export class GitError extends Error {
  readonly failure: GitFailure;

  constructor(failure: GitFailure) {
    super(failure.message);
    this.name = "GitError";
    this.failure = failure;
  }
}

/** Whatever the last response said about the hour's budget — surfaced, never inferred (§10). */
export interface RateLimit {
  remaining: number;
  limit: number;
  reset: number;
}
