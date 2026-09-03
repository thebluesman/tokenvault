// One file's token-level diff — UX §7.2's nested rows and §9.2's Compare screen.
//
// The commit's unit is a **file**, because that is the unit git has (ADR-0006 §5). The user's unit
// is a **token**. UX §3 refuses to resolve that tension by picking one: the Repo tab is file-shaped
// at the top level, and this module supplies the token rows that nest inside each file — the same
// `{ path, before, after, state }` shape Phase 5's row component already renders (UX §14).
//
// Pure, and comparing parsed trees rather than text: a textual diff of two `stableStringify`
// outputs would be a diff of a serialization, which is a thing no designer has ever wanted to read.

import type { Manifest, Token, TokenGroup, TokenValue } from "../tokens/types";
import { isToken } from "../tokens/paths";
import { compareKeys } from "../tokens/serialize";

export type FileRowState = "changed" | "added" | "removed";

/** One row of a file's diff, in the shape the apply dialog's row component already takes. */
export interface FileDiffRow {
  path: string;
  state: FileRowState;
  before?: TokenValue;
  after?: TokenValue;
  /** Set when the change is to `$description` rather than to `$value`. */
  description?: boolean;
}

export interface FileDiff {
  rows: FileDiffRow[];
  changed: number;
  added: number;
  removed: number;
}

/** Every token in a tree, by dotted path. Sorted so two runs over one tree agree (ADR-0002 §7). */
export function flattenTree(group: TokenGroup | null): Map<string, Token> {
  const out = new Map<string, Token>();
  if (group === null) return out;
  walk(group, [], out);
  return out;
}

function walk(group: TokenGroup, segments: string[], into: Map<string, Token>): void {
  for (const key of Object.keys(group).sort(compareKeys)) {
    const child = group[key];
    if (child === null || typeof child !== "object") continue;
    const next = segments.concat([key]);
    if (isToken(child)) into.set(next.join("."), child);
    else walk(child as TokenGroup, next, into);
  }
}

/**
 * `before → after` for one file.
 *
 * `before` is the repo's version and `after` is ours on the Review & push screen; the Compare
 * screen passes the same two the same way round and relabels the columns. One comparator, because
 * a second one is how *repo* and *here* end up meaning different things on two screens.
 */
export function diffTrees(before: TokenGroup | null, after: TokenGroup | null): FileDiff {
  const left = flattenTree(before);
  const right = flattenTree(after);

  const paths = new Set<string>();
  for (const path of left.keys()) paths.add(path);
  for (const path of right.keys()) paths.add(path);

  const rows: FileDiffRow[] = [];
  for (const path of Array.from(paths).sort(compareKeys)) {
    const a = left.get(path);
    const b = right.get(path);

    if (a === undefined && b !== undefined) {
      rows.push({ path, state: "added", after: b.$value });
      continue;
    }
    if (a !== undefined && b === undefined) {
      rows.push({ path, state: "removed", before: a.$value });
      continue;
    }
    if (a === undefined || b === undefined) continue;

    if (JSON.stringify(a.$value) !== JSON.stringify(b.$value)) {
      rows.push({ path, state: "changed", before: a.$value, after: b.$value });
    }
    // A description-only change is a real change to the file and therefore a real change to the
    // commit. Rendering it as a row rather than folding it into the value row is what stops a
    // commit whose whole content is documentation reading as an empty diff.
    if ((a.$description ?? "") !== (b.$description ?? "")) {
      rows.push({
        path,
        state: "changed",
        before: a.$description ?? "",
        after: b.$description ?? "",
        description: true,
      });
    }
  }

  return {
    rows,
    changed: rows.filter((row) => row.state === "changed").length,
    added: rows.filter((row) => row.state === "added").length,
    removed: rows.filter((row) => row.state === "removed").length,
  };
}

// ---------------------------------------------------------------------------
// The manifest row — UX §7.2
// ---------------------------------------------------------------------------

/**
 * What changed in `$manifest.json`, in human terms.
 *
 * *"`tokens/$manifest.json` means nothing to a designer, so its nested line says what changed in
 * human terms — "Theme / Dark · 289 → 290 tokens", or "1 set added". A file in the diff that the
 * user cannot interpret is a file they will learn to ignore."* (UX §7.2.)
 *
 * `counts` carries token counts per set, which the manifest itself does not hold — so the sentence
 * is assembled from the manifest's set inventory and the two trees' own sizes rather than invented.
 */
export function describeManifestChange(
  before: Manifest | null,
  after: Manifest | null,
  counts?: { before: Map<string, number>; after: Map<string, number> }
): string[] {
  const lines: string[] = [];
  const wasSets = setsOf(before);
  const nowSets = setsOf(after);

  const added = nowSets.filter((set) => wasSets.indexOf(set) === -1);
  const removed = wasSets.filter((set) => nowSets.indexOf(set) === -1);

  for (const set of added) lines.push(`${label(after, set)} · set added`);
  for (const set of removed) lines.push(`${label(before, set)} · set removed`);

  if (counts !== undefined) {
    for (const set of nowSets) {
      if (added.indexOf(set) !== -1) continue;
      const was = counts.before.get(set);
      const now = counts.after.get(set);
      if (was === undefined || now === undefined || was === now) continue;
      lines.push(`${label(after, set)} · ${was} → ${now} tokens`);
    }
  }

  if (lines.length === 0) lines.push("Set order or metadata changed.");
  return lines;
}

function setsOf(manifest: Manifest | null): string[] {
  if (manifest === null) return [];
  return manifest.tokenSetOrder.slice();
}

/** `Theme / Dark` rather than `theme/dark` — the panel's own name for a set, not the file's. */
function label(manifest: Manifest | null, set: string): string {
  if (manifest !== null) {
    for (const collection of manifest.collections) {
      for (const mode of collection.modes) {
        if (mode.set === set) return `${collection.name} / ${mode.name}`;
      }
    }
    for (const style of manifest.styleSets ?? []) {
      if (style.set === set) return `Styles / ${style.name}`;
    }
  }
  return set;
}
