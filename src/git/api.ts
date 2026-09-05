// The GitHub REST edge — ADR-0006 §1, §8, §10.
//
// **This is the only module in the codebase that calls `fetch`, and the only one that knows the
// GitHub API exists.** Same one-impure-edge boundary as `src/figma/apply.ts` (ADR-0005 §3),
// ADR-0003 §7 and ADR-0002's module layout: everything that *decides* anything is pure and testable
// without a network, and the untestable part is this file and nothing else. `test/gitInvariant.test.ts`
// asserts it by source inspection, the same way the apply boundary is asserted.
//
// It runs in the **UI iframe**, because the Figma plugin sandbox has no network stack. Its mirror
// image is `clientStorage`, which is sandbox-only — so the two halves of "read the PAT and call
// GitHub" sit on opposite sides of the `postMessage` boundary and there is no arrangement that
// avoids that (§1).
//
// Three rules about the credential, enforced here in code rather than by care:
//
//   1. The PAT is held in a **closure for one operation** and dropped. No module-level cache, no
//      `window` property, no `localStorage`.
//   2. It is **never logged and never included in an error payload.** Every failure this module
//      raises is a `GitError` whose message this file wrote from a status code — GitHub's response
//      body is never rendered, because a body can echo a request header, and neither is a URL,
//      because a URL can carry a token.
//   3. It **never enters the DOM.** That rule is the settings field's, not this module's, but it is
//      the reason `lastFour` is stored beside the token rather than derived from it at render time.

import type { RateLimit, RemoteTree } from "./types";
import { GitError } from "./types";
import { treeEntries, type CommitRequest } from "./commit";
import type { WorkflowJobSummary, WorkflowRunSummary } from "./pipeline";

const API = "https://api.github.com";

/**
 * A GitHub client bound to one credential, for the length of one operation.
 *
 * Constructed with the token, used, and dropped. Callers hold the *client*, never the token, which
 * is what keeps the credential out of every call signature between here and the UI.
 */
export interface GitClient {
  owner: string;
  repo: string;
  /** Whatever the last response said about the hour's budget. `null` until a call has been made. */
  rateLimit(): RateLimit | null;
  getBranches(): Promise<string[]>;
  getRef(branch: string): Promise<{ commitSha: string }>;
  getTree(branch: string): Promise<RemoteTree>;
  getBlob(sha: string): Promise<string>;
  push(request: CommitRequest, branch: string): Promise<{ commitSha: string; url: string; blobShas: Record<string, string> }>;

  // -- Actions, read-only (issue #25). Nothing here starts, re-runs or cancels anything. --

  /** The most recent workflow runs on one branch, newest first as GitHub returns them. */
  getWorkflowRuns(branch: string, limit?: number): Promise<WorkflowRunSummary[]>;
  getRunJobs(runId: number): Promise<WorkflowJobSummary[]>;
  /** One job's log as text, or `null` when it can't be read. See `getJobLog` for why null. */
  getJobLog(jobId: number): Promise<string | null>;
}

export interface ClientOptions {
  owner: string;
  repo: string;
  token: string;
}

export function createClient(options: ClientOptions): GitClient {
  // The closure §1 requires. `options.token` is captured here and is never stored on the returned
  // object, never passed to a caller, and never reachable from anything the UI holds.
  const token = options.token;
  const { owner, repo } = options;
  let limit: RateLimit | null = null;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      });
    } catch {
      // A network-level failure is offline, not an error. Figma plugins run offline; the panel keeps
      // working and nothing about the local tree depends on this succeeding (§10).
      throw new GitError({
        kind: "offline",
        message: "Can't reach GitHub. Your tokens and local changes are fine — sync will pick up when you're back online.",
      });
    }

    readRateLimit(response);
    if (!response.ok) throw describeFailure(response, init?.method ?? "GET");
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch {
      throw new GitError({
        kind: "bad-json",
        message: "GitHub sent something Tokenvault couldn't read. Try again in a moment.",
      });
    }
  }

  /** A header that isn't a number is not a zero and not a large number — it is an absent answer. */
  function numberOrNull(raw: string | null): number | null {
    if (raw === null || raw.trim().length === 0) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function readRateLimit(response: Response): void {
    // ADR-0006's one open question was whether these headers survive the plugin's CORS posture.
    // They are read defensively for that reason: absent headers leave `limit` null and the panel
    // simply never shows a budget line, rather than showing a wrong one.
    const remaining = response.headers.get("x-ratelimit-remaining");
    const total = response.headers.get("x-ratelimit-limit");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining === null) return;
    limit = {
      remaining: numberOrNull(remaining),
      limit: numberOrNull(total) ?? 5000,
      reset: numberOrNull(reset) ?? 0,
    };
  }

  /**
   * §10's failure taxonomy. Every branch writes its own sentence; none of them quotes GitHub.
   *
   * The 404 wording is deliberately non-committal: a missing repo and a token without access to it
   * are indistinguishable in GitHub's response — that is a deliberate property of theirs, not a gap
   * in ours — so the message says so instead of guessing and sending the user after the wrong fix.
   */
  function describeFailure(response: Response, method: string): GitError {
    if (response.status === 401) {
      return new GitError({
        kind: "unauthorized",
        message: "GitHub rejected the token. It may have expired or been revoked.",
      });
    }
    if (response.status === 403 || response.status === 429) {
      // Two different limits wear the same status code. The primary one spends
      // `x-ratelimit-remaining` down to zero; the **secondary** one — GitHub's throttle on bursts of
      // writes — sends `Retry-After` with the budget still showing plenty left, and a 429 is a rate
      // limit by definition whatever the headers say. Missing that case sent a correctly scoped
      // token down the permissions branch and told the user to go widen it, which is both wrong and
      // the one piece of advice that can't be undone by waiting.
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retryAfter = numberOrNull(response.headers.get("retry-after"));
      if (remaining === "0" || retryAfter !== null || response.status === 429) {
        const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
        const secondary = remaining !== "0";
        return new GitError({
          kind: "rate-limited",
          message: secondary
            ? "GitHub is throttling requests from this token. Give it a minute and try again."
            : "GitHub's rate limit is used up.",
          // `Retry-After` is a delay in seconds; `x-ratelimit-reset` is an absolute time. The field
          // holds the latter, so the delay is turned into one rather than passed through as 60.
          rateLimitReset:
            secondary && retryAfter !== null
              ? Math.floor(Date.now() / 1000) + retryAfter
              : reset,
        });
      }
      if (method !== "GET") {
        return new GitError({
          kind: "forbidden-write",
          message: "This token can only read the repo. Push needs a token with Contents: read and write.",
        });
      }
      return new GitError({
        kind: "forbidden-write",
        message: "GitHub refused the request with this token. Check its repository access.",
      });
    }
    if (response.status === 404) {
      return new GitError({
        kind: "not-found",
        message: `Can't find ${owner}/${repo}. Either it doesn't exist, or your token doesn't have access to it — GitHub's answer is the same either way.`,
      });
    }
    if (response.status === 409 || response.status === 422) {
      return new GitError({
        kind: "non-fast-forward",
        message: "The branch moved while you were writing. Nothing was pushed.",
      });
    }
    return new GitError({
      kind: "unknown",
      message: `GitHub refused the request (${response.status}). Nothing was changed.`,
    });
  }

  return {
    owner,
    repo,
    rateLimit: () => limit,

    async getBranches(): Promise<string[]> {
      const branches = await call<Array<{ name: string }>>(
        `/repos/${owner}/${repo}/branches?per_page=100`
      );
      return branches.map((branch) => branch.name);
    },

    async getRef(branch: string): Promise<{ commitSha: string }> {
      const ref = await call<{ object: { sha: string } }>(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
      );
      return { commitSha: ref.object.sha };
    },

    /**
     * The whole sync status question, in one request — §4.
     *
     * `?recursive=1` returns every path in the tree, so `path → blob SHA` for the entire repo costs
     * one call and no measurable transfer. That is what makes it affordable to answer on demand at
     * every panel open, rather than remembering a stale answer.
     */
    async getTree(branch: string): Promise<RemoteTree> {
      const { commitSha } = await this.getRef(branch);
      const commit = await call<{ tree: { sha: string } }>(
        `/repos/${owner}/${repo}/git/commits/${commitSha}`
      );
      const tree = await call<{
        sha: string;
        truncated?: boolean;
        tree: Array<{ path: string; type: string; sha: string }>;
      }>(`/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);

      const blobs: Record<string, string> = {};
      for (const entry of tree.tree) {
        if (entry.type === "blob") blobs[entry.path] = entry.sha;
      }
      return { commitSha, treeSha: tree.sha, blobs, truncated: tree.truncated === true };
    },

    /** Content for one file. Called only for paths that actually differ (§4). */
    async getBlob(sha: string): Promise<string> {
      const blob = await call<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/git/blobs/${sha}`
      );
      if (blob.encoding !== "base64") return blob.content;
      return decodeBase64(blob.content);
    },

    /**
     * The latest workflow runs on a branch — issue #25's build status, in one request.
     *
     * `exclude_pull_requests` keeps the answer about the branch itself rather than about every PR
     * that happens to target it, and a small `per_page` is deliberate: the panel needs the newest
     * run of one workflow, and paging further to find an older one would answer a question nobody
     * asked. Reduced to `WorkflowRunSummary` here so nothing downstream ever holds a raw payload.
     */
    async getWorkflowRuns(branch: string, limit = 20): Promise<WorkflowRunSummary[]> {
      const body = await call<{
        workflow_runs?: Array<Record<string, unknown>>;
      }>(
        `/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${limit}&exclude_pull_requests=true`
      );
      return (body.workflow_runs ?? []).map((run) => ({
        id: Number(run.id ?? 0),
        path: typeof run.path === "string" ? run.path : "",
        name: typeof run.name === "string" ? run.name : "",
        status: typeof run.status === "string" ? run.status : "",
        conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
        headSha: typeof run.head_sha === "string" ? run.head_sha : "",
        createdAt: typeof run.created_at === "string" ? run.created_at : "",
        htmlUrl: typeof run.html_url === "string" ? run.html_url : "",
        runNumber: Number(run.run_number ?? 0),
      }));
    },

    /** The jobs of one run, so a failure can name the step it failed at. */
    async getRunJobs(runId: number): Promise<WorkflowJobSummary[]> {
      const body = await call<{ jobs?: Array<Record<string, unknown>> }>(
        `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=30`
      );
      return (body.jobs ?? []).map((job) => ({
        id: Number(job.id ?? 0),
        name: typeof job.name === "string" ? job.name : "",
        conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
        steps: Array.isArray(job.steps)
          ? (job.steps as Array<Record<string, unknown>>).map((step) => ({
              name: typeof step.name === "string" ? step.name : "",
              conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
            }))
          : [],
      }));
    },

    /**
     * One job's log — the only place the build's own diagnostics exist (issue #25, gap 9).
     *
     * Two things make this the one call in this file that returns `null` instead of throwing.
     * It answers with a **302 to a signed storage URL**, not with JSON, and that redirect target is
     * a different origin whose CORS posture is not ours to rely on from inside a plugin iframe; and
     * a fine-grained PAT scoped only to `Contents` cannot read Actions at all. Neither is a sync
     * failure and neither should raise one — the panel simply says it couldn't read *why* the build
     * failed and still shows that it failed, with a link to the run. That is `error-states.md`'s
     * rule applied here: a degraded answer, never a crash and never a lost primary fact.
     *
     * The text is returned raw and is **never rendered**: `pipeline.ts` extracts only lines matching
     * the exact `[kind] theme: message` shape our own build script prints (ADR-0006 §10).
     */
    async getJobLog(jobId: number): Promise<string | null> {
      let response: Response;
      try {
        response = await fetch(`${API}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        return null;
      }
      readRateLimit(response);
      if (!response.ok) return null;
      try {
        return await response.text();
      } catch {
        return null;
      }
    },

    /**
     * The four-call sequence, plus one per changed file — §8.
     *
     *   POST /git/blobs   × N     → blob SHAs
     *   POST /git/trees           base_tree = head's tree, with the N entries replaced
     *   POST /git/commits         parent = the recorded base commit
     *   PATCH /git/refs/heads/…   force: false
     *
     * Two properties are load-bearing. `base_tree` means files outside the tokens folder are carried
     * through by SHA and never rewritten — the blast-radius promise UX §5.2 makes in words. And
     * `force: false` makes a concurrent push *fail* instead of clobber: if the branch moved since the
     * status check, GitHub rejects the non-fast-forward and the plugin re-runs §4's comparison
     * against the new head. That flag is the only guard against a lost commit.
     *
     * Nothing becomes visible until the final `PATCH`, so a failure anywhere above it leaves
     * orphaned blobs GitHub garbage-collects and no branch movement. A failed push leaves the repo
     * exactly as it was, which is what lets every failure message say *nothing was pushed*.
     */
    async push(request: CommitRequest, branch: string) {
      const blobShas: Record<string, string> = {};
      for (const blob of request.blobs) {
        const created = await call<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: blob.content, encoding: "utf-8" }),
        });
        blobShas[blob.path] = created.sha;
      }

      const tree = await call<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          base_tree: request.baseTree,
          tree: treeEntries(request, blobShas),
        }),
      });

      const commit = await call<{ sha: string; html_url?: string }>(
        `/repos/${owner}/${repo}/git/commits`,
        {
          method: "POST",
          body: JSON.stringify({
            message: request.message,
            tree: tree.sha,
            parents: [request.parent],
          }),
        }
      );

      await call<unknown>(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });

      return {
        commitSha: commit.sha,
        url: commit.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
        blobShas,
      };
    },
  };
}

/**
 * Base64 → UTF-8 text.
 *
 * `atob` gives one byte per character; the multi-byte sequences in a token file (an em dash in a
 * `$description`, a non-ASCII set name) then have to be decoded by hand. Doing it via `TextDecoder`
 * where available and by hand where it is not keeps a file with an accented character in it from
 * arriving as mojibake and looking like a repo-side edit nobody made.
 */
function decodeBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);

  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i];
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      i += 1;
    } else if (byte < 0xe0) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (byte < 0xf0) {
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const code =
        ((byte & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const offset = code - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
      i += 4;
    }
  }
  return out;
}
