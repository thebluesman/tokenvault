// The subtype confirmation queue, grouped by the guess — UX `onboarding-polish.md` §5.
//
// Pure view-model, as §11 requires: the guess is already on every `SubtypeCandidate`, so grouping
// is a render-time concern and nothing about the payload changes to support it.
//
// The axis is the **guessed subtype**, because that is the axis the decision is made on. A user
// scans ninety names and asks one question — *are these all spacing?* — and answers it once.
// Collection was the other candidate and is worse: a collection mixes subtypes, so a per-collection
// bulk action is never the answer to a single question.

import type { SubtypeCandidate, SubtypeSelection } from "./types";

/**
 * How many rows a bulk write may touch before it has to be confirmed — §5.2, §10 Q1.
 *
 * Twenty, as recommended: roughly "more rows than fit on screen", past which the user cannot see
 * what they are about to change. Ten would be safer and noisier; fifty would leave a 45-row write
 * unguarded.
 */
export const BULK_CONFIRM_THRESHOLD = 20;

/** Whether a write of this size gets `git-sync.md` §10.4's inline confirm strip. */
export function needsConfirmStrip(count: number): boolean {
  return count > BULK_CONFIRM_THRESHOLD;
}

/**
 * The group key for a candidate with no guess at all — its own group, and never confirmable.
 *
 * Underscored so it can never collide with a real subtype name, which is what makes `key` safe to
 * cast back to a `SubtypeSelection` for every other group.
 */
export const NO_GUESS = "__no-guess";

export interface SubtypeGroup {
  /** Stable identity for expansion state — the subtype itself, or `NO_GUESS`. */
  key: string;
  /** `spacing · 90`, as drawn in §5.3. */
  label: string;
  /** Absent for the `no guess` group. */
  subtype?: SubtypeSelection;
  candidates: SubtypeCandidate[];
  /**
   * Whether `[ Confirm N ]` is offered.
   *
   * False for `no guess`: there is nothing to confirm, so it gets the set-all control only, and it
   * sorts last because it is the group that genuinely needs reading.
   */
  confirmable: boolean;
}

/**
 * Groups a candidate list by its guess.
 *
 * Largest group first — both the biggest win and the likeliest to be a uniform, correct guess. Ties
 * break alphabetically so the order is stable across renders rather than following insertion. The
 * `no guess` group is always last whatever its size.
 */
export function groupCandidates(candidates: SubtypeCandidate[]): SubtypeGroup[] {
  const byKey = new Map<string, SubtypeCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.subtype ?? NO_GUESS;
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const groups: SubtypeGroup[] = [];
  for (const [key, members] of byKey) {
    const guessed = key !== NO_GUESS;
    groups.push({
      key,
      label: `${guessed ? key : "no guess"} · ${members.length}`,
      subtype: guessed ? (key as SubtypeSelection) : undefined,
      candidates: members,
      confirmable: guessed,
    });
  }

  groups.sort((a, b) => {
    if (a.key === NO_GUESS) return b.key === NO_GUESS ? 0 : 1;
    if (b.key === NO_GUESS) return -1;
    if (a.candidates.length !== b.candidates.length) return b.candidates.length - a.candidates.length;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return groups;
}

/**
 * The `set-subtypes` map behind `[ Confirm N ]` — each candidate stamped with its own guess.
 *
 * Two candidates are skipped, and the count on the button is this map's size so the number and the
 * write can never disagree:
 *
 * - **No guess.** There is nothing to confirm.
 * - **Already confirmed.** A candidate the user has answered for is not part of "confirm the
 *   guesses". Re-stamping it writes the same value, so the old behaviour was harmless, but a group
 *   of 30 confirmed and 60 guessed rows offered `Confirm 90` — a number describing nothing the
 *   click would change.
 */
export function confirmMap(candidates: SubtypeCandidate[]): Record<string, SubtypeSelection | null> {
  const updates: Record<string, SubtypeSelection | null> = {};
  for (const candidate of candidates) {
    if (candidate.subtype !== undefined && candidate.needsConfirmation) {
      updates[candidate.variableId] = candidate.subtype;
    }
  }
  return updates;
}

/** Which group opens on load — the largest, so opening one shows the shape without rebuilding the wall. */
export function defaultOpenGroup(groups: SubtypeGroup[]): string | null {
  const first = groups.find((group) => group.confirmable) ?? groups[0];
  return first === undefined ? null : first.key;
}

/**
 * The inverse of a `set-subtypes` map — §11's build note, implemented rather than snapshotted.
 *
 * `userSubtypes` is not captured wholesale: the undo restores exactly the ids the outgoing map
 * touched, and `null` means "there was no user choice here, hand it back to auto-detection", which
 * is precisely what the sandbox's handler already does with a `null`.
 */
export function previousSelections(
  candidates: SubtypeCandidate[],
  ids: string[]
): Record<string, SubtypeSelection | null> {
  const byId = new Map<string, SubtypeCandidate>();
  for (const candidate of candidates) byId.set(candidate.variableId, candidate);

  const out: Record<string, SubtypeSelection | null> = {};
  for (const id of ids) {
    const candidate = byId.get(id);
    if (candidate === undefined) continue;
    // Only a `user` source is a choice worth restoring. A guess or an auto-detection is not stored
    // in `userSubtypes` at all, so its inverse is the absence of an entry.
    out[id] =
      candidate.subtypeSource === "user" ? (candidate.subtype ?? "untagged") : null;
  }
  return out;
}

/** `132 set to spacing.` / `132 confirmed.` — the toast's own sentence (§5.2). */
export function bulkUndoMessage(count: number, subtype: SubtypeSelection | null): string {
  const plural = count === 1 ? "" : "s";
  if (subtype === null) return `${count} type${plural} confirmed.`;
  return `${count} set to ${subtype}.`;
}
