// The pre-push gate — ADR-0002 Amendment 3, ADR-0008 §3, §6a, ADR-0002 Amendment 2 §F.
//
// **A tree that does not resolve is not pushed.** The gate is stated over the built tree rather
// than over a list of report kinds:
//
//   > Every reference in the tree resolves to a token that exists in the tree, and no reference
//   > chain closes on itself.
//
// Phrasing it as a property of the tree is what makes it stable. A future way to lose a reference
// target does not have to remember to add itself to an enumeration, and the gate cannot drift out
// of step with whichever report kinds happen to exist. Cycles are in for the same one-sentence
// reason as dangles: Phase 8's export fails the whole build on either, so a tree with one is
// already unpublishable, and refusing a tree that cannot build for one reason while waving it
// through for the other would be an odd gap.
//
// Two scopes, and the distinction is the whole of ADR-0008 §3:
//
//   - **Local-tree blocks** are identical in every projection, so they block *every* connection.
//   - **A routing dangle** is a property of one projection — the local tree is fine and only one
//     repo's copy is not — so it blocks that repo and no other.
//
// Everything here is computed **before any network call**, from local data. A block discovered
// after three repos have already committed is not a block, it is a report of damage.

import type { ReportEntry, Token, TokenGroup } from "../tokens/types";
import type { PathRule } from "../tokens/rules";
import type { Projection } from "./routing";
import type { FlatToken } from "../tokens/view";
import { buildReferenceGraph, cycleSummary, findCycles } from "../tokens/graph";
import { outgoingPaths } from "../tokens/graph";
import { normalizePathKey } from "../tokens/paths";
import { rulesEqual } from "../tokens/rules";
import { flattenTree } from "./filediff";
import { compareKeys } from "../tokens/serialize";

export type PushBlockKind =
  /** A reference with no target in the local tree — Amendment 3 §A, every cause. */
  | "unresolved-reference"
  /** A reference or expression chain that closes on itself — ADR-0007 §3, gated at push by §A. */
  | "reference-cycle"
  /** Target routed to another repo — ADR-0008 §3. The one kind that blocks a single repo. */
  | "routing-dangling-reference"
  /** The repo's `$rules.json` differs from the local one — Amendment 2 §F. Blocks that whole repo. */
  | "rule-set-mismatch";

export interface PushBlock {
  kind: PushBlockKind;
  /** Machine-readable cause, matching the report entry the same condition files. */
  reason: string;
  /** Renders straight into the Review & push screen. Names the cause **and** the fix (§7). */
  message: string;
  /** The referring token, where there is one. */
  path?: string;
  setId?: string;
  /** The reference that does not resolve. */
  target?: string;
  /** Present only on a block scoped to one repo; absent means it blocks every connection. */
  connectionId?: string;
}

// ---------------------------------------------------------------------------
// The local tree
// ---------------------------------------------------------------------------

/**
 * Every reason the local tree may not be pushed anywhere.
 *
 * Resolution is over the **whole tree**, first-wins, matching `plan.ts`'s alias index: the question
 * Amendment 3 asks is whether a token by that path exists at all, not whether the active theme
 * happens to select it. A theme-scoped miss is ADR-0007's `unresolved-in-theme` warning, which is
 * frequently the correct state of a correct token and deliberately does not block.
 */
export function localTreeBlocks(tokens: FlatToken[]): PushBlock[] {
  const blocks: PushBlock[] = [];
  const known = new Set<string>();
  for (const entry of tokens) known.add(normalizePathKey(entry.path));

  for (const entry of tokens) {
    for (const target of outgoingPaths(entry.token)) {
      if (known.has(normalizePathKey(target))) continue;
      blocks.push({
        kind: "unresolved-reference",
        reason: "unresolved-reference",
        message: `${entry.path} (${entry.setId}) references ${target}, which no token in the tree defines. A tree with an unresolved reference fails the export build outright, so it is not pushed. Fix the reference, or the rule or Figma name that lost its target.`,
        path: entry.path,
        setId: entry.setId,
        target,
      });
    }
  }

  const graph = buildReferenceGraph(tokens, { resolution: "first" });
  for (const cycle of findCycles(graph).cycles) {
    const first = graph.nodes.get(cycle.nodes[0]);
    blocks.push({
      kind: "reference-cycle",
      reason: "reference-cycle",
      message: `These tokens reference each other in a loop: ${cycleSummary(graph, cycle)}. A cycle has no value to build, so it is not pushed. Break the loop on any token on it.`,
      path: first?.path,
      setId: first?.setId,
    });
  }

  return dedupe(blocks);
}

/** The same question asked of serialized trees, which is the shape the push path already holds. */
export function localTreeBlocksFromTrees(trees: Map<string, TokenGroup>, setOfFile?: Map<string, string>): PushBlock[] {
  return localTreeBlocks(flatten(trees, setOfFile));
}

// ---------------------------------------------------------------------------
// One repo's projection
// ---------------------------------------------------------------------------

/**
 * References that resolve locally but would dangle in this repo — ADR-0008 §3.
 *
 * **A routing rule is a hard wall.** Widening the projection to pull the missing target in was
 * rejected: it would make the rules describe something other than what actually happens, and the
 * widening is invisible unless the user reads a diff closely. A named, pre-push block is louder and
 * keeps the rules literally true.
 *
 * The whole push to this repo is blocked, not one file: unlike a diverged file there is no per-file
 * choice to offer, since the fix is a rule edit and a rule edit is global. Pushing nine of ten files
 * while withholding the one holding the referrer produces a differently incomplete tree, not a
 * better one.
 */
export function projectionBlocks(projection: Projection): PushBlock[] {
  const known = new Set<string>();
  for (const entry of projection.tokens) known.add(normalizePathKey(entry.path));

  const blocks: PushBlock[] = [];
  for (const entry of projection.tokens) {
    for (const target of outgoingPaths(entry.token)) {
      if (known.has(normalizePathKey(target))) continue;
      blocks.push({
        kind: "routing-dangling-reference",
        reason: "cross-repo",
        message: `${entry.path} (${entry.setId}) references ${target}, which a routing rule keeps out of this repo. Route ${target} here too, or stop routing ${entry.path} away from where it lives.`,
        path: entry.path,
        setId: entry.setId,
        target,
        connectionId: projection.connectionId,
      });
    }
  }

  return dedupe(blocks);
}

/**
 * Amendment 2 §F: a repo whose `$rules.json` differs from the local one blocks both push and pull
 * for that repo, and says so.
 *
 * Unlike a diverged token file this blocks the **whole** repo, because the rule set determines the
 * path of every token in the tree — there is no subset of files it leaves trustworthy. Other
 * connected repos are unaffected (ADR-0008 §4).
 */
export function ruleSetMismatchBlock(
  connectionId: string,
  local: PathRule[],
  remote: PathRule[] | null
): PushBlock | null {
  // A repo with no `$rules.json` yet is not mismatched — it is a repo this feature has not reached,
  // and the push that introduces the file is how it gets one.
  if (remote === null) return null;
  if (rulesEqual(local, remote)) return null;

  return {
    kind: "rule-set-mismatch",
    reason: "rules-differ",
    message: `This repo's tokens/$rules.json is not the one in use here. The rule set decides the path of every token, so nothing in this repo can be pushed or pulled until the two agree — take the repo's rules, or push yours over them.`,
    connectionId,
  };
}

// ---------------------------------------------------------------------------
// The whole gate
// ---------------------------------------------------------------------------

export interface PushGateInput {
  /** The local tree, flattened. Blocks found here stop every connection. */
  tokens: FlatToken[];
  projections: Projection[];
  /** The rules in force locally, and each repo's committed set where it has been read. */
  localRules?: PathRule[];
  remoteRules?: Map<string, PathRule[] | null>;
}

export interface PushGateResult {
  /** Blocks every connection at once, so the screen shows them once above the per-repo list (§7). */
  global: PushBlock[];
  /** Connection id → its own blocks. A connection absent from the map is clear to push. */
  perRepo: Map<string, PushBlock[]>;
  /** Connection ids that may push. Empty when the local tree itself does not resolve. */
  pushable: string[];
}

/**
 * Everything that refuses, computed in one pass before any network call.
 *
 * The two scopes never merge: an unresolvable local tree is one message above the per-repo list
 * rather than the same message repeated ten times, and a per-repo block always names its repo
 * (§6a — *"a block names its repo"*, never *"the push failed"*).
 */
export function evaluatePushGate(input: PushGateInput): PushGateResult {
  const global = localTreeBlocks(input.tokens);
  const perRepo = new Map<string, PushBlock[]>();

  for (const projection of input.projections) {
    const blocks = projectionBlocks(projection);

    const mismatch =
      input.localRules === undefined || input.remoteRules === undefined
        ? null
        : ruleSetMismatchBlock(
            projection.connectionId,
            input.localRules,
            input.remoteRules.has(projection.connectionId)
              ? (input.remoteRules.get(projection.connectionId) as PathRule[] | null)
              : null
          );
    if (mismatch !== null) blocks.push(mismatch);

    if (blocks.length > 0) perRepo.set(projection.connectionId, blocks);
  }

  return {
    global,
    perRepo,
    // One repo failing does not stop the next (§4), but an unresolvable local tree stops all of
    // them — the breakage is in the tree itself and is identical in every projection.
    pushable:
      global.length > 0
        ? []
        : input.projections
            .map((projection) => projection.connectionId)
            .filter((id) => !perRepo.has(id)),
  };
}

// ---------------------------------------------------------------------------
// Report entries
// ---------------------------------------------------------------------------

/**
 * A block as an import-report entry, so the same condition reads the same in both surfaces.
 *
 * The gate does not need its own detector and does not get its own vocabulary: Amendment 3's table
 * maps every cause onto an entry kind that already exists, and this is that mapping in code.
 */
export function blockToEntry(block: PushBlock): ReportEntry {
  const entry: ReportEntry = {
    kind:
      block.kind === "routing-dangling-reference"
        ? "routing-dangling-reference"
        : block.kind === "reference-cycle"
          ? "reference-cycle"
          : block.kind === "rule-set-mismatch"
            ? "path-rule"
            : "dangling-reference",
    reason: block.reason,
    message: block.message,
  };
  if (block.path !== undefined) entry.path = block.path;
  if (block.setId !== undefined) entry.set = block.setId;
  if (block.connectionId !== undefined) entry.connectionId = block.connectionId;
  return entry;
}

// ---------------------------------------------------------------------------

function flatten(trees: Map<string, TokenGroup>, setOfFile?: Map<string, string>): FlatToken[] {
  const out: FlatToken[] = [];
  for (const buildPath of Array.from(trees.keys()).sort(compareKeys)) {
    const setId = setOfFile?.get(buildPath) ?? buildPath;
    for (const [path, token] of Array.from(flattenTree(trees.get(buildPath) as TokenGroup))) {
      out.push({ path, segments: path.split("."), setId, token: token as Token });
    }
  }
  return out;
}

/** One condition, one block. A token referencing the same missing target twice is one problem. */
function dedupe(blocks: PushBlock[]): PushBlock[] {
  const seen = new Set<string>();
  const out: PushBlock[] = [];
  for (const block of blocks) {
    const key = `${block.kind}|${block.setId ?? ""}|${block.path ?? ""}|${block.target ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(block);
  }
  return out.sort(
    (a, b) =>
      compareKeys(a.kind, b.kind) ||
      compareKeys(a.setId ?? "", b.setId ?? "") ||
      compareKeys(a.path ?? "", b.path ?? "") ||
      compareKeys(a.target ?? "", b.target ?? "")
  );
}
