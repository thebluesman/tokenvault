// The Tokens tab's view model — UX local-editor §4, §11.
//
// Everything the browser renders is derived here, once per import and once per overlay change,
// and nothing in the render path recomputes it. The two structures that make that worth doing:
//
//   - the **path-keyed** merge (§11): one row per dotted path, with a value line per contributing
//     set. Rendering per-set trees and reconciling them at draw time is the thing this exists to
//     avoid.
//   - the **inbound-reference index** (§7): built once per import, because the delete affordance
//     has to know the referrer count before it is clicked in order to render disabled, and a scan
//     per `⋯` menu open is a visible stall at 1,316 tokens.

import type {
  ImportPayload,
  MergeSummary,
  OverlayRecovery,
  SerializedFile,
  UiToPluginMessage,
} from "../messages";
import type { Manifest, ReportEntry, Token, TokenGroup, TokenType, TokenValue } from "../tokens/types";
import type { EditOverlay, EntryRef, OverlayEntry, OverlayOp, OverlayTarget } from "../tokens/overlay";
import type { FlatToken, PathRow, SetInfo, TreeNode } from "../tokens/view";
import type { InboundIndex, Referrer } from "../tokens/references";
import type { DriftEntry } from "../tokens/drift";
import type { Refusal } from "../tokens/toFigma";
import type { ApplyPlan, PlanScope } from "../tokens/plan";
import {
  applyOverlay,
  dropEntries,
  dropEntry,
  emptyOverlay,
  indexOverlay,
  keepMine,
  recordEdit,
  removeEntries,
  targetKey,
  targetOfToken,
  tokenKey,
  valuesEqual,
} from "../tokens/overlay";
import { buildPathRows, buildTree, describeSets, flattenImport } from "../tokens/view";
import { buildInboundIndex, inboundReferrers } from "../tokens/references";
import { buildApplyPlan } from "../tokens/plan";
import type { EffectiveTheme } from "../tokens/themes";
import { tokensInStack } from "../tokens/themes";
import type { Cycle } from "../tokens/graph";
import { graphNodeKey } from "../tokens/graph";
import type { ResolveContext, Resolution } from "../tokens/resolve";
import {
  buildResolveContext,
  emptyResolveContext,
  resolveToken,
  themePathSet,
} from "../tokens/resolve";
import { normalizePathKey } from "../tokens/paths";
import { stableStringify } from "../tokens/serialize";

export function send(message: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One value line, and everything the row needs to know about it without a second lookup. */
export interface Line {
  entry: FlatToken;
  /** The token as imported, before the overlay. `undefined` only for a token the import lost. */
  imported: Token | undefined;
  set: SetInfo;
  /** ADR-0004 target key, or null when provenance can't key an edit (nothing in Phase 4). */
  key: string | null;
  target: OverlayTarget | null;
  edited: boolean;
  conflict?: OverlayEntry;
  /**
   * Figma moved under this token since the baseline scan (ADR-0005 §7).
   *
   * Only ever set on a line with **no** overlay entry: a token that has both is a conflict, and
   * `conflict` says so with both values in hand. Two badges for one situation is exactly what
   * UX §6.2's single-`⚑` vocabulary exists to avoid.
   */
  drift?: DriftEntry;
  flags: ReportEntry[];
}

export interface Row {
  row: PathRow;
  lines: Line[];
}

export interface Filters {
  query: string;
  /** `null` means every set — distinct from a set of all of them, which the chip reads differently. */
  sets: Set<string> | null;
  types: Set<TokenType> | null;
  flaggedOnly: boolean;
}

export interface EditorModel {
  ready: boolean;
  fileName: string;
  fromCache: boolean;
  sets: SetInfo[];
  /** Every path in the tree, overlay applied, in file order. */
  rows: Row[];
  byPath: Map<string, Row>;
  tree: TreeNode[];
  inbound: InboundIndex;
  overlay: EditOverlay;
  merge?: MergeSummary;
  /** Tombstones whose token still exists in the import — the "deleted" half of the edits list. */
  deletions: OverlayEntry[];
  orphans: OverlayEntry[];
  storageError?: string;
  /**
   * What reading the stored overlay cost, when it cost something — UX `error-states.md` §4.
   *
   * The read-side twin of `storageError`, and carried for the whole session rather than shown once:
   * the overlay is the only thing in the plugin that cannot be re-derived, so news that some of it
   * failed to load has to survive a rescan, a pull and a tab switch.
   */
  overlayRecovery?: OverlayRecovery;
  /** Number/string tokens still carrying `subtypeSource: "default"`. */
  unconfirmed: number;
  flagged: number;

  // --- Phase 5 (ADR-0005) ---

  /** ISO timestamp of the last real read of the file — the "scanned 12 minutes ago" line (§6.1). */
  scannedAt: string;
  /** Undismissed drift, by target key. */
  drift: Map<string, DriftEntry>;
  /**
   * Whether a baseline existed at all.
   *
   * `false` is *unknown*, not *none* (§8), and the header chip must never render "In sync" on it —
   * a green all-clear that actually meant "we had nothing to compare with" is the one lie this
   * feature cannot afford.
   */
  driftKnown: boolean;
  /** The pristine tree, for the apply plan's `before` column and for "put Figma back" (§6.4). */
  imported: FlatToken[];
  styleGuards: Map<string, Refusal>;
  nonLocalPaths: Set<string>;
  /**
   * Whether the two guards above were actually established.
   *
   * `false` on a tree restored from a cache written before the guards were part of it. Both are
   * empty *and* meaningless then, and every apply path has to refuse rather than read the emptiness
   * as an all-clear — see `openApplyDialog`, which is the single funnel that enforces it.
   */
  guardsKnown: boolean;

  // --- Phase 7 (ADR-0007) ---

  /** The themes import derived from Figma's collections and modes. Read-only (§7b). */
  themes: EffectiveTheme[];
  /** `null` only when the file has no themes at all — UX §8.5's `Theme: none`. */
  activeTheme: EffectiveTheme | null;
  /** Which theme the current page's explicit modes match, when any — UX §8.2's grey tag. */
  themeOnCanvas: string | null;
  /** Collections with more than one mode, so §8.5 can name the cause back to the user. */
  multiModeCollections: string[];
  /**
   * Theme-scoped resolution, rebuilt whenever the tree or the theme changes.
   *
   * Everything in the render path asks this rather than recomputing: the value line's number, the
   * cycle badge, the picker's three groups and the editor's four rules all come out of one context,
   * so they cannot disagree about what the active theme resolves to.
   */
  resolve: ResolveContext;
  /** Every theme's resolvable path set, for rule 4's "which themes does this dangle in". */
  themeStacks: Array<{ name: string; paths: Set<string> }>;
  /** Distinct loops, not tokens on loops — the header chip's count (UX §9). */
  cycles: Cycle[];
}

let payload: ImportPayload | null = null;
let overlay: EditOverlay = emptyOverlay();
let model: EditorModel = blankModel();
let listeners: Array<() => void> = [];

/**
 * Drift the user has waved off this session, by target key.
 *
 * Session-local and deliberately unpersisted. Phase 5 drift is a changelog against a local
 * watermark (ADR-0005 §8), and the watermark advances on the very next scan — so a durable
 * dismissal store would outlive the thing it was dismissing and add a third state
 * (`clientStorage`) to a feature the ADR was careful to keep at one baseline and one store.
 */
let dismissedDrift = new Set<string>();

export const filters: Filters = { query: "", sets: null, types: null, flaggedOnly: false };

function blankModel(): EditorModel {
  return {
    ready: false,
    fileName: "",
    fromCache: false,
    sets: [],
    rows: [],
    byPath: new Map(),
    tree: [],
    inbound: new Map(),
    overlay: emptyOverlay(),
    deletions: [],
    orphans: [],
    unconfirmed: 0,
    flagged: 0,
    scannedAt: "",
    drift: new Map(),
    driftKnown: false,
    imported: [],
    styleGuards: new Map(),
    nonLocalPaths: new Set(),
    guardsKnown: false,
    themes: [],
    activeTheme: null,
    themeOnCanvas: null,
    multiModeCollections: [],
    resolve: emptyResolveContext(),
    themeStacks: [],
    cycles: [],
  };
}

export function getModel(): EditorModel {
  return model;
}

/**
 * The import's serialized files, exactly as they crossed `postMessage` — Phase 6's push input.
 *
 * Handed out as the *pristine* set, with the overlay applied downstream by `git/local.ts`, because
 * the bytes a push writes have to be produced by one function that also produced the bytes whose
 * blob SHA the status check compared (ADR-0006 §4). Two paths to "the file's content" is how a
 * push and a status check end up disagreeing about whether anything changed.
 */
export function importedFiles(): SerializedFile[] {
  return payload === null ? [] : payload.files;
}

export function importedManifest(): Manifest | null {
  return payload === null ? null : payload.manifest;
}

/** Which baseline the last drift comparison actually used — ADR-0006 §7, reported not assumed. */
export function driftBaseline(): "repo" | "scan" {
  return payload?.driftBaseline ?? "scan";
}

export function onChange(listener: () => void): void {
  listeners.push(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export function setPayload(next: ImportPayload): void {
  // A fresh scan carries a fresh drift set, so anything waved off against the previous baseline is
  // answered — the watermark moved past it. A `refresh` re-derives the same snapshot, so those
  // dismissals still stand.
  if (next.refresh !== true) dismissedDrift = new Set();
  payload = next;
  overlay = next.overlay;
  rebuild();
}

/** Waves off one drift row — UX §6.4's *Take Figma's*, which for an unedited token is local only. */
export function dismissDrift(keys: string[]): void {
  for (const key of keys) dismissedDrift.add(key);
  rebuild();
}

export function setOverlay(
  next: EditOverlay,
  storageError?: string,
  recovery?: OverlayRecovery
): void {
  // Sticky: the plugin re-attaches it to every `overlay-state`, but a message that arrives without
  // it (from a code path that predates it, or a future one) must not quietly cancel the notice.
  if (recovery !== undefined) overlayRecovery = recovery;
  const changed = stableStringify(next) !== stableStringify(overlay);
  overlay = next;
  if (changed) rebuild(storageError);
  else {
    model = { ...model, storageError, overlayRecovery };
    notify();
  }
}

/** Sticky for the session — see `setOverlay`. */
let overlayRecovery: OverlayRecovery | undefined;

/** Key for the flag index. A `set`-less entry applies to every line at that path. */
function flagKey(path: string | undefined, set: string | undefined): string {
  return `${normalizePathKey(path ?? "")}\0${set ?? ""}`;
}

function rebuild(storageError?: string): void {
  if (payload === null) {
    // The overlay is durable and the import is not, so the panel can legitimately have edits and
    // no tree (ADR-0004 §1). Carrying the overlay into the blank model is what lets the Tokens
    // tab say "your 7 local edits are still here" instead of implying they were lost (UX §8).
    model = { ...blankModel(), overlay, storageError, overlayRecovery };
    notify();
    return;
  }

  const trees = new Map<string, TokenGroup>();
  for (const file of payload.files) {
    if (file.path.startsWith("tokens/$")) continue;
    trees.set(file.path, JSON.parse(file.json) as TokenGroup);
  }

  const sets = describeSets(payload.manifest);
  const setById = new Map(sets.map((info) => [info.id, info] as const));
  const pristine = flattenImport(trees, payload.manifest);

  const importedByKey = new Map<string, Token>();
  for (const entry of pristine) {
    const key = tokenKey(entry.token);
    if (key !== null && !importedByKey.has(key)) importedByKey.set(key, entry.token);
  }

  const applied = applyOverlay(pristine, overlay);
  const rows = buildPathRows(applied.tokens, sets);

  // One context for the whole render pass. The tree it resolves against is the **effective** one —
  // overlay applied — because a loop the user just authored has to render as a loop immediately,
  // not after the next scan.
  const activeName = payload.activeTheme;
  const active =
    activeName === null ? null : (payload.themes.filter((theme) => theme.name === activeName)[0] ?? null);
  const stack =
    active === null ? payload.manifest.tokenSetOrder.slice() : active.selectedTokenSets.slice();
  const resolveContext = buildResolveContext(tokensInStack(applied.tokens, stack), applied.tokens);

  const flags = new Map<string, ReportEntry[]>();
  for (const entry of payload.entries) {
    if (entry.path === undefined) continue;
    const key = flagKey(entry.path, entry.set);
    const list = flags.get(key);
    if (list === undefined) flags.set(key, [entry]);
    else list.push(entry);
  }

  const drift = new Map<string, DriftEntry>();
  for (const entry of payload.drift) {
    if (dismissedDrift.has(entry.key)) continue;
    drift.set(entry.key, entry);
  }

  const ops = indexOverlay(overlay);
  const modelRows: Row[] = rows.map((row) => ({
    row,
    lines: row.lines.map((entry) => {
      const key = tokenKey(entry.token);
      const target = targetOfToken(entry.token);
      const targetOps = key === null ? undefined : ops.get(key);
      const conflict =
        targetOps?.value?.conflict !== undefined
          ? targetOps.value
          : targetOps?.description?.conflict !== undefined
            ? targetOps.description
            : undefined;
      return {
        entry,
        imported: key === null ? undefined : importedByKey.get(key),
        set: setById.get(entry.setId) ?? {
          id: entry.setId,
          code: entry.setId,
          label: entry.setId,
          source: "variables",
          file: "",
        },
        key,
        target,
        edited: key !== null && applied.edited.has(key),
        conflict,
        // A line with an overlay entry is never drifted: it is either clean or in conflict, and
        // the conflict block already shows both sides (ADR-0005 §7's two-row table).
        drift: key === null || targetOps !== undefined ? undefined : drift.get(key),
        // Drift report rows ride the same `⚑` badge as every other flag (UX §6.2), but only while
        // the drift is still live: a row the user has waved off, or one that turned out to be a
        // conflict, must not keep claiming attention it no longer needs.
        flags: (flags.get(flagKey(entry.path, entry.setId)) ?? [])
          .concat(flags.get(flagKey(entry.path, undefined)) ?? [])
          .filter(
            (flag) =>
              flag.kind.indexOf("drift-") !== 0 ||
              (key !== null && targetOps === undefined && drift.has(key))
          ),
      };
    }),
  }));

  const byPath = new Map<string, Row>();
  for (const row of modelRows) byPath.set(row.row.key, row);

  let unconfirmed = 0;
  for (const row of modelRows) {
    for (const line of row.lines) {
      const extension = line.entry.token.$extensions?.["com.tokenvault"];
      if (extension?.subtypeSource === "default") unconfirmed += 1;
    }
  }

  model = {
    ready: true,
    fileName: payload.fileName,
    fromCache: payload.fromCache,
    sets,
    rows: modelRows,
    byPath,
    tree: buildTree(rows),
    inbound: buildInboundIndex(applied.tokens),
    overlay,
    merge: payload.merge,
    deletions: overlay.entries.filter((entry) => entry.op === "delete" && entry.orphaned !== true),
    orphans: overlay.entries.filter((entry) => entry.orphaned === true),
    storageError,
    overlayRecovery,
    unconfirmed,
    flagged: payload.entries.filter((entry) => entry.path !== undefined).length,
    scannedAt: payload.importedAt,
    drift,
    driftKnown: payload.driftKnown,
    imported: pristine,
    styleGuards: new Map(payload.styleGuards),
    nonLocalPaths: new Set(payload.nonLocalPaths),
    guardsKnown: payload.guardsKnown,
    themes: payload.themes,
    activeTheme: active,
    themeOnCanvas: payload.themeOnCanvas,
    multiModeCollections: payload.multiModeCollections,
    resolve: resolveContext,
    themeStacks: payload.themes.map((theme) => ({
      name: theme.name,
      paths: themePathSet(applied.tokens, theme.selectedTokenSets),
    })),
    cycles: resolveContext.cycles.cycles,
  };
  notify();
}

// ---------------------------------------------------------------------------
// The apply plan — ADR-0005 §1
// ---------------------------------------------------------------------------

/**
 * Builds the plan for a scope, from the model the UI already holds.
 *
 * `plan.ts` is pure and the UI has the tree, the overlay and the guards, so there is no round trip
 * here — the plugin's half of apply is the write and the rescan. It also means the dialog can
 * render the plan it is about to send, rather than a description of one.
 */
export function planFor(scope: PlanScope = {}): ApplyPlan {
  return buildApplyPlan(
    {
      tokens: allEntries(),
      imported: model.imported,
      overlay: model.overlay,
      styleGuards: model.styleGuards,
      nonLocalPaths: model.nonLocalPaths,
      guardsKnown: model.guardsKnown,
      resolve: model.resolve,
    },
    scope
  );
}

/**
 * The plan for putting Figma back to what it said at the last scan — UX §6.4's *Re-apply token*.
 *
 * Phase 5's honest shape for that action. With no git sync the tree is re-derived from Figma on
 * every scan, so a drifted-but-unedited token *already shows Figma's new value* — there is no
 * "the token's value" left to push. What the user can still ask for is the change reverted, and
 * the baseline value is the only record of what it was.
 *
 * Modelled as a temporary overlay rather than a second plan producer: it is exactly an edit back
 * to the old value, and routing it through the same builder means it inherits every guard —
 * aliases, cycles, style losses — instead of re-deriving a subset of them.
 */
export function planRestoreDrift(keys: string[]): ApplyPlan {
  const wanted = new Set(keys);
  const entries: OverlayEntry[] = [];
  const at = now();

  for (const row of model.rows) {
    for (const line of row.lines) {
      if (line.key === null || !wanted.has(line.key) || line.target === null) continue;
      const entry = model.drift.get(line.key);
      if (entry === undefined || entry.kind !== "drift-value") continue;
      entries.push({
        target: line.target,
        path: line.entry.path,
        set: line.entry.setId,
        op: entry.reason === "description-changed" ? "set-description" : "set-value",
        value: entry.baseline,
        base: entry.current,
        at,
      });
    }
  }

  const restored = allLines().map((line) => {
    const entry = line.key === null ? undefined : model.drift.get(line.key);
    if (entry === undefined || !wanted.has(line.key as string) || entry.kind !== "drift-value") {
      return line.entry;
    }
    return entry.reason === "description-changed"
      ? { ...line.entry, token: { ...line.entry.token, $description: entry.baseline as string } }
      : { ...line.entry, token: { ...line.entry.token, $value: entry.baseline as never } };
  });

  return buildApplyPlan(
    {
      tokens: restored,
      imported: allEntries(),
      overlay: { version: 1, entries },
      styleGuards: model.styleGuards,
      nonLocalPaths: model.nonLocalPaths,
      guardsKnown: model.guardsKnown,
      // The same theme-scoped context `planFor` passes. Omitting it fell back to the whole-tree,
      // theme-agnostic one, so a restore could evaluate an expression against a set the active
      // theme does not include — a different number from the one every other apply path computes.
      resolve: model.resolve,
    },
    { keys: wanted }
  );
}

/** Every value line in the tree. The row grouping is a display construct (UX §11), not an index. */
function allLines(): Line[] {
  const lines: Line[] = [];
  for (const row of model.rows) {
    for (const line of row.lines) lines.push(line);
  }
  return lines;
}

function allEntries(): FlatToken[] {
  return allLines().map((line) => line.entry);
}

/** Target keys for a set of lines, for scoping a plan to a row, a path or a group. */
export function keysOf(lines: Line[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    if (line.key !== null) keys.add(line.key);
  }
  return keys;
}

/** Every drifted line in the tree, for the Changes list's *Changed* section. */
export function driftedLines(): Line[] {
  return allLines().filter((line) => line.drift !== undefined);
}

/** Every line whose overlay entry is in conflict — the Changes list's *Conflicts* section. */
export function conflictedLines(): Line[] {
  return allLines().filter((line) => line.conflict !== undefined);
}

/** The line behind an overlay target, for the Changes list's *Local* rows. */
export function lineForTarget(target: OverlayTarget): Line | undefined {
  const key = targetKey(target);
  if (key === null) return undefined;
  return allLines().filter((line) => line.key === key)[0];
}

/** Rebuilds the tree for the current filters — used by the browser, never cached. */
export function visibleRows(): Row[] {
  const query = filters.query.trim().toLowerCase();
  const out: Row[] = [];

  for (const row of model.rows) {
    let lines = row.lines;
    if (filters.sets !== null) lines = lines.filter((line) => filters.sets?.has(line.entry.setId));
    if (filters.types !== null) lines = lines.filter((line) => filters.types?.has(line.entry.token.$type));
    // A flag lands on the value line, not the path (§4.6): a token can be flagged in `Dark` and
    // clean in `Light`, and filtering keeps the path row while showing only its flagged lines.
    if (filters.flaggedOnly) {
      lines = lines.filter((line) => line.flags.length > 0 || line.conflict !== undefined);
    }
    if (lines.length === 0) continue;

    if (query.length > 0 && !matches(row, lines, query)) continue;
    out.push(lines === row.lines ? row : { row: row.row, lines });
  }

  return out;
}

function matches(row: Row, lines: Line[], query: string): boolean {
  if (row.row.path.toLowerCase().indexOf(query) !== -1) return true;
  for (const line of lines) {
    const description = line.entry.token.$description;
    if (typeof description === "string" && description.toLowerCase().indexOf(query) !== -1) return true;
  }
  return false;
}

/** Hits the set filter is hiding, so a filtered search never silently under-reports (§4.6). */
export function hiddenMatches(): { count: number; sets: number } {
  if (filters.sets === null) return { count: 0, sets: 0 };
  const query = filters.query.trim().toLowerCase();
  const sets = new Set<string>();
  let count = 0;

  for (const row of model.rows) {
    const hidden = row.lines.filter((line) => !filters.sets?.has(line.entry.setId));
    if (hidden.length === 0) continue;
    if (query.length > 0 && !matches(row, hidden, query)) continue;
    count += hidden.length;
    for (const line of hidden) sets.add(line.entry.setId);
  }

  return { count, sets: sets.size };
}

export function typeCounts(): Map<TokenType, number> {
  const counts = new Map<TokenType, number>();
  for (const row of model.rows) {
    for (const line of row.lines) {
      const type = line.entry.token.$type;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return counts;
}

export function setCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of model.rows) {
    for (const line of row.lines) {
      counts.set(line.entry.setId, (counts.get(line.entry.setId) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

/**
 * Applies an edit locally and sends it to be persisted.
 *
 * Optimistic on purpose: the tree updates on the same frame as the keystroke, and the plugin's
 * `overlay-state` reply is a confirmation rather than the source of the new value. The two can
 * only disagree if the write failed, which arrives as `storageError` and is shown, not swallowed.
 */
function commit(entries: Array<Omit<OverlayEntry, "at">>): void {
  if (entries.length === 0) return;
  const at = now();
  let next = overlay;
  for (const entry of entries) next = recordEdit(next, entry, at);
  overlay = next;
  send({ type: "edit", entries });
  rebuild();
}

/**
 * Why this line can't be edited, or `null` when it can.
 *
 * An edit is keyed on Figma provenance (ADR-0004 §2), so a token that arrived without a usable
 * `variableId`/`modeId` or `styleId` has nowhere to record one. That is rare and not the user's
 * doing — which is exactly why it has to be *said* rather than absorbed as a no-op that looks
 * like the edit was accepted and then silently reverted.
 */
export function editBlockedReason(line: Line): string | null {
  if (line.target === null) {
    return "This token can't be edited — Tokenvault couldn't tie it back to a Figma Variable or Style.";
  }
  if (line.imported === undefined) {
    return "This token has no imported value to edit against. Rescan the file and try again.";
  }
  return null;
}

/** Commits a value edit. Returns an error message if it couldn't be recorded, `null` if it was. */
export function editValue(line: Line, value: TokenValue): string | null {
  const target = line.target;
  const imported = line.imported;
  if (target === null || imported === undefined) return editBlockedReason(line);
  if (valuesEqual(value, line.entry.token.$value)) return null;
  commit([
    {
      target,
      path: line.entry.path,
      set: line.entry.setId,
      op: "set-value",
      value,
      base: imported.$value,
    },
  ]);
  return null;
}

/** Commits a description edit. Same contract as `editValue`. */
export function editDescription(line: Line, description: string): string | null {
  const target = line.target;
  const imported = line.imported;
  if (target === null || imported === undefined) return editBlockedReason(line);
  const next = description.trim().length === 0 ? "" : description;
  if (next === (line.entry.token.$description ?? "")) return null;
  commit([
    {
      target,
      path: line.entry.path,
      set: line.entry.setId,
      op: "set-description",
      value: next,
      base: imported.$description ?? "",
    },
  ]);
  return null;
}

/**
 * Deletes the given lines as one operation.
 *
 * A group delete records **one tombstone per descendant token**, not a single group-level one
 * (ADR-0004 §2): a group is not a Figma entity and has no id, so a group tombstone would silently
 * swallow tokens added to that group later.
 *
 * Returns what actually happened. A line with no overlay target cannot be tombstoned, and the
 * caller has to know that before it claims a deletion in a toast.
 */
export interface DeleteOutcome {
  deleted: number;
  /** Lines skipped for having no overlay target — nothing was recorded for them. */
  skipped: number;
}

export function deleteLines(lines: Line[]): DeleteOutcome {
  const entries: Array<Omit<OverlayEntry, "at">> = [];
  let skipped = 0;
  for (const line of lines) {
    const target = line.target;
    if (target === null) {
      skipped += 1;
      continue;
    }
    entries.push({
      target,
      path: line.entry.path,
      set: line.entry.setId,
      op: "delete",
    });
  }
  commit(entries);
  return { deleted: entries.length, skipped };
}

/**
 * The optimistic local halves of the overlay mutations.
 *
 * They deliberately call the *same* `overlay.ts` functions the plugin side applies to the durable
 * copy (`code.ts`'s `handleRevert` / `keep-mine`). Hand-rolling the equivalent filter here is how
 * the two copies drift, and a drift between them is invisible until a rescan disagrees.
 */
export function revert(targets: OverlayTarget[], op?: OverlayOp): void {
  let next = overlay;
  for (const target of targets) {
    next = op === undefined ? removeEntries(next, target) : dropEntry(next, target, op);
  }
  overlay = next;
  send({ type: "revert", targets, op });
  rebuild();
}

/**
 * Drops exactly the entries handed to it — never the whole overlay.
 *
 * The Changes list's *Undo all* is scoped to the tab it sits on, which shows non-conflicted local
 * edits only. Clearing the store outright would take the conflicts with it: entries that tab never
 * rendered, whose resolution the user is being asked to make one at a time in a different tab.
 * A bulk action's scope is what is on screen under it.
 */
export function revertEntries(refs: EntryRef[]): void {
  if (refs.length === 0) return;
  overlay = dropEntries(overlay, refs);
  send({ type: "revert-entries", entries: refs });
  rebuild();
}

/**
 * Resolves a conflict the other way — UX git-sync §8.2's `[ Take the repo's ]`.
 *
 * Phase 4's *Take Figma's* could just drop the entry, because Figma's value was the one the tree
 * would fall back to. A **pulled** conflict is not like that: the opposing value came from the
 * repo, and Figma has neither side. So taking it means *recording it* — as a pulled entry, which
 * then rides the ordinary apply flow onto the canvas like any other pending change (ADR-0006 §5).
 *
 * Returns false when there is nothing to take, so the caller never claims a resolution it didn't
 * make.
 */
export function resolveTakeRepo(line: Line): boolean {
  const conflict = line.conflict;
  const target = line.target;
  if (conflict === undefined || target === null) return false;
  const value = conflict.conflict?.figma;
  if (value === undefined) return false;

  commit([
    {
      target,
      path: line.entry.path,
      set: line.entry.setId,
      op: conflict.op,
      value,
      // The base is what Figma currently says *for the field this op edits* — the same branch
      // `mergeOverlay` takes. Recording `$value` for a description edit would leave a base the next
      // rescan can never match, and the conflict would come straight back.
      base:
        conflict.op === "set-description"
          ? (line.entry.token.$description ?? "")
          : line.entry.token.$value,
      origin: "pulled",
    },
  ]);
  return true;
}

export function resolveKeepMine(target: OverlayTarget, op: OverlayOp): void {
  overlay = keepMine(overlay, target, op);
  send({ type: "keep-mine", target, op });
  rebuild();
}

/** How many overlay entries the header chip counts. Subtype edits are not among them (§11). */
export function editCount(): number {
  return overlay.entries.length;
}

// ---------------------------------------------------------------------------
// Delete blocking — UX §7
// ---------------------------------------------------------------------------

export interface DeleteBlock {
  /** Paths that reference something being deleted, with the sets they reference from. */
  referrers: Array<{ path: string; sets: string[] }>;
  count: number;
}

/**
 * Inbound references that would be stranded by deleting `paths`.
 *
 * References *from within* the deleted set don't block: they're going away together (§7). The
 * result is grouped by referrer path with its sets listed, matching the merged tree's vocabulary
 * rather than inventing a second one.
 */
export function deleteBlockers(paths: string[]): DeleteBlock {
  const going = new Set(paths.map(normalizePathKey));
  const grouped = new Map<string, Set<string>>();
  let count = 0;

  for (const path of paths) {
    const referrers: Referrer[] = inboundReferrers(model.inbound, path, (referrer) =>
      going.has(normalizePathKey(referrer.path))
    );
    for (const referrer of referrers) {
      count += 1;
      const sets = grouped.get(referrer.path);
      if (sets === undefined) grouped.set(referrer.path, new Set([referrer.setId]));
      else sets.add(referrer.setId);
    }
  }

  return {
    count,
    referrers: Array.from(grouped.entries()).map(([path, sets]) => ({
      path,
      sets: Array.from(sets),
    })),
  };
}

/** Every token path under a group row, across every set. */
export function pathsUnder(prefix: string): Row[] {
  const needle = `${normalizePathKey(prefix)}.`;
  return model.rows.filter((row) => row.row.key.startsWith(needle));
}

// ---------------------------------------------------------------------------
// Themes and resolution — ADR-0007 §4, §7
// ---------------------------------------------------------------------------

/** What one value line comes out as under the active theme. The render path's single question. */
export function resolutionFor(line: Line): Resolution {
  return resolveToken(line.entry, model.resolve);
}

/** True when this line sits on a loop — the `⚑ cycle` badge and the `—` value preview. */
export function onCycle(line: Line): boolean {
  return model.resolve.cycles.nodes.has(graphNodeKey(line.entry.setId, line.entry.path));
}

/**
 * Picks the theme the panel resolves against.
 *
 * Optimistic like every other UI mutation, but with one difference that matters: this is a **lens**
 * and writes nothing to the document (UX §8.3, §11 resolution 1). The plugin's reply re-derives the
 * report — flags are theme-scoped too — which is why the local model is not patched here.
 */
export function setActiveTheme(name: string): void {
  send({ type: "set-active-theme", name });
}

/** The canvas switch — a second, explicit action, and the only one that touches the document. */
export function switchPageTheme(name: string): void {
  send({ type: "switch-page-theme", name });
}
