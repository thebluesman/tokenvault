// Collision detection and winner selection — ADR-0002 §5, as amended by Amendment 1 §E and §F.
//
// Four kinds, all handled the same way: every participant (winner included) is recorded in the
// report with its variable id and the contested path; losers are neither written nor renamed.
// The fix is a rename in Figma.
//
// The ordering cannot make the *right* choice — only a rename can. What it can do is pick the
// loser whose removal breaks least, and say which criterion decided (Amendment 1 §F).

import type {
  CollectionSnapshot,
  ReportEntry,
  ReportParticipant,
  VariableSnapshot,
  WinnerRule,
} from "./types";
import { compareKeys } from "./serialize";
import { isStrictPathPrefix } from "./paths";
import { isAlias } from "./values";

export interface PreparedVariable {
  variable: VariableSnapshot;
  collection: CollectionSnapshot;
  /** Dotted token path, segments verbatim from the Figma name. */
  path: string;
  segments: string[];
  /** Case-folded `path`, the collision key. */
  normalizedPath: string;
}

/**
 * The final, total tiebreak: collection name, then variable name, then variable id.
 *
 * This is criterion 3 of Amendment 1 §F, and on its own it is also the sort that makes the
 * whole output reproducible regardless of the order Figma hands variables back.
 */
export function compareVariables(a: PreparedVariable, b: PreparedVariable): number {
  const byCollection = compareKeys(a.collection.name, b.collection.name);
  if (byCollection !== 0) return byCollection;
  const byName = compareKeys(a.variable.name, b.variable.name);
  if (byName !== 0) return byName;
  return compareKeys(a.variable.id, b.variable.id);
}

/**
 * How many distinct variables in the file alias each variable, in any mode.
 *
 * This is criterion 1's signal: dropping a referenced token cascades into every referrer, so
 * the most-referenced participant is the one whose removal does the most damage.
 */
export function countInboundAliases(variables: VariableSnapshot[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const variable of variables) {
    // A variable aliasing the same target in several modes is still one referrer.
    const targets = new Set<string>();
    for (const modeId of Object.keys(variable.valuesByMode)) {
      const value = variable.valuesByMode[modeId];
      if (isAlias(value) && value.id !== variable.id) targets.add(value.id);
    }
    for (const target of Array.from(targets)) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Criterion 2: how much of the contested path's surrounding namespace this variable's
 * collection already owns.
 *
 * Only *surviving* variables count. A variable already dropped by an earlier pass is not going
 * to be written, so letting it pad its collection's tally would let a phantom token decide a
 * later token/group contest — and could hand the win to the collection with less real presence
 * in the namespace. Participants in the contest itself are excluded too: they are what is being
 * decided.
 */
function namespaceOwnership(
  candidate: PreparedVariable,
  contestedPath: string,
  prepared: PreparedVariable[],
  participantIds: Set<string>,
  excludedIds: Set<string>
): number {
  const segments = contestedPath.split(".");
  const parent = segments.slice(0, -1).join(".");

  let count = 0;
  for (const item of prepared) {
    if (item.collection.id !== candidate.collection.id) continue;
    if (participantIds.has(item.variable.id)) continue;
    if (excludedIds.has(item.variable.id)) continue;
    if (parent === "" || item.normalizedPath === parent || isStrictPathPrefix(parent, item.normalizedPath)) {
      count += 1;
    }
  }
  return count;
}

interface WinnerSelection {
  winner: PreparedVariable;
  winnerRule: WinnerRule;
}

/**
 * Applies Amendment 1 §F's comparator: first criterion to differentiate wins.
 *
 * Each criterion narrows the field to those tied at the best value; if that leaves one
 * candidate, it won by that criterion. Name order always terminates, so a winner is guaranteed.
 */
export function selectWinner(
  group: PreparedVariable[],
  contestedPath: string,
  prepared: PreparedVariable[],
  inboundAliases: Map<string, number>,
  excludedIds: Set<string> = new Set()
): WinnerSelection {
  const ordered = group.slice().sort(compareVariables);
  const participantIds = new Set(ordered.map((item) => item.variable.id));

  const byAliases = bestBy(ordered, (item) => inboundAliases.get(item.variable.id) ?? 0);
  if (byAliases.length === 1) return { winner: byAliases[0], winnerRule: "alias-references" };

  const byNamespace = bestBy(byAliases, (item) =>
    namespaceOwnership(item, contestedPath, prepared, participantIds, excludedIds)
  );
  if (byNamespace.length === 1) return { winner: byNamespace[0], winnerRule: "namespace-majority" };

  return { winner: byNamespace[0], winnerRule: "name-order" };
}

/** The subset of `items` tied at the highest score. Input order is preserved. */
function bestBy<T>(items: T[], score: (item: T) => number): T[] {
  let best = -Infinity;
  for (const item of items) {
    const value = score(item);
    if (value > best) best = value;
  }
  return items.filter((item) => score(item) === best);
}

function participant(prepared: PreparedVariable, outcome: "written" | "skipped"): ReportParticipant {
  return {
    variableId: prepared.variable.id,
    variableName: prepared.variable.name,
    collectionId: prepared.collection.id,
    collectionName: prepared.collection.name,
    outcome,
  };
}

export interface CollisionOutcome {
  /** Variables that survived every check, in name order. */
  survivors: PreparedVariable[];
  /** Variable ids excluded from every mode file of their collection. */
  excludedIds: Set<string>;
  entries: ReportEntry[];
}

/**
 * Runs the collision passes over the whole file at once.
 *
 * Collisions are resolved at *collection* scope, not per mode file: a variable exists in every
 * mode of its collection, so excluding it from one mode file but not another would produce a
 * token that appears and vanishes depending on the active theme. A loser is dropped everywhere.
 *
 * The cross-set check is run globally rather than per generated theme. In the theme case ADR §6
 * generates (one multi-mode collection plus every single-mode collection), every collection is
 * in every theme, so global and per-theme are the same check. In the ambiguous case where no
 * themes are generated, global is the conservative choice — the sets will be merged by *some*
 * composition eventually, and flagging early beats a silent clash at Phase 7.
 */
export function detectCollisions(
  prepared: PreparedVariable[],
  inboundAliases: Map<string, number>
): CollisionOutcome {
  const sorted = prepared.slice().sort(compareVariables);
  const excludedIds = new Set<string>();
  const entries: ReportEntry[] = [];

  // Pass 1 — duplicate normalized paths. Same collection: a case-only name clash. Different
  // collections: a cross-set clash within a theme, which ADR §1 rules is a name clash and not
  // an intentional override, since import never *generates* an override.
  const byPath = new Map<string, PreparedVariable[]>();
  for (const item of sorted) {
    const bucket = byPath.get(item.normalizedPath);
    if (bucket) bucket.push(item);
    else byPath.set(item.normalizedPath, [item]);
  }

  for (const key of Array.from(byPath.keys()).sort(compareKeys)) {
    const group = byPath.get(key) as PreparedVariable[];
    if (group.length < 2) continue;

    const sameCollection = group.every((item) => item.collection.id === group[0].collection.id);
    const { winner, winnerRule } = selectWinner(group, key, sorted, inboundAliases, excludedIds);
    for (const loser of group) {
      if (loser !== winner) excludedIds.add(loser.variable.id);
    }

    entries.push({
      kind: "collision",
      reason: sameCollection ? "same-set-case" : "cross-set",
      message: sameCollection
        ? `${group.length} variables in "${winner.collection.name}" produce the token path "${winner.path}" (names differ only by case). Kept "${winner.variable.name}" (${explain(winnerRule)}); the rest were not written.`
        : `${group.length} variables across ${countCollections(group)} collections produce the token path "${winner.path}", which would clash when their sets are merged into one theme. Kept "${winner.collection.name}" → "${winner.variable.name}" (${explain(winnerRule)}); the rest were not written.`,
      path: winner.path,
      winnerRule,
      participants: group.map((item) => participant(item, item === winner ? "written" : "skipped")),
    });
  }

  // Pass 2 — token/group clashes, on pass-1 survivors only. DTCG cannot represent a node that
  // is both a token and a group, so `color/brand` and `color/brand/primary` cannot coexist.
  const survivorsAfterPass1 = sorted.filter((item) => !excludedIds.has(item.variable.id));
  const uniquePaths = Array.from(new Set(survivorsAfterPass1.map((item) => item.normalizedPath))).sort(
    compareKeys
  );

  const byNormalizedPath = new Map<string, PreparedVariable[]>();
  for (const item of survivorsAfterPass1) {
    const bucket = byNormalizedPath.get(item.normalizedPath);
    if (bucket) bucket.push(item);
    else byNormalizedPath.set(item.normalizedPath, [item]);
  }

  for (const shortPath of uniquePaths) {
    const descendants = uniquePaths.filter((other) => isStrictPathPrefix(shortPath, other));
    if (descendants.length === 0) continue;

    const tokenSide = byNormalizedPath.get(shortPath) ?? [];
    const groupSide: PreparedVariable[] = [];
    for (const descendant of descendants) {
      groupSide.push(...(byNormalizedPath.get(descendant) ?? []));
    }
    const group = tokenSide.concat(groupSide).sort(compareVariables);
    if (group.length < 2) continue;

    // Already-excluded participants can appear here if an ancestor clash was resolved first;
    // skip a group whose contest is entirely settled.
    const live = group.filter((item) => !excludedIds.has(item.variable.id));
    if (live.length < 2) continue;

    const { winner, winnerRule } = selectWinner(live, shortPath, sorted, inboundAliases, excludedIds);
    for (const loser of live) {
      if (loser !== winner) excludedIds.add(loser.variable.id);
    }

    // `uniquePaths` only ever holds token paths, so the token side of the contest is non-empty.
    const contestedPath = tokenSide[0].path;

    entries.push({
      kind: "collision",
      reason: "token-group",
      message: `Token path "${contestedPath}" is also a group prefix of ${live.length - 1} other token${live.length === 2 ? "" : "s"}; DTCG cannot represent a node that is both. Kept "${winner.collection.name}" → "${winner.variable.name}" (${explain(winnerRule)}); the rest were not written.`,
      path: contestedPath,
      winnerRule,
      participants: live.map((item) => participant(item, item === winner ? "written" : "skipped")),
    });
  }

  return {
    survivors: sorted.filter((item) => !excludedIds.has(item.variable.id)),
    excludedIds,
    entries,
  };
}

function explain(rule: WinnerRule): string {
  if (rule === "alias-references") return "most referenced by other variables";
  if (rule === "namespace-majority") return "owns more of the surrounding namespace";
  if (rule === "variable-count") return "has more variables";
  return "no signal to separate them — decided by name order";
}

export { explain as explainWinnerRule };

function countCollections(group: PreparedVariable[]): number {
  const ids = new Set<string>();
  for (const item of group) ids.add(item.collection.id);
  return ids.size;
}
