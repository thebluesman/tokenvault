// Push fan-out across N repos — ADR-0008 §4, §6, §7.
//
// **There is no cross-repo transaction, and simulating one would be worse than not having it.**
// GitHub offers no multi-repo atomicity; rolling back a repo that already succeeded means a
// force-push, which ADR-0006 §8's `force: false` rules out and which rewrites history other people
// have. So a four-repo push is four independent runs of ADR-0006 §8's Git Data sequence, executed
// in order, each producing one commit in its own repo.
//
// The result is therefore a **list**, not an outcome. *Amends ADR-0006 §10's "no partial commit
// state"*: that claim was about one repo and is still true of one repo — the Git Data sequence is
// still atomic per repo, and a failure before the final `PATCH` still moves nothing. Across repos,
// partial success is a first-class outcome, and anything rendering "pushed ✅" has to render a list.
//
// This module is the sequencing and the result shape only; the per-repo work is injected, so the
// question *"does one repo failing stop the next?"* is a unit test rather than something you find
// out by pushing to four real repos.

import type { GitFailure } from "./types";
import type { PushBlock } from "./pushGate";

export interface RepoPushResult {
  connectionId: string;
  outcome: "committed" | "blocked" | "failed" | "skipped";
  /** `committed` only. */
  commitSha?: string;
  url?: string;
  files?: number;
  /** `blocked` only — §3, Amendment 2 §F, or an unresolvable local tree. */
  blocks?: PushBlock[];
  /** `failed` only, named per ADR-0006 §10's taxonomy. */
  failure?: GitFailure;
}

export interface FanoutResult {
  results: RepoPushResult[];
  committed: number;
  /** Connections worth offering a retry for — a blocked repo needs a rule edit, not a retry. */
  retryable: string[];
}

export interface FanoutInput {
  /** The enabled connections, in settings order. Push runs in this order. */
  connectionIds: string[];
  /** Connection id → its blocks. A connection with any block is not attempted. */
  blocks: Map<string, PushBlock[]>;
  /** Blocks that stop every connection — an unresolvable local tree (Amendment 3 §A). */
  globalBlocks?: PushBlock[];
  /** One repo's push. Rejecting is a failure, not a reason to abandon the remaining repos. */
  push: (connectionId: string) => Promise<{ commitSha: string; url: string; files: number }>;
  /** Turns a thrown error into ADR-0006 §10's named failure. */
  describe: (error: unknown) => GitFailure;
}

/**
 * Pushes each connection in turn, and never stops on one that fails.
 *
 * Every connection is attempted; blocks are resolved before the run rather than mid-flight (§4).
 * Retry is per repo and safe with no new state: blob-SHA comparison makes a re-push of an
 * already-pushed repo a no-op.
 *
 * Sequential rather than parallel, for the reason the zero-cost check gives: a fan-out orchestrated
 * anywhere but the client would be a component with an owner and a free tier that can change.
 */
export async function fanoutPush(input: FanoutInput): Promise<FanoutResult> {
  const results: RepoPushResult[] = [];
  const globalBlocks = input.globalBlocks ?? [];

  for (const connectionId of input.connectionIds) {
    if (globalBlocks.length > 0) {
      // One message above the per-repo list, not the same message ten times (§7) — so each row
      // says only that it was not attempted, and the reason is rendered once.
      results.push({ connectionId, outcome: "blocked", blocks: globalBlocks });
      continue;
    }

    const blocks = input.blocks.get(connectionId) ?? [];
    if (blocks.length > 0) {
      results.push({ connectionId, outcome: "blocked", blocks });
      continue;
    }

    try {
      const outcome = await input.push(connectionId);
      results.push({
        connectionId,
        outcome: "committed",
        commitSha: outcome.commitSha,
        url: outcome.url,
        files: outcome.files,
      });
    } catch (error) {
      results.push({ connectionId, outcome: "failed", failure: input.describe(error) });
    }
  }

  return {
    results,
    committed: results.filter((result) => result.outcome === "committed").length,
    // A blocked repo is deliberately not retryable: retrying changes nothing until the rule set or
    // the tree does, and an offered retry that cannot work teaches the user to distrust the button.
    retryable: results.filter((result) => result.outcome === "failed").map((result) => result.connectionId),
  };
}

/**
 * The one-line summary above the result list.
 *
 * Never a single tick: "pushed" stopped being a single outcome the moment there was more than one
 * repo (§4), and a summary that reads as success while one repo failed is the lie this phrasing
 * exists to prevent.
 */
export function summarizeFanout(result: FanoutResult): string {
  const failed = result.results.filter((item) => item.outcome === "failed").length;
  const blocked = result.results.filter((item) => item.outcome === "blocked").length;

  const parts: string[] = [
    `Pushed to ${result.committed} of ${result.results.length} repo${result.results.length === 1 ? "" : "s"}`,
  ];
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}
