// Drift detection — ADR-0005 §7, §8.
//
// Pure. Compares a fresh tree against a baseline tree and reports what Figma changed underneath
// the plugin. Two things about it are worth stating plainly, because both are easy to over-read.
//
// **Drift is not a third source.** It is the *imported* side moving — the observation that Figma
// changed since the plugin last looked. The overlay stays a two-sided merge; this makes the second
// side's movement visible for the ~99% of tokens that carry no edit. A token that *does* carry one
// is not compared here at all: ADR-0004 §4's three-way merge already detects Figma-side movement
// for it and reports `edit-conflict`. One mechanism, widened — not two that can disagree about what
// "changed" means.
//
// **In Phase 5 the baseline is the import cache, so this is a changelog against a local watermark,
// not divergence from a source of truth** (§8). With no git sync, the token JSON is re-derived from
// Figma on every scan, so "the token file disagrees with Figma" is not a state an unedited token
// can be in. What this detects is the delta between two scans, which genuinely answers *"what did
// someone change in this file since I last looked?"* and nothing more. Phase 6 swaps the baseline
// for the pulled git tree and the comparator is unchanged.
//
// The corollary matters more than the limitation: **a missing baseline is `unknown`, not `none`.**
// The cache is evictable by design (ADR-0004 §6), and a "no drift detected" that actually meant
// "no baseline" would be the worst possible lie for this feature to tell.

import type { ReportEntry, TokenValue } from "./types";
import type { FlatToken } from "./view";
import { tokenKey, valuesEqual } from "./overlay";
import { describeValue } from "./format";

export type DriftKind = "drift-value" | "drift-added" | "drift-removed";

export interface DriftEntry {
  kind: DriftKind;
  /** ADR-0004's target key, so a drift and an overlay entry are keyed identically. */
  key: string;
  path: string;
  set: string;
  /** `value-changed` or `description-changed`; absent on added/removed. */
  reason?: string;
  baseline?: TokenValue;
  current?: TokenValue;
}

export interface DriftResult {
  entries: DriftEntry[];
  /** Report rows for the existing `ImportReport`, so drift rides the `⚑` badge (UX §6.2). */
  report: ReportEntry[];
  /** Target keys carrying drift — what the tree badges, without a second lookup per row. */
  keys: Set<string>;
}

export function emptyDrift(): DriftResult {
  return { entries: [], report: [], keys: new Set() };
}

/**
 * Fresh scan vs. baseline scan, for every token with no overlay entry.
 *
 * `edited` is the set of target keys the overlay already covers. They are excluded rather than
 * reported twice: a token with a local edit whose Figma value also moved is a **conflict**, and
 * `mergeOverlay` has already said so. Reporting it here as well would put two badges with two
 * different vocabularies on one value line.
 */
export function detectDrift(
  baseline: FlatToken[],
  fresh: FlatToken[],
  edited: Set<string>
): DriftResult {
  const before = index(baseline);
  const after = index(fresh);

  const entries: DriftEntry[] = [];

  for (const [key, current] of after) {
    if (edited.has(key)) continue;
    const previous = before.get(key);

    if (previous === undefined) {
      entries.push({
        kind: "drift-added",
        key,
        path: current.path,
        set: current.setId,
        current: current.token.$value,
      });
      continue;
    }

    if (!valuesEqual(previous.token.$value, current.token.$value)) {
      entries.push({
        kind: "drift-value",
        key,
        path: current.path,
        set: current.setId,
        reason: "value-changed",
        baseline: previous.token.$value,
        current: current.token.$value,
      });
      continue;
    }

    // Descriptions are editable in the panel and therefore drift the same way values do. Kept as a
    // separate `reason` on the same kind rather than a fourth kind: the user-facing question
    // ("what changed in Figma?") is one question, and UX §6.2 tells the kinds apart by one
    // lowercase word next to the flag, which a fourth entry kind would have to compete for.
    const wasDescription = previous.token.$description ?? "";
    const nowDescription = current.token.$description ?? "";
    if (wasDescription !== nowDescription) {
      entries.push({
        kind: "drift-value",
        key,
        path: current.path,
        set: current.setId,
        reason: "description-changed",
        baseline: wasDescription,
        current: nowDescription,
      });
    }
  }

  for (const [key, previous] of before) {
    if (edited.has(key)) continue;
    if (after.has(key)) continue;
    entries.push({
      kind: "drift-removed",
      key,
      path: previous.path,
      set: previous.setId,
      baseline: previous.token.$value,
    });
  }

  // Deterministic order, matching the report's own convention (ADR-0002 §7): a drift list that
  // reordered itself between two identical scans would show up as noise in every diff of it.
  entries.sort((a, b) => a.path.localeCompare(b.path) || a.set.localeCompare(b.set));

  return {
    entries,
    report: entries.map(toReportEntry),
    keys: new Set(entries.map((entry) => entry.key)),
  };
}

function index(flat: FlatToken[]): Map<string, FlatToken> {
  const map = new Map<string, FlatToken>();
  for (const entry of flat) {
    const key = tokenKey(entry.token);
    if (key !== null && !map.has(key)) map.set(key, entry);
  }
  return map;
}

/**
 * The user-facing sentence.
 *
 * Never the word "drift" (UX §3): a designer does not think "this token has drifted", they think
 * "someone changed it in Figma". `drift` stays in code, ADRs and the report's `kind` slug; every
 * sentence a person reads says *changed in Figma*.
 */
function toReportEntry(entry: DriftEntry): ReportEntry {
  if (entry.kind === "drift-added") {
    return {
      kind: "drift-added",
      reason: "added-in-figma",
      message: `"${entry.path}" (${entry.set}) is new in Figma since your last scan.`,
      path: entry.path,
      set: entry.set,
    };
  }
  if (entry.kind === "drift-removed") {
    return {
      kind: "drift-removed",
      reason: "removed-in-figma",
      message: `"${entry.path}" (${entry.set}) was in Figma at your last scan and isn't any more.`,
      path: entry.path,
      set: entry.set,
    };
  }
  const what = entry.reason === "description-changed" ? "description" : "value";
  return {
    kind: "drift-value",
    reason: entry.reason ?? "value-changed",
    message: `Someone changed the ${what} of "${entry.path}" (${entry.set}) in Figma after your last scan. It was ${describe(entry.baseline)}; it's now ${describe(entry.current)}.`,
    path: entry.path,
    set: entry.set,
  };
}

/** Prose, so an absent value reads as "it was unset" rather than as a dash mid-sentence. */
function describe(value: TokenValue | undefined): string {
  return describeValue(value, { unset: "unset" });
}
