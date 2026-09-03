// Local tree vs. remote tree → sync status — ADR-0006 §4.
//
// Pure, and deliberately tiny: every state in the product falls out of comparing three SHAs per
// path, and no content is downloaded to answer *whether* something changed.
//
//   | local vs. base | remote vs. base | State          |
//   |----------------|-----------------|----------------|
//   | same           | same            | in sync        |
//   | differs        | same            | to push        |
//   | same           | differs         | to pull        |
//   | differs        | differs         | diverged (§6)  |
//
// The one rule the table does not state, and which has to be here rather than in the table, is what
// an *absent* base means. Before the first successful sync there is no base at all, so both sides
// "differ from base" and every file would read as diverged — which is exactly the useless bootstrap
// ADR-0006 §6 puts the first-connect question in front of. `sameSha` treats absent-vs-absent as
// agreement, and `computeStatus` short-circuits when the two sides are byte-identical, so a file
// that happens to match on both sides is never reported as a conflict about nothing.

import type { FileStatus, SyncStatus } from "./types";
import { blobSha } from "./blob";
import { DEFAULT_TOKENS_DIR } from "./state";
import { IMPORT_REPORT_PATH, toRepoPath } from "./paths";

export interface StatusInput {
  /** Repo-relative path → the exact bytes a push would write. `stableStringify` output. */
  local: Map<string, string>;
  /** Repo-relative path → blob SHA, from one `GET /git/trees?recursive=1`. */
  remote: Record<string, string>;
  /** The merge base: path → blob SHA at the last successful sync. Empty before first connect. */
  base: Record<string, string>;
  /** The configured folder, so the reserved report path can be recognised in its repo shape. */
  tokensDir?: string;
}

function sameSha(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

/**
 * Every path either side knows about, in one deterministic order.
 *
 * Sorted rather than insertion-ordered so two runs over the same inputs produce the same list —
 * the same reason ADR-0002 §7 sorts everything else. A Repo tab that reshuffled its file list
 * between two identical status checks would look like it had found something.
 */
function allPaths(input: StatusInput): string[] {
  const paths = new Set<string>();
  for (const path of input.local.keys()) paths.add(path);
  for (const path of Object.keys(input.remote)) paths.add(path);
  for (const path of Object.keys(input.base)) paths.add(path);
  return Array.from(paths).sort();
}

export function computeStatus(input: StatusInput): SyncStatus {
  const files: FileStatus[] = [];

  for (const path of allPaths(input)) {
    // The report is machine state about a scan and is not part of the repo (ADR-0006 §5). Excluded
    // here rather than filtered in the UI (UX §14) so it cannot reach a diff list by any route.
    if (isExcluded(path, input.tokensDir ?? DEFAULT_TOKENS_DIR)) continue;

    const content = input.local.get(path);
    const localSha = content === undefined ? undefined : blobSha(content);
    const remoteSha = input.remote[path];
    const baseSha = input.base[path];

    if (localSha === undefined && remoteSha === undefined) continue;

    const status: FileStatus = { path, state: "in-sync", localSha, remoteSha, baseSha };

    if (sameSha(localSha, remoteSha)) {
      // Byte-identical on both sides. Whatever the base says, there is nothing to move, and
      // reporting a conflict about two files that agree would be the design's silliest failure.
      files.push(status);
      continue;
    }

    const localMoved = !sameSha(localSha, baseSha);
    const remoteMoved = !sameSha(remoteSha, baseSha);

    if (localMoved && remoteMoved) status.state = "diverged";
    else if (localMoved) status.state = "to-push";
    else status.state = "to-pull";

    files.push(status);
  }

  const toPush = files.filter((file) => file.state === "to-push");
  const toPull = files.filter((file) => file.state === "to-pull");
  const diverged = files.filter((file) => file.state === "diverged");

  return {
    files,
    toPush,
    toPull,
    diverged,
    clean: toPush.length === 0 && toPull.length === 0 && diverged.length === 0,
  };
}

/**
 * `$import-report.json` and nothing else. Named as a predicate so the reason travels with it.
 *
 * Matched on the **whole path**, not the basename: the report only ever lives at one place, and a
 * basename match would silently swallow an unrelated user file that happened to be called
 * `$import-report.json` somewhere else in the repo — excluded from every diff and every push with
 * nothing in the UI to say why. `tokensDir` translates `IMPORT_REPORT_PATH` into the repo shape for
 * the callers holding repo-shaped paths; omitted, the comparison is against the build-shaped path
 * the generator emits.
 */
export function isExcluded(path: string, tokensDir?: string): boolean {
  const expected =
    tokensDir === undefined ? IMPORT_REPORT_PATH : toRepoPath(IMPORT_REPORT_PATH, tokensDir);
  return path === expected;
}

/**
 * The merge base to seed on first connect — ADR-0006 §6, UX §5.3.
 *
 * **The mapping is inverted from what the wording suggests, and that is worth reading twice.** The
 * base is not "the side that wins"; it is *what both sides last agreed on*, and the state table
 * above then derives the direction from it:
 *
 * | Answer | Base becomes | Because the table then says | Which is |
 * |---|---|---|---|
 * | *The repo* — adopt it | **our** SHAs | remote differs from base, local matches | **to pull** |
 * | *This Figma file* — publish it | **the repo's** SHAs | local differs from base, remote matches | **to push** |
 *
 * Setting the base to the repo when the user asked to *adopt* the repo would mark every file as
 * something to push — i.e. it would offer to overwrite the repo the user just chose to defer to,
 * which is the exact opposite of the non-destructive default §5.3 preselects. An empty repo lands
 * on the publish branch with an empty base, and every file reads as to-push: *"the chip reads
 * `↑ 12` — everything to push, which is exactly right"*.
 */
export function seedBlobShas(
  side: "repo" | "figma",
  localShas: Record<string, string>,
  remoteShas: Record<string, string>
): Record<string, string> {
  return side === "repo" ? { ...localShas } : { ...remoteShas };
}

/**
 * The base to record after a successful sync: the remote SHAs as they now stand.
 *
 * Taken from what was actually written rather than re-derived from the local tree, because the
 * two can legitimately differ — a push that committed three of five checked files leaves the other
 * two still to push, and a base claiming otherwise would lose them.
 */
export function advanceBase(
  base: Record<string, string>,
  changes: Record<string, string | null>
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const path of Object.keys(base)) next[path] = base[path];
  for (const path of Object.keys(changes)) {
    const sha = changes[path];
    if (sha === null) delete next[path];
    else next[path] = sha;
  }
  return next;
}
