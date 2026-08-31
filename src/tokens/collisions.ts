// Collision detection and deterministic first-wins resolution — ADR-0002 §5.
//
// Three kinds, all handled the same way: every participant (winner included) is recorded in the
// report with its variable id and the contested path; losers are neither written nor renamed.
// The fix is a rename in Figma.

import type { CollectionSnapshot, ReportEntry, ReportParticipant, VariableSnapshot } from "./types";
import { compareKeys } from "./serialize";
import { isStrictPathPrefix } from "./paths";

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
 * ADR §5's resolution order: "first wins, sorted by collection name then variable name".
 * Variable id breaks a remaining tie so the ordering is total and the output is reproducible
 * even in the pathological case of two identically named variables in one collection.
 */
export function compareVariables(a: PreparedVariable, b: PreparedVariable): number {
  const byCollection = compareKeys(a.collection.name, b.collection.name);
  if (byCollection !== 0) return byCollection;
  const byName = compareKeys(a.variable.name, b.variable.name);
  if (byName !== 0) return byName;
  return compareKeys(a.variable.id, b.variable.id);
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
  /** Variables that survived every check, in resolution order. */
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
export function detectCollisions(prepared: PreparedVariable[]): CollisionOutcome {
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
    const winner = group[0];
    for (const loser of group.slice(1)) excludedIds.add(loser.variable.id);

    entries.push({
      kind: "collision",
      reason: sameCollection ? "same-set-case" : "cross-set",
      message: sameCollection
        ? `${group.length} variables in "${winner.collection.name}" produce the token path "${winner.path}" (names differ only by case). Kept "${winner.variable.name}"; the rest were not written.`
        : `${group.length} variables across ${countCollections(group)} collections produce the token path "${winner.path}", which would clash when their sets are merged into one theme. Kept "${winner.collection.name}" → "${winner.variable.name}"; the rest were not written.`,
      path: winner.path,
      participants: group.map((item) => participant(item, item === winner ? "written" : "skipped")),
    });
  }

  // Pass 2 — token/group clashes, on pass-1 survivors only. DTCG cannot represent a node that
  // is both a token and a group, so `color/brand` and `color/brand/primary` cannot coexist.
  const survivorsAfterPass1 = sorted.filter((item) => !excludedIds.has(item.variable.id));
  const pathsInOrder = survivorsAfterPass1.map((item) => item.normalizedPath);
  const uniquePaths = Array.from(new Set(pathsInOrder)).sort(compareKeys);

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

    const winner = live[0];
    for (const loser of live.slice(1)) excludedIds.add(loser.variable.id);

    // `uniquePaths` only ever holds token paths, so the token side of the contest is non-empty.
    const contestedPath = tokenSide[0].path;

    entries.push({
      kind: "collision",
      reason: "token-group",
      message: `Token path "${contestedPath}" is also a group prefix of ${live.length - 1} other token${live.length === 2 ? "" : "s"}; DTCG cannot represent a node that is both. Kept "${winner.collection.name}" → "${winner.variable.name}"; the rest were not written.`,
      path: contestedPath,
      participants: live.map((item) => participant(item, item === winner ? "written" : "skipped")),
    });
  }

  return {
    survivors: sorted.filter((item) => !excludedIds.has(item.variable.id)),
    excludedIds,
    entries,
  };
}

function countCollections(group: PreparedVariable[]): number {
  const ids = new Set<string>();
  for (const item of group) ids.add(item.collection.id);
  return ids.size;
}
