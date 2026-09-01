// Collision detection and winner selection — ADR-0002 §5, as amended by Amendment 1 §E and §F,
// and generalised to Styles by ADR-0003 §5.
//
// Four kinds, all handled the same way: every participant (winner included) is recorded in the
// report with its id and the contested path; losers are neither written nor renamed. The fix is
// a rename in Figma.
//
// The ordering cannot make the *right* choice — only a rename can. What it can do is pick the
// loser whose removal breaks least, and say which criterion decided (Amendment 1 §F).
//
// ADR-0003 lifted the pass from "over prepared variables" to "over prepared token candidates":
// the core below works on a source-agnostic `CollisionItem`, so all four kinds apply unchanged
// to style tokens, both among themselves and against Variables tokens. `detectCollisions` is the
// Variables-shaped wrapper Phase 2 calls; `detectItemCollisions` is what merge.ts calls with the
// union of both sources. The rules themselves did not change.

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

export type CandidateSource = "variable" | "style";

/**
 * One token candidate in a contest, independent of where it came from (ADR-0003 §5).
 *
 * `container` is whatever owns the candidate's namespace: a collection for a Variable, the
 * synthetic set for a style token. It is what the namespace-majority criterion counts over.
 */
export interface CollisionItem {
  /** Unique within one pass. Exclusions are keyed by it. */
  key: string;
  source: CandidateSource;
  /** Figma id — a variable id or a style id. */
  id: string;
  /** `/`-delimited Figma name. */
  name: string;
  containerId: string;
  containerName: string;
  path: string;
  normalizedPath: string;
  /**
   * How many other things reference this candidate. Always 0 for style tokens — nothing can
   * alias a style token, which is half of why cross-source contests need their own rule.
   */
  inboundAliases: number;
}

/**
 * The final, total tiebreak: container name, then name, then id.
 *
 * This is criterion 3 of Amendment 1 §F, and on its own it is also the sort that makes the whole
 * output reproducible regardless of the order Figma hands things back.
 */
export function compareItems(a: CollisionItem, b: CollisionItem): number {
  return (
    compareKeys(a.containerName, b.containerName) ||
    compareKeys(a.name, b.name) ||
    compareKeys(a.id, b.id)
  );
}

export function compareVariables(a: PreparedVariable, b: PreparedVariable): number {
  return compareItems(itemOfVariable(a, 0), itemOfVariable(b, 0));
}

/**
 * How many distinct variables in the file alias each variable, in any mode.
 *
 * This is criterion 1's signal: dropping a referenced token cascades into every referrer, so the
 * most-referenced participant is the one whose removal does the most damage.
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
 * Criterion 2: how much of the contested path's surrounding namespace this candidate's container
 * already owns.
 *
 * Only *surviving* candidates count. One already dropped by an earlier pass is not going to be
 * written, so letting it pad its container's tally would let a phantom token decide a later
 * token/group contest — and could hand the win to the container with less real presence in the
 * namespace. Participants in the contest itself are excluded too: they are what is being decided.
 */
function namespaceOwnership(
  candidate: CollisionItem,
  contestedPath: string,
  items: CollisionItem[],
  participantKeys: Set<string>,
  excludedKeys: Set<string>
): number {
  const segments = contestedPath.split(".");
  const parent = segments.slice(0, -1).join(".");

  let count = 0;
  for (const item of items) {
    if (item.containerId !== candidate.containerId) continue;
    if (participantKeys.has(item.key)) continue;
    if (excludedKeys.has(item.key)) continue;
    if (parent === "" || item.normalizedPath === parent || isStrictPathPrefix(parent, item.normalizedPath)) {
      count += 1;
    }
  }
  return count;
}

interface WinnerSelection {
  winner: CollisionItem;
  winnerRule: WinnerRule;
}

/**
 * Picks a winner: source precedence first (ADR-0003 §5), then Amendment 1 §F's comparator.
 *
 * §F's comparator is skipped for a mixed-source contest because both of its real criteria are
 * undefined for style tokens — a style token has no inbound aliases and no collection namespace
 * to own — so it would silently degrade to alphabetical order, which §F itself argues has no
 * relationship to correctness. The Variables-derived token wins instead, unconditionally: a
 * Variable can be an alias target and a style cannot, so dropping the Variable can cascade
 * through the file where dropping the style token cannot.
 *
 * Within one source the comparator is unchanged. Among two style tokens it degrades to name
 * order, which is honest — there is no better signal available.
 */
export function selectWinner(
  group: CollisionItem[],
  contestedPath: string,
  items: CollisionItem[],
  excludedKeys: Set<string> = new Set()
): WinnerSelection {
  const ordered = group.slice().sort(compareItems);
  const participantKeys = new Set(ordered.map((item) => item.key));

  const variables = ordered.filter((item) => item.source === "variable");
  const mixed = variables.length > 0 && variables.length < ordered.length;
  if (mixed && variables.length === 1) {
    return { winner: variables[0], winnerRule: "source-precedence" };
  }
  // A mixed contest with several Variables still eliminates every style token by precedence; the
  // remaining question is which Variable, which is a same-source contest and back to §F.
  const field = mixed ? variables : ordered;

  const byAliases = bestBy(field, (item) => item.inboundAliases);
  if (byAliases.length === 1) return { winner: byAliases[0], winnerRule: "alias-references" };

  const byNamespace = bestBy(byAliases, (item) =>
    namespaceOwnership(item, contestedPath, items, participantKeys, excludedKeys)
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

export function participantOfItem(
  item: CollisionItem,
  outcome: "written" | "skipped"
): ReportParticipant {
  if (item.source === "style") {
    return {
      variableId: "",
      variableName: "",
      collectionId: "",
      collectionName: "",
      styleId: item.id,
      styleName: item.name,
      outcome,
    };
  }
  return {
    variableId: item.id,
    variableName: item.name,
    collectionId: item.containerId,
    collectionName: item.containerName,
    outcome,
  };
}

export interface ItemCollisionOutcome {
  /** Candidates that survived every check, in name order. */
  survivors: CollisionItem[];
  /** Keys excluded from the output. */
  excludedKeys: Set<string>;
  entries: ReportEntry[];
}

export interface CollisionOutcome {
  /** Variables that survived every check, in name order. */
  survivors: PreparedVariable[];
  /** Variable ids excluded from every mode file of their collection. */
  excludedIds: Set<string>;
  entries: ReportEntry[];
}

/**
 * Runs the collision passes over a whole candidate set at once.
 *
 * Collisions are resolved at *container* scope, not per output file: a variable exists in every
 * mode of its collection, so excluding it from one mode file but not another would produce a
 * token that appears and vanishes depending on the active theme. A loser is dropped everywhere.
 *
 * The cross-set check is run globally rather than per generated theme. In the theme case ADR-0002
 * §6 generates, every collection is in every theme, so global and per-theme are the same check —
 * and style sets are in every theme by construction (ADR-0003 §1). In the ambiguous case where no
 * themes are generated, global is the conservative choice: the sets will be merged by *some*
 * composition eventually, and flagging early beats a silent clash at Phase 7.
 */
export function detectItemCollisions(items: CollisionItem[]): ItemCollisionOutcome {
  const sorted = items.slice().sort(compareItems);
  const excludedKeys = new Set<string>();
  const entries: ReportEntry[] = [];

  // Pass 1 — duplicate normalized paths. Same container: a case-only name clash. Different
  // containers: a clash within a theme, which ADR-0002 §1 rules is a name clash and not an
  // intentional override, since import never *generates* an override.
  const byPath = new Map<string, CollisionItem[]>();
  for (const item of sorted) {
    const bucket = byPath.get(item.normalizedPath);
    if (bucket) bucket.push(item);
    else byPath.set(item.normalizedPath, [item]);
  }

  for (const key of Array.from(byPath.keys()).sort(compareKeys)) {
    const group = byPath.get(key) as CollisionItem[];
    if (group.length < 2) continue;

    const sameContainer = group.every((item) => item.containerId === group[0].containerId);
    const { winner, winnerRule } = selectWinner(group, key, sorted, excludedKeys);
    for (const loser of group) {
      if (loser !== winner) excludedKeys.add(loser.key);
    }

    const words = nouns(group);
    entries.push({
      kind: "collision",
      reason: sameContainer ? "same-set-case" : "cross-set",
      message: sameContainer
        ? `${group.length} ${words.item} in "${winner.containerName}" produce the token path "${winner.path}" (names differ only by case). Kept "${winner.name}" (${explain(winnerRule)}); the rest were not written.`
        : `${group.length} ${words.item} across ${countContainers(group)} ${words.container} produce the token path "${winner.path}", which would clash when their sets are merged into one theme. Kept "${winner.containerName}" → "${winner.name}" (${explain(winnerRule)}); the rest were not written.`,
      path: winner.path,
      winnerRule,
      participants: group.map((item) => participantOfItem(item, item === winner ? "written" : "skipped")),
    });
  }

  // Pass 2 — token/group clashes, on pass-1 survivors only. DTCG cannot represent a node that is
  // both a token and a group, so `color/brand` and `color/brand/primary` cannot coexist.
  const survivorsAfterPass1 = sorted.filter((item) => !excludedKeys.has(item.key));
  const uniquePaths = Array.from(new Set(survivorsAfterPass1.map((item) => item.normalizedPath))).sort(
    compareKeys
  );

  const byNormalizedPath = new Map<string, CollisionItem[]>();
  for (const item of survivorsAfterPass1) {
    const bucket = byNormalizedPath.get(item.normalizedPath);
    if (bucket) bucket.push(item);
    else byNormalizedPath.set(item.normalizedPath, [item]);
  }

  for (const shortPath of uniquePaths) {
    const descendants = uniquePaths.filter((other) => isStrictPathPrefix(shortPath, other));
    if (descendants.length === 0) continue;

    const tokenSide = byNormalizedPath.get(shortPath) ?? [];
    const groupSide: CollisionItem[] = [];
    for (const descendant of descendants) {
      groupSide.push(...(byNormalizedPath.get(descendant) ?? []));
    }
    const group = tokenSide.concat(groupSide).sort(compareItems);
    if (group.length < 2) continue;

    // Already-excluded participants can appear here if an ancestor clash was resolved first;
    // skip a group whose contest is entirely settled.
    const live = group.filter((item) => !excludedKeys.has(item.key));
    if (live.length < 2) continue;

    const { winner, winnerRule } = selectWinner(live, shortPath, sorted, excludedKeys);
    for (const loser of live) {
      if (loser !== winner) excludedKeys.add(loser.key);
    }

    // `uniquePaths` only ever holds token paths, so the token side of the contest is non-empty.
    const contestedPath = tokenSide[0].path;

    entries.push({
      kind: "collision",
      reason: "token-group",
      message: `Token path "${contestedPath}" is also a group prefix of ${live.length - 1} other token${live.length === 2 ? "" : "s"}; DTCG cannot represent a node that is both. Kept "${winner.containerName}" → "${winner.name}" (${explain(winnerRule)}); the rest were not written.`,
      path: contestedPath,
      winnerRule,
      participants: live.map((item) => participantOfItem(item, item === winner ? "written" : "skipped")),
    });
  }

  return {
    survivors: sorted.filter((item) => !excludedKeys.has(item.key)),
    excludedKeys,
    entries,
  };
}

/**
 * The Variables-shaped entry point (ADR-0002 §5), unchanged in behaviour.
 *
 * Kept as a wrapper rather than folded into callers so `build.ts` stays exactly as Phase 2 left
 * it: ADR-0003 §7 pins that file as unchanged, and its report strings are covered byte for byte
 * by the committed fixture.
 */
export function detectCollisions(
  prepared: PreparedVariable[],
  inboundAliases: Map<string, number>
): CollisionOutcome {
  const byKey = new Map<string, PreparedVariable>();
  const items: CollisionItem[] = [];

  for (const item of prepared) {
    const converted = itemOfVariable(item, inboundAliases.get(item.variable.id) ?? 0);
    byKey.set(converted.key, item);
    items.push(converted);
  }

  const outcome = detectItemCollisions(items);

  return {
    survivors: outcome.survivors.map((item) => byKey.get(item.key) as PreparedVariable),
    excludedIds: new Set(Array.from(outcome.excludedKeys)),
    entries: outcome.entries,
  };
}

export function itemOfVariable(prepared: PreparedVariable, inboundAliases: number): CollisionItem {
  return {
    // The variable id is already unique within a file, and `excludedIds` is documented in terms
    // of variable ids, so key and id coincide on this side.
    key: prepared.variable.id,
    source: "variable",
    id: prepared.variable.id,
    name: prepared.variable.name,
    containerId: prepared.collection.id,
    containerName: prepared.collection.name,
    path: prepared.path,
    normalizedPath: prepared.normalizedPath,
    inboundAliases,
  };
}

/**
 * What to call the participants in a message.
 *
 * A single-source contest is named for what it actually contains, which keeps every Phase 2
 * message byte-identical. A mixed one falls back to "tokens" across "sources", because calling
 * a paint style a variable would be wrong and "variables and styles across collections and style
 * sets" reads like a bug report.
 */
function nouns(group: CollisionItem[]): { item: string; container: string } {
  const hasVariable = group.some((item) => item.source === "variable");
  const hasStyle = group.some((item) => item.source === "style");
  if (hasVariable && !hasStyle) return { item: "variables", container: "collections" };
  if (hasStyle && !hasVariable) return { item: "styles", container: "style sets" };
  return { item: "tokens", container: "sources" };
}

function explain(rule: WinnerRule): string {
  if (rule === "alias-references") return "most referenced by other variables";
  if (rule === "namespace-majority") return "owns more of the surrounding namespace";
  if (rule === "variable-count") return "has more variables";
  if (rule === "source-precedence") return "a Variable outranks a Style at the same path";
  return "no signal to separate them — decided by name order";
}

export { explain as explainWinnerRule };

function countContainers(group: CollisionItem[]): number {
  const ids = new Set<string>();
  for (const item of group) ids.add(item.containerId);
  return ids.size;
}
