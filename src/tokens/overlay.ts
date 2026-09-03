// The local edit overlay and its rescan merge — ADR-0004.
//
// Phase 4 edits persist. They are stored as *intent* — target + op + new value + the imported
// value the edit was made against — not as an edited copy of the tree. That is the whole decision
// (ADR-0004 §1): a snapshot records result with no record of which bytes the user authored, so a
// rescan has no basis on which to merge and can only clobber or refuse.
//
// Two rules this module exists to enforce, both easy to break by accident:
//
//   1. Entries key on **Figma provenance id**, never on the dotted path (§2). A designer renaming
//      a variable moves the path and not the id; a path-keyed edit would orphan on rename, or
//      worse, land on whatever token inherited the old path.
//   2. The overlay applies **after** `buildMergedImport`, to the built tree (§4). `build.ts` and
//      `merge.ts` stay pure, so a build is still exactly reproducible from Figma plus
//      `userSubtypes` — ADR-0002 §7's guarantee holds at the build boundary and the overlay is a
//      declared, inspectable transform on top of it.

import type { ReportEntry, Token, TokenFileOutput, TokenGroup, TokenValue } from "./types";
import type { FlatToken } from "./view";
import { isToken } from "./paths";
import { valueShape } from "./expr";
import { buildResolveContext, resolveValue } from "./resolve";
import { tokensInStack } from "./themes";
import { stableStringify } from "./serialize";

/** Variables key on `variableId` **and** `modeId`; styles key on `styleId` (ADR-0004 §2). */
export interface OverlayTarget {
  variableId?: string;
  modeId?: string;
  styleId?: string;
}

export type OverlayOp = "set-value" | "set-description" | "delete";

/**
 * Recorded when a rescan found the target moved out from under the edit (§4).
 *
 * Kept on the entry, not only in the report, because the conflict has to survive the session that
 * discovered it: the user resolves conflicts in the tree at leisure (UX §5.5), possibly days
 * later, and the "Now in Figma" side has to still be there when they do.
 */
export interface OverlayConflict {
  /** What the other side says — the value the user is choosing against. */
  figma?: TokenValue;
  at: string;
  /**
   * Which other side that is — ADR-0006 §5's `origin` field, doing UX work.
   *
   * `"figma"` (the default, and everything written before Phase 6) is ADR-0004's conflict: a rescan
   * found the target moved under the edit. `"repo"` is Phase 6's: a pull landed on a token the user
   * had also edited. The two are structurally identical and resolve identically; they differ only in
   * what the block can honestly call the opposing value — *Now in Figma* or *From the repo*
   * (UX §8.2). Guessing wrong there is the difference between blaming a colleague and blaming a bot.
   */
  origin?: "figma" | "repo";
  /**
   * A conflict from the *other* side that was already outstanding when this one was recorded.
   *
   * A token can genuinely conflict with both Figma and the repo — a rescan flags a drifted target,
   * then a pull lands on the same edit. Overwriting one with the other loses the value the user was
   * choosing against, so the earlier side is kept here. At most one level deep: there are only two
   * sides, and a second conflict from the same side is a refresh of that side, not a third opinion.
   */
  previous?: OverlayConflict;
}

/**
 * One edit, as intent.
 *
 * `value`/`base` carry a `TokenValue` for `set-value` and the description string for
 * `set-description` — one pair of fields rather than two, matching the entry shape ADR-0004 §2
 * pins. Both are absent for `delete`, which is a tombstone and has nothing to compare.
 */
export interface OverlayEntry {
  target: OverlayTarget;
  /** Display only, refreshed from provenance on every merge. Never the matching key (§2). */
  path: string;
  set: string;
  op: OverlayOp;
  value?: TokenValue;
  /** The imported value this edit was made against. The field the three-way merge turns on. */
  base?: TokenValue;
  at: string;
  /**
   * Set when the merge found the target gone (§4). The entry is kept rather than dropped so the
   * user can still copy the value out before discarding it (UX §5.5) — an edit that vanished
   * with its token would be unrecoverable, which is the one thing this ADR refuses to do.
   */
  orphaned?: boolean;
  conflict?: OverlayConflict;
  /**
   * Where this pending change came from — ADR-0006 §5, and the only field Phase 6 adds.
   *
   * `"local"` is the default and is what every entry written before Phase 6 means, so it is left
   * absent rather than backfilled. `"pulled"` marks an entry materialised from the repo, which
   * exists so the panel can say *where* a pending change came from and so a conflict message can
   * name the repo rather than the user (UX §8.2).
   *
   * Nothing in ADR-0004 §4's merge table changes: a pulled entry merges, conflicts and retires
   * exactly like an authored one. This is a label on an existing thing, not a second kind of thing.
   */
  origin?: OverlayOrigin;
}

export type OverlayOrigin = "local" | "pulled";

/** The default, said once, so no call site has to remember that absent means local. */
export function originOf(entry: OverlayEntry): OverlayOrigin {
  return entry.origin === "pulled" ? "pulled" : "local";
}

export interface EditOverlay {
  version: 1;
  entries: OverlayEntry[];
}

export function emptyOverlay(): EditOverlay {
  return { version: 1, entries: [] };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The overlay's matching key.
 *
 * `\0` as the joiner rather than `:` because Figma ids contain colons
 * (`VariableID:109:372`), and a separator that appears inside the parts is not a separator.
 */
export function targetKey(target: OverlayTarget): string | null {
  if (typeof target.styleId === "string" && target.styleId.length > 0) {
    return `style\0${target.styleId}`;
  }
  if (
    typeof target.variableId === "string" &&
    target.variableId.length > 0 &&
    typeof target.modeId === "string" &&
    target.modeId.length > 0
  ) {
    return `variable\0${target.variableId}\0${target.modeId}`;
  }
  return null;
}

/** The target a token was imported from, or null when its provenance cannot key an edit. */
export function targetOfToken(token: Token): OverlayTarget | null {
  const figma = token.$extensions?.["com.tokenvault"]?.figma;
  if (!figma) return null;
  if (typeof figma.styleId === "string" && figma.styleId.length > 0) {
    return { styleId: figma.styleId };
  }
  if (
    typeof figma.variableId === "string" &&
    figma.variableId.length > 0 &&
    typeof figma.modeId === "string" &&
    figma.modeId.length > 0
  ) {
    return { variableId: figma.variableId, modeId: figma.modeId };
  }
  return null;
}

export function tokenKey(token: Token): string | null {
  const target = targetOfToken(token);
  return target === null ? null : targetKey(target);
}

/**
 * Structural equality over token values.
 *
 * Routed through `stableStringify` rather than a hand-written deep compare so "equal" means
 * exactly what "byte-identical when written to disk" means (ADR-0002 §7) — key order included.
 * Two values that serialise the same are the same edit, and a merge that disagreed with the
 * serializer would report conflicts nobody could see in a diff.
 */
export function valuesEqual(a: TokenValue | undefined, b: TokenValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableStringify(a) === stableStringify(b);
}

/**
 * A newly discovered conflict, without throwing away one the entry already carried.
 *
 * A conflict from the same side is a refresh of that side and replaces it; one from the other side
 * is a second, independent fact about the same token — Figma moved *and* the repo moved — and is
 * kept on `previous` so neither opposing value is lost before the user has answered.
 */
export function mergeConflict(
  next: OverlayConflict,
  prior: OverlayConflict | undefined
): OverlayConflict {
  if (prior === undefined) return next;
  const sameSide = (prior.origin ?? "figma") === (next.origin ?? "figma");
  const carried = sameSide ? prior.previous : stripPrevious(prior);
  return carried === undefined ? next : { ...next, previous: carried };
}

/** One level deep, always: two sides means at most one conflict each. */
function stripPrevious(conflict: OverlayConflict): OverlayConflict {
  const out: OverlayConflict = { at: conflict.at };
  if ("figma" in conflict) out.figma = conflict.figma;
  if (conflict.origin !== undefined) out.origin = conflict.origin;
  return out;
}

/** Which side of the stack a conflict speaks for. Absent means Figma — everything before Phase 6. */
export function sideOf(conflict: OverlayConflict): "figma" | "repo" {
  return conflict.origin === "repo" ? "repo" : "figma";
}

/** The stack flattened, most recent first. At most two, because there are only two sides. */
function stack(conflict: OverlayConflict | undefined): OverlayConflict[] {
  if (conflict === undefined) return [];
  const rest = conflict.previous;
  return rest === undefined ? [stripPrevious(conflict)] : [stripPrevious(conflict), stripPrevious(rest)];
}

/** The inverse of `stack` — a list, most recent first, back into one nested conflict. */
function restack(list: OverlayConflict[]): OverlayConflict | undefined {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return { ...list[0], previous: list[1] };
}

/**
 * Resolving *one* conflict, not the entry's whole conflict history.
 *
 * A token can carry a Figma conflict and a repo conflict at once (`previous`). Answering the one on
 * screen answers one question; deleting the entry's `conflict` outright would silently discard the
 * other side's still-unanswered value, which is the exact loss `previous` exists to prevent. So the
 * outstanding one is promoted to the top and becomes what the panel shows next.
 */
function dropVisible(conflict: OverlayConflict | undefined): OverlayConflict | undefined {
  return restack(stack(conflict).slice(1));
}

/** The same, for one named side — a rescan resolves Figma's side and says nothing about the repo's. */
function dropSide(
  conflict: OverlayConflict | undefined,
  side: "figma" | "repo"
): OverlayConflict | undefined {
  return restack(stack(conflict).filter((entry) => sideOf(entry) !== side));
}

/** Writes a possibly-absent conflict onto an entry, keeping "no conflict" as an absent field. */
function withConflict(entry: OverlayEntry, conflict: OverlayConflict | undefined): OverlayEntry {
  const out: OverlayEntry = { ...entry };
  if (conflict === undefined) delete out.conflict;
  else out.conflict = conflict;
  return out;
}

// ---------------------------------------------------------------------------
// Applying the overlay to a built tree
// ---------------------------------------------------------------------------

/** The ops that currently apply to one target. A target can carry a value and a description edit. */
export interface TargetOps {
  value?: OverlayEntry;
  description?: OverlayEntry;
  delete?: OverlayEntry;
}

/** Active (non-orphaned) entries, indexed by target key. */
export function indexOverlay(overlay: EditOverlay): Map<string, TargetOps> {
  const index = new Map<string, TargetOps>();
  for (const entry of overlay.entries) {
    if (entry.orphaned === true) continue;
    const key = targetKey(entry.target);
    if (key === null) continue;
    const ops = index.get(key) ?? {};
    if (entry.op === "delete") ops.delete = entry;
    else if (entry.op === "set-value") ops.value = entry;
    else ops.description = entry;
    index.set(key, ops);
  }
  return index;
}

export interface AppliedTree {
  tokens: FlatToken[];
  /** Target keys the overlay removed from the tree, for the local-edits list to render. */
  deleted: Set<string>;
  /** Target keys carrying an applied value or description edit. */
  edited: Set<string>;
}

/**
 * The tree the browser shows: the built import with the overlay laid over it.
 *
 * `$extensions` is carried across by reference, never rebuilt. It is provenance, not user content
 * (UX §1), and it is the re-import matching key — an editor that round-tripped it through a form
 * would break ADR-0002 §7's byte-identical guarantee in the least visible way possible.
 */
export function applyOverlay(flat: FlatToken[], overlay: EditOverlay): AppliedTree {
  const index = indexOverlay(overlay);
  const tokens: FlatToken[] = [];
  const deleted = new Set<string>();
  const edited = new Set<string>();

  for (const entry of flat) {
    const key = tokenKey(entry.token);
    const ops = key === null ? undefined : index.get(key);
    if (ops === undefined) {
      tokens.push(entry);
      continue;
    }
    if (ops.delete !== undefined) {
      deleted.add(key as string);
      continue;
    }

    let token = entry.token;
    if (ops.value !== undefined && ops.value.value !== undefined) {
      token = { ...token, $value: ops.value.value };
    }
    if (ops.description !== undefined) {
      const description = ops.description.value;
      if (typeof description === "string" && description.length > 0) {
        token = { ...token, $description: description };
      } else {
        token = { ...token };
        delete token.$description;
      }
    }
    if (token !== entry.token) edited.add(key as string);
    tokens.push({ ...entry, token });
  }

  return { tokens, deleted, edited };
}

/**
 * The generated files with the overlay laid over them — what "Copy whole tree as JSON" copies.
 *
 * Until Phase 6 that copy is the only durable exit for an edit (UX §5.4), so it has to carry the
 * overlay; a copy that handed back the unedited import would look like the edits had been lost.
 * `tokens/$manifest.json` and `tokens/$import-report.json` pass through untouched — they describe
 * the import, and the overlay is not part of it.
 */
export function applyOverlayToFiles(
  files: TokenFileOutput[],
  overlay: EditOverlay
): TokenFileOutput[] {
  const index = indexOverlay(overlay);
  if (index.size === 0) return files;

  return files.map((file) => {
    if (file.path.startsWith("tokens/$")) return file;
    return { path: file.path, content: rewriteGroup(file.content as TokenGroup, index) };
  });
}

/** Rewrites one group, dropping deleted tokens and any group they leave empty. */
function rewriteGroup(group: TokenGroup, index: Map<string, TargetOps>): TokenGroup {
  const out: TokenGroup = {};

  for (const key of Object.keys(group)) {
    const child = group[key];
    if (child === null || typeof child !== "object") continue;

    if (!isToken(child)) {
      const rewritten = rewriteGroup(child, index);
      // A group emptied entirely by deletions is dropped rather than written as `{}` — an empty
      // group is not something the importer ever emits, so leaving one behind would show up as a
      // diff nobody made.
      if (Object.keys(rewritten).length > 0) out[key] = rewritten;
      continue;
    }

    const targetKeyOfChild = tokenKey(child);
    const ops = targetKeyOfChild === null ? undefined : index.get(targetKeyOfChild);
    if (ops === undefined) {
      out[key] = child;
      continue;
    }
    if (ops.delete !== undefined) continue;

    let token: Token = child;
    if (ops.value !== undefined && ops.value.value !== undefined) {
      token = { ...token, $value: ops.value.value };
    }
    if (ops.description !== undefined) {
      const description = ops.description.value;
      token = { ...token };
      if (typeof description === "string" && description.length > 0) token.$description = description;
      else delete token.$description;
    }
    out[key] = token;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The rescan three-way merge — ADR-0004 §4
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  overlay: EditOverlay;
  entries: ReportEntry[];
  applied: number;
  conflicts: number;
  orphaned: number;
  /** Entries that retired because Figma caught up, or because a tombstone got what it wanted. */
  retired: number;
}

/**
 * Reconciles a persisted overlay against a freshly built tree.
 *
 * The table (ADR-0004 §4), per entry:
 *
 * | Fresh scan says                       | Outcome                                    |
 * |---------------------------------------|--------------------------------------------|
 * | Target absent                         | `orphaned-edit` (tombstones retire silent) |
 * | Value equals `base`                   | Apply silently — the common case           |
 * | Value equals `value`                  | Retire silently; the edit is now a no-op   |
 * | Value differs from both               | Apply and report `edit-conflict`           |
 *
 * On a genuine conflict the local edit wins. Not because local is more correct, but because it is
 * the only side that cannot be recovered: discarding an edit is undoable by rescanning, and
 * clobbering one is undoable by nothing.
 */
export interface MergeOptions {
  /**
   * Evaluates an expression entry's value to the number Figma would hold — ADR-0007 §6.
   *
   * Absent means "we cannot evaluate", and an expression entry is then kept unconditionally rather
   * than compared. Keeping is the safe direction: retiring one would silently downgrade the token
   * to the flat number the expression happened to produce, and the overlay is the only place that
   * string exists while a file is disconnected.
   */
  evaluate?: (expression: string) => number | null;
}

/**
 * The evaluator `mergeOverlay`'s expression row needs — ADR-0004 §4's addendum, ADR-0007 §6.
 *
 * **Over the effective tree**, which is the whole point of it living here rather than being
 * assembled at the call site. The comparison the merge makes is *"has Figma caught up with what
 * this expression comes to?"*, and the number it has to be about is the one an apply would write.
 * Apply evaluates against the effective tree (`plan.ts` takes `input.tokens`, overlay applied), so a
 * merge evaluating against the raw scan is answering a different question with the same shape: an
 * entry holding `{b} * 2` where `b` carries its own pending edit would be judged against `b`'s stale
 * scanned value, settling or reporting the entry on a number that exists nowhere.
 *
 * The overlay passed here is the one going *into* the merge — the same input `mergeOverlay` reads,
 * so there is no ordering question about which overlay "the effective tree" means.
 */
export function mergeEvaluator(
  flat: FlatToken[],
  overlay: EditOverlay,
  stack: string[]
): (expression: string) => number | null {
  const effective = applyOverlay(flat, overlay).tokens;
  const context = buildResolveContext(tokensInStack(effective, stack), effective);
  return (expression) => {
    const resolved = resolveValue({ $type: "number", $value: expression }, context);
    return resolved.kind === "expression" && typeof resolved.value === "number"
      ? resolved.value
      : null;
  };
}

export function mergeOverlay(
  flat: FlatToken[],
  overlay: EditOverlay,
  now: string,
  options: MergeOptions = {}
): MergeOutcome {
  const fresh = new Map<string, FlatToken>();
  for (const entry of flat) {
    const key = tokenKey(entry.token);
    if (key !== null && !fresh.has(key)) fresh.set(key, entry);
  }

  const kept: OverlayEntry[] = [];
  const entries: ReportEntry[] = [];
  let applied = 0;
  let conflicts = 0;
  let orphaned = 0;
  let retired = 0;

  for (const entry of overlay.entries) {
    const key = targetKey(entry.target);
    const target = key === null ? undefined : fresh.get(key);

    if (target === undefined) {
      // A tombstone whose target is gone from Figma got what it wanted, so it retires without a
      // word. Every other op has a value that now has nowhere to go.
      if (entry.op === "delete") {
        retired += 1;
        continue;
      }
      orphaned += 1;
      const orphan: OverlayEntry = { ...entry, orphaned: true };
      delete orphan.conflict;
      kept.push(orphan);
      entries.push({
        kind: "orphaned-edit",
        reason: entry.op === "set-description" ? "description-target-deleted" : "target-deleted",
        message: `The ${entry.target.styleId !== undefined ? "Style" : "Variable"} behind "${entry.path}" (${entry.set}) no longer exists in Figma, so your local edit can't be reapplied. Copy the value out before discarding it.`,
        path: entry.path,
        set: entry.set,
      });
      continue;
    }

    // The target survived, so the entry's display fields are refreshed from where it lives now —
    // which is the point of keying on the id: a rename moves the path and the edit follows.
    const refreshed: OverlayEntry = { ...entry, path: target.path, set: target.setId };
    delete refreshed.orphaned;

    if (entry.op === "delete") {
      // Re-deriving the token is precisely what the tombstone exists to suppress, so a live
      // target is not a conflict (ADR-0004 §4).
      delete refreshed.conflict;
      kept.push(refreshed);
      applied += 1;
      continue;
    }

    const current: TokenValue | undefined =
      entry.op === "set-description" ? target.token.$description : target.token.$value;

    // ADR-0007 §6 — the one row of §4's table Phase 7 amends, and it is amended in the open rather
    // than discovered.
    //
    // After an apply the entry holds `"{a} * 2"` and Figma holds `8`. Those are never equal, so the
    // "Figma caught up, retire silently" row never fires and the entry falls through to "differs
    // from both `base` and `value`" — reporting a spurious `edit-conflict` after every single
    // apply. So the comparison is made against `evaluate(entry.value)` instead, and the outcome is
    // **keep the entry, report nothing**.
    //
    // Keeping it is the point, not a concession. An expression is authored data Figma cannot store,
    // so retiring the entry would silently downgrade the token to the flat number the expression
    // happened to produce. The consequence — an expression entry is sticky and re-applies on every
    // rebuild — is correct behaviour, and UX §6.6 puts a line above the Local list so it does not
    // read as a stuck state.
    if (
      entry.op === "set-value" &&
      typeof entry.value === "string" &&
      valueShape({ $type: target.token.$type, $value: entry.value }) === "expression"
    ) {
      const computed = options.evaluate?.(entry.value) ?? null;
      if (computed !== null && valuesEqual(current, computed)) {
        kept.push(withConflict(refreshed, dropSide(entry.conflict, "figma")));
        applied += 1;
        continue;
      }
      if (computed === null) {
        // Nothing to compare against. Kept unconditionally rather than guessed at — an entry the
        // merge cannot evaluate is not evidence that Figma disagrees with it.
        kept.push(refreshed);
        applied += 1;
        continue;
      }
      // Falls through: Figma holds neither the base nor what the expression comes to, which is a
      // genuine divergence and reports as one like any other.
    }

    if (valuesEqual(current, entry.value)) {
      // Figma caught up. The entry is a no-op and quietly stops existing.
      retired += 1;
      continue;
    }

    if (valuesEqual(current, entry.base)) {
      // Figma agrees with the base, so *Figma's* side of the conflict is settled — but a repo
      // conflict on the same entry is a separate, still-unanswered question and survives.
      kept.push(withConflict(refreshed, dropSide(entry.conflict, "figma")));
      applied += 1;
      continue;
    }

    refreshed.conflict = mergeConflict({ figma: current, at: now }, entry.conflict);
    kept.push(refreshed);
    applied += 1;
    conflicts += 1;
    entries.push({
      kind: "edit-conflict",
      reason: entry.op === "set-description" ? "description-diverged" : "value-diverged",
      message: `Both you and Figma changed "${entry.path}" (${entry.set}) since your edit. Your value is being used; Figma now has ${describe(current)}.`,
      path: entry.path,
      set: entry.set,
    });
  }

  return {
    overlay: { version: 1, entries: kept },
    entries,
    applied,
    conflicts,
    orphaned,
    retired,
  };
}

function describe(value: TokenValue | undefined): string {
  if (value === undefined) return "no value";
  if (typeof value === "object") return stableStringify(value).trim().replace(/\s+/g, " ");
  return String(value);
}

// ---------------------------------------------------------------------------
// Recording an edit
// ---------------------------------------------------------------------------

/**
 * Adds or replaces the entry for one target and op.
 *
 * Re-editing an already-edited token keeps the **original** `base`. Rebasing on each keystroke
 * would quietly rewrite the "what did Figma say when I started" record with the user's own last
 * value, and the merge would then never see a conflict it should have.
 *
 * An edit that lands back on the imported value drops the entry instead of storing a no-op — so
 * typing a value and typing it back leaves no trace, and the **Local edits · N** chip counts
 * real differences rather than visits.
 */
export function recordEdit(
  overlay: EditOverlay,
  entry: Omit<OverlayEntry, "at">,
  now: string
): EditOverlay {
  const key = targetKey(entry.target);
  if (key === null) return overlay;

  const kept: OverlayEntry[] = [];
  let previous: OverlayEntry | undefined;
  for (const existing of overlay.entries) {
    const sameTarget = targetKey(existing.target) === key;
    if (sameTarget && existing.op === entry.op) {
      previous = existing;
      continue;
    }
    // A delete supersedes the value and description edits on the same target: the token is going
    // away, and keeping them would resurrect a stale value if the delete is later undone.
    if (sameTarget && entry.op === "delete") continue;
    kept.push(existing);
  }

  const base = previous !== undefined && previous.orphaned !== true ? previous.base : entry.base;
  if (entry.op !== "delete" && valuesEqual(entry.value, base)) {
    return { version: 1, entries: kept };
  }

  kept.push({ ...entry, base, at: now });
  return { version: 1, entries: kept };
}

/** Drops every entry for one target — the "revert to imported value" and "discard" action. */
export function removeEntries(overlay: EditOverlay, target: OverlayTarget): EditOverlay {
  const key = targetKey(target);
  if (key === null) return overlay;
  return {
    version: 1,
    entries: overlay.entries.filter((entry) => targetKey(entry.target) !== key),
  };
}

/**
 * Resolves a conflict by keeping the local edit, rebased on what Figma now says.
 *
 * Rebasing is the whole point: without it the same conflict re-reports on every subsequent scan,
 * and a flag the user has already answered stops meaning anything (UX §5.5).
 *
 * Two things it must not get wrong, both of which follow from a conflict stack having two sides:
 *
 *   1. `conflict.figma` is only Figma's value when the conflict *is* Figma's. On a repo conflict it
 *      holds the repo's value (ADR-0006 §5), and rebasing `base` onto it would compare Figma's real
 *      value against something Figma never said — manufacturing a conflict on the next rescan for a
 *      token the user has already answered. So the rebase happens only for the Figma side; keeping
 *      the repo's value out means `base` stays what it already was, which *is* Figma's current value.
 *   2. Answering the visible conflict does not answer the one stacked under it. That one is promoted
 *      rather than deleted, and becomes what the panel asks about next.
 */
export function keepMine(overlay: EditOverlay, target: OverlayTarget, op: OverlayOp): EditOverlay {
  const key = targetKey(target);
  return {
    version: 1,
    entries: overlay.entries.map((entry) => {
      const conflict = entry.conflict;
      if (targetKey(entry.target) !== key || entry.op !== op || conflict === undefined) {
        return entry;
      }
      const rebased = withConflict(entry, dropVisible(conflict));
      if (sideOf(conflict) === "figma") rebased.base = conflict.figma;
      return rebased;
    }),
  };
}

/** One entry, named the way a bulk action has to name it: by target *and* op, never by target. */
export interface EntryRef {
  target: OverlayTarget;
  op: OverlayOp;
}

/**
 * The entries the Changes list's *Local* tab shows.
 *
 * Conflicted entries are excluded because they have their own tab, where they are resolved one at a
 * time — across a thousand tokens the right answer differs per token, which is why Phase 4 refused
 * a global keep-mine in the first place.
 *
 * Exported rather than inlined at the call site so the tab's list and its *Undo all* scope are the
 * *same function*. They were not, once: the list filtered and the button cleared the whole overlay,
 * so undoing the seven edits on screen also discarded conflicts the button had never shown.
 */
export function localEntries(overlay: EditOverlay): OverlayEntry[] {
  return overlay.entries.filter((entry) => entry.conflict === undefined);
}

/** Drops a named list of entries and nothing else — the scoped half of every bulk undo. */
export function dropEntries(overlay: EditOverlay, refs: EntryRef[]): EditOverlay {
  let next = overlay;
  for (const ref of refs) next = dropEntry(next, ref.target, ref.op);
  return next;
}

/** A bulk action's entries, reduced to what the `revert-entries` message carries. */
export function entryRefs(entries: OverlayEntry[]): EntryRef[] {
  return entries.map((entry) => ({ target: entry.target, op: entry.op }));
}

/** Drops one op's entry for a target, leaving its siblings — "take Figma's" and per-op revert. */
export function dropEntry(overlay: EditOverlay, target: OverlayTarget, op: OverlayOp): EditOverlay {
  const key = targetKey(target);
  return {
    version: 1,
    entries: overlay.entries.filter(
      (entry) => targetKey(entry.target) !== key || entry.op !== op
    ),
  };
}

// ---------------------------------------------------------------------------
// Storage shape
// ---------------------------------------------------------------------------

/**
 * Parses whatever `clientStorage` handed back.
 *
 * `clientStorage` is user-clearable and version-blind, so a malformed or unrecognised payload is
 * treated as "no edits" rather than throwing the Tokens tab into an error state. Entries that
 * cannot produce a target key are dropped: they could never match a token again.
 */
export function parseOverlay(stored: unknown): EditOverlay {
  if (stored === null || typeof stored !== "object") return emptyOverlay();
  const record = stored as { version?: unknown; entries?: unknown };
  if (record.version !== 1 || !Array.isArray(record.entries)) return emptyOverlay();

  const entries: OverlayEntry[] = [];
  for (const raw of record.entries) {
    if (raw === null || typeof raw !== "object") continue;
    const candidate = raw as OverlayEntry;
    if (candidate.op !== "set-value" && candidate.op !== "set-description" && candidate.op !== "delete") {
      continue;
    }
    if (targetKey(candidate.target ?? {}) === null) continue;
    entries.push(candidate);
  }
  return { version: 1, entries };
}
