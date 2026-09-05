// The rule-edit preview — ADR-0002 Amendment 2 §G, §I.
//
// **A rule edit is a mass rename, and it is previewed rather than discovered.** Left alone, editing
// one rule surfaces as ADR-0006 §4 marking most files changed and the diff view showing hundreds of
// deletes and adds — technically correct, unreadable, and the user learns what they did after
// committing it.
//
// So the preview is computed *before* the write, from the same engine the build uses. It is not a
// second model of what rules do: it runs `applyPathRules` twice, over the same source names, and
// diffs. Anything it can be wrong about, the build is wrong about too.
//
// §G also names this as reusable by Phase 11's manual path rename: a manual rename is one
// `PathRemap` entry where a rule edit is many, and the reference-rewriting pass is the same code.

import type { VariableSnapshot } from "./types";
import { applyPathRules, usableRules, validateRules, type PathRule, type RuleIssue } from "./rules";
import { normalizePathKey, splitVariableName } from "./paths";
import { isAlias } from "./values";
import { compareKeys } from "./serialize";

/** One token moving. Ids are stable across the change (§A), which is what makes the diff possible. */
export interface PathRemap {
  variableId: string;
  from: string;
  to: string;
}

export interface PreviewExclusion {
  ruleId: string;
  count: number;
}

/** A reference the edit would strand: `referrer` points at `target`, which is no longer imported. */
export interface PreviewDangle {
  referrerId: string;
  referrerPath: string;
  targetId: string;
  targetPath: string;
  ruleId: string;
}

export interface RulePreview {
  /** Tokens whose path changes. Sorted by `from`, so the list reads as a rename list. */
  remaps: PathRemap[];
  /** How many references are rewritten as a consequence (§D) — both ends move together. */
  referencesRewritten: number;
  /** Variables the new rules drop from import, aggregated per rule (§I). */
  excluded: PreviewExclusion[];
  /** Variables the old rules dropped and the new ones do not. */
  restored: number;
  /**
   * References left dangling by an exclusion — the number that has to be visible **before** the
   * write, because afterwards those variables are simply absent and the mistake is invisible (§I).
   */
  dangling: PreviewDangle[];
  /** Paths the new rules make contested that the old ones did not. Reported, never blocking (§C). */
  newCollisions: string[];
  /** Variables for which a rule produced an unusable path, so it was not applied to them (§C). */
  invalid: Array<{ variableId: string; ruleId: string; reason: string }>;
  /** Problems with the rules themselves — an uncompilable regex, a duplicate id. */
  issues: RuleIssue[];
}

/**
 * What saving `next` would do, against the rule set currently in force.
 *
 * Deliberately takes the raw `VariableSnapshot[]` rather than a built tree: the preview has to run
 * on every keystroke in the rules editor, and rebuilding the whole token tree per keystroke is the
 * cost §G's preview exists to avoid inflicting.
 */
export function previewRuleChange(
  variables: VariableSnapshot[],
  current: PathRule[],
  next: PathRule[]
): RulePreview {
  const before = derive(variables, current);
  const after = derive(variables, next);

  const remaps: PathRemap[] = [];
  for (const variable of variables) {
    const from = before.paths.get(variable.id);
    const to = after.paths.get(variable.id);
    // A variable that is excluded on either side is an exclusion or a restoration, not a rename;
    // counting it as both would double every line of the summary.
    if (from === undefined || to === undefined) continue;
    if (from !== to) remaps.push({ variableId: variable.id, from, to });
  }
  remaps.sort((a, b) => compareKeys(a.from, b.from) || compareKeys(a.variableId, b.variableId));

  const moved = new Set(remaps.map((remap) => remap.variableId));
  let referencesRewritten = 0;
  const dangling: PreviewDangle[] = [];

  for (const variable of variables) {
    if (after.excluded.has(variable.id)) continue;
    for (const targetId of aliasTargets(variable)) {
      if (moved.has(targetId)) referencesRewritten += 1;

      const ruleId = after.excluded.get(targetId);
      if (ruleId !== undefined && !before.excluded.has(targetId)) {
        dangling.push({
          referrerId: variable.id,
          referrerPath: after.paths.get(variable.id) ?? variable.name,
          targetId,
          targetPath: before.paths.get(targetId) ?? targetId,
          ruleId,
        });
      }
    }
  }

  const excluded: PreviewExclusion[] = [];
  const counts = new Map<string, number>();
  for (const id of Array.from(after.excluded.keys())) {
    const ruleId = after.excluded.get(id) as string;
    counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
  }
  for (const ruleId of Array.from(counts.keys()).sort(compareKeys)) {
    excluded.push({ ruleId, count: counts.get(ruleId) as number });
  }

  let restored = 0;
  for (const id of Array.from(before.excluded.keys())) {
    if (!after.excluded.has(id)) restored += 1;
  }

  return {
    remaps,
    referencesRewritten,
    excluded,
    restored,
    dangling,
    newCollisions: newCollisions(before, after),
    invalid: Array.from(after.invalid.keys())
      .sort(compareKeys)
      .map((variableId) => ({
        variableId,
        ruleId: (after.invalid.get(variableId) as { ruleId: string }).ruleId,
        reason: (after.invalid.get(variableId) as { reason: string }).reason,
      })),
    issues: validateRules(next),
  };
}

interface Derived {
  /** Variable id → dotted path. Absent for an excluded variable. */
  paths: Map<string, string>;
  excluded: Map<string, string>;
  invalid: Map<string, { ruleId: string; reason: string }>;
}

function derive(variables: VariableSnapshot[], configured: PathRule[]): Derived {
  const rules = usableRules(configured);
  const paths = new Map<string, string>();
  const excluded = new Map<string, string>();
  const invalid = new Map<string, { ruleId: string; reason: string }>();

  for (const variable of variables) {
    const outcome = applyPathRules(variable.name, rules);
    if (outcome.kind === "excluded") {
      excluded.set(variable.id, outcome.ruleId);
      continue;
    }
    if (outcome.kind === "invalid") invalid.set(variable.id, { ruleId: outcome.ruleId, reason: outcome.reason });
    paths.set(variable.id, splitVariableName(outcome.name).join("."));
  }

  return { paths, excluded, invalid };
}

function aliasTargets(variable: VariableSnapshot): string[] {
  const targets = new Set<string>();
  for (const modeId of Object.keys(variable.valuesByMode)) {
    const value = variable.valuesByMode[modeId];
    if (isAlias(value) && value.id !== variable.id) targets.add(value.id);
  }
  return Array.from(targets);
}

/**
 * Paths the new rules make contested that the old ones did not.
 *
 * Deliberately a *count of contested paths*, not a full collision resolution: the winner comparator
 * needs the built tree, and §G's preview is a warning that the edit creates clashes, not a
 * prediction of who survives them. It can still be saved with collisions present — a second rule
 * may be the fix — so this is information, never a block.
 */
function newCollisions(before: Derived, after: Derived): string[] {
  const contested = (derived: Derived): Set<string> => {
    const byPath = new Map<string, number>();
    for (const id of Array.from(derived.paths.keys())) {
      const key = normalizePathKey(derived.paths.get(id) as string);
      byPath.set(key, (byPath.get(key) ?? 0) + 1);
    }
    const out = new Set<string>();
    for (const key of Array.from(byPath.keys())) {
      if ((byPath.get(key) as number) > 1) out.add(key);
    }
    return out;
  };

  const was = contested(before);
  return Array.from(contested(after))
    .filter((path) => !was.has(path))
    .sort(compareKeys);
}
