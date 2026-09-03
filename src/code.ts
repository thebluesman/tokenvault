import type {
  ApplyReport,
  GitConfig,
  ImportPayload,
  MergeSummary,
  PluginToUiMessage,
  SerializedFile,
  UiToPluginMessage,
} from "./messages";
import type { RepoSettings, SyncState } from "./git/types";
import type { TokenGroup } from "./tokens/types";
import {
  PAT_KEY,
  SETTINGS_KEY,
  lastFour,
  parseSettings,
  parseSyncState,
  syncKey,
  syncStateApplies,
} from "./git/state";
import { applyPull } from "./git/pull";
import type { FileScan, ImportResult, SubtypeSelection } from "./tokens/types";
import type { EditOverlay, EntryRef, OverlayEntry, OverlayOp, OverlayTarget } from "./tokens/overlay";
import type { DriftResult } from "./tokens/drift";
import type { FlatToken } from "./tokens/view";
import type { PlannedWrite } from "./figma/apply";
import type { Refusal } from "./tokens/toFigma";
import {
  applyOverlayToFiles,
  dropEntries,
  dropEntry,
  emptyOverlay,
  indexOverlay,
  keepMine,
  mergeOverlay,
  parseOverlay,
  recordEdit,
  removeEntries,
  targetKey,
} from "./tokens/overlay";
import { flattenImport, treeIndex } from "./tokens/view";
import { buildMergedImport } from "./tokens/merge";
import { stableStringify } from "./tokens/serialize";
import { detectDrift, emptyDrift } from "./tokens/drift";
import { styleGuards } from "./tokens/toFigma";
import { normalizePathKey, toDottedPath } from "./tokens/paths";
import { scanFile } from "./figma/scan";
import { scanStyles } from "./figma/scanStyles";
import { applyWrites, countConsumers, selectNodes } from "./figma/apply";

/**
 * Where user subtype tags live until Phase 6 gives us a git working copy.
 *
 * ADR-0002 §3 makes the committed token files the authority for `subtypeSource: "user"` tags on
 * re-import; with no sync path yet, `clientStorage` is the stand-in. `extractUserSubtypes` in
 * src/tokens/subtype.ts is the function Phase 6 will point at the real `tokens/` tree, at which
 * point this becomes a local cache rather than the source.
 *
 * The key is namespaced per Figma file. `clientStorage` is scoped to the plugin and shared
 * across every file it runs in, but Figma variable ids (`VariableID:1:4`) are only unique
 * *within* a file and are freely reused across them — so a single flat key would let a tag
 * from one file silently retype an unrelated variable in another.
 */
const SUBTYPE_STORAGE_PREFIX = "tokenvault:user-subtypes:";

/**
 * The Phase 4 stores (ADR-0004 §1). Same per-file namespacing, same reason, different durability.
 *
 * `EDIT_PREFIX` is the user's edits, as intent. Durable: never evicted, never silently dropped,
 * because it is the only thing in the plugin that cannot be re-derived by rescanning.
 *
 * `IMPORT_CACHE_PREFIX` is the last scan's result, so the Tokens tab has something to lay the
 * overlay over when the panel reopens. A cache in the strict sense: losing it costs a rescan and
 * nothing else, which is what makes `clientStorage`'s 5MB ceiling survivable when a single token
 * tree runs to ~700KB.
 */
const EDIT_PREFIX = "tokenvault:edits:";
const IMPORT_CACHE_PREFIX = "tokenvault:last-import:";

/** Which file the import cache currently holds, so a different file's cache can be evicted. */
const IMPORT_CACHE_OWNER_KEY = "tokenvault:last-import-owner";

/** Fallback file identity, stored on the document only when `figma.fileKey` is unavailable. */
const FILE_ID_PLUGIN_DATA_KEY = "tokenvault:file-id";

figma.showUI(__html__, { width: 460, height: 640 });

let snapshot: FileScan | null = null;
let userSubtypes: Record<string, SubtypeSelection> = {};
let fileIdentity: string | null = null;

/**
 * The pristine build — no overlay applied.
 *
 * Kept because every edit needs a `base` (ADR-0004 §2) and every revert needs somewhere to revert
 * *to*. Applying the overlay in place would destroy both, one edit at a time.
 */
let importResult: ImportResult | null = null;
let overlay: EditOverlay = emptyOverlay();
let pendingMerge: MergeSummary | undefined;
let importFromCache = false;

/** When the last real read of the Figma file happened — not when a tag was last edited. */
let lastScanAt: string | null = null;

/**
 * The drift baseline — the tree as of the last scan we have a record of (ADR-0005 §7).
 *
 * Held flattened rather than re-derived per scan: it is read once per scan and the flatten is the
 * expensive half. `baselineKnown` is deliberately separate from `baseline.length === 0`, because
 * "the cache was evicted" and "the file has no tokens" are different answers to *is anything
 * drifting?* and §8 refuses to collapse them.
 */
let baseline: FlatToken[] = [];
let baselineKnown = false;

/**
 * The repo's version of the tree — ADR-0006 §7's baseline swap.
 *
 * When present, this is what drift compares against, and drift stops being a changelog against a
 * local watermark and becomes divergence from the source of truth (PRD §6.5.3's actual sense).
 * `drift.ts` needs no new logic for that; it takes a baseline tree as an argument, and this is a
 * different argument.
 *
 * **In memory only, never persisted.** §3 refuses a second ~700KB blob in a 5MB store that already
 * holds the overlay and the import cache, for a tree one cheap request re-derives. The honest
 * consequence, and it is deliberate: a connected file whose repo content hasn't been fetched yet
 * this session falls back to the scan baseline and says so, rather than claiming a comparison it
 * hasn't made.
 */
let repoBaseline: FlatToken[] | null = null;
/** Whether this file currently has repo settings — the gate on accepting a repo drift baseline. */
let repoConnected = false;

/** Set when the repo baseline changed, so the next rebuild recomputes drift without a rescan. */
let driftDirty = false;

/** Whether there was anything to compare against at all. Unknown is not none (ADR-0005 §8). */
function driftKnown(): boolean {
  return repoBaseline !== null || baselineKnown;
}

/** The last scan's drift, carried to the UI on every emit so a refresh doesn't drop the badges. */
let drift: DriftResult = emptyDrift();

/**
 * Targets this plugin wrote in the apply that is about to be followed by a rescan.
 *
 * Without this, every apply would report itself as drift on the very next scan: the baseline still
 * holds the pre-apply value, and a target whose edit has just retired is no longer in the overlay,
 * so nothing else would exclude it. Deletion is the loudest version — removing a Variable on
 * purpose would come back as `drift-removed`, i.e. the plugin telling the user that someone
 * deleted the thing they just deleted.
 *
 * Drift means *someone else moved it*. Figma's own `documentchange` draws the same line — it never
 * notifies a plugin about changes that plugin caused — and this is that rule, applied to a
 * mechanism that has to infer authorship by comparison rather than being told.
 *
 * Consumed by the next scan and cleared, so it can never suppress a *later*, genuine change to the
 * same target.
 */
let justWrote = new Set<string>();

/**
 * The apply guards from the last scan, restored alongside the import cache.
 *
 * `styleGuards` and `nonLocalPaths` are derived from the *live* Figma read, so before Phase 5 they
 * had no way to survive a panel reopen: `emitImport` sent two empty collections and the plan built
 * from them refused nothing, because an unpopulated guard map answers every lookup with
 * `undefined`. Caching them alongside the tree they belong to keeps Apply usable on reopen without
 * forcing a rescan; `null` means the cache predates them, and Apply refuses until a scan runs.
 */
let cachedGuards: Array<[string, Refusal]> | null = null;
let cachedNonLocal: string[] | null = null;

/**
 * Guards against a subtype edit landing against a stale snapshot mid-scan, and against an
 * older scan overwriting a newer one if two are ever in flight.
 */
let scanSequence = 0;
let scanning = false;

function post(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

/**
 * A stable per-file identifier.
 *
 * `figma.fileKey` is the right answer and is available to plugins imported from a manifest
 * (development mode) or published privately to an organisation — which covers how Tokenvault is
 * meant to run. `figma.root.id` is deliberately not used as a fallback: it is `"0:0"` in every
 * Figma file, so it would silently reintroduce exactly the cross-file bleed this guards against.
 * The fallback instead mints an id once and keeps it on the document.
 */
function resolveFileIdentity(): string {
  if (fileIdentity !== null) return fileIdentity;

  let identity = figma.fileKey;
  if (!identity) {
    identity = figma.root.getPluginData(FILE_ID_PLUGIN_DATA_KEY);
    if (!identity) {
      identity = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      figma.root.setPluginData(FILE_ID_PLUGIN_DATA_KEY, identity);
    }
  }

  fileIdentity = identity;
  return identity;
}

function resolveStorageKey(): string {
  return SUBTYPE_STORAGE_PREFIX + resolveFileIdentity();
}

function editStorageKey(): string {
  return EDIT_PREFIX + resolveFileIdentity();
}

function importCacheKey(): string {
  return IMPORT_CACHE_PREFIX + resolveFileIdentity();
}

async function loadUserSubtypes(): Promise<Record<string, SubtypeSelection>> {
  const stored = await figma.clientStorage.getAsync(resolveStorageKey());
  if (stored === undefined || stored === null || typeof stored !== "object") return {};

  const result: Record<string, SubtypeSelection> = {};
  const record = stored as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === "string") result[key] = value as SubtypeSelection;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistence — ADR-0004 §1, §6
// ---------------------------------------------------------------------------

/**
 * Writes the overlay, dropping the import cache and retrying once on a quota rejection.
 *
 * The order is the decision (ADR-0004 §6): the cache is re-derivable by rescanning and the
 * overlay is not, so when 5MB runs out the cache is what goes. A rejection that survives the
 * retry is returned to the caller and surfaced — never swallowed, because an edit that silently
 * failed to persist is worse than one that refused to.
 */
async function persistOverlay(): Promise<string | undefined> {
  try {
    await figma.clientStorage.setAsync(editStorageKey(), overlay);
    return undefined;
  } catch (first) {
    try {
      await figma.clientStorage.deleteAsync(importCacheKey());
      await figma.clientStorage.setAsync(editStorageKey(), overlay);
      return undefined;
    } catch (second) {
      const reason = second instanceof Error ? second.message : String(second);
      return `Couldn't save your edits — plugin storage is full. ${reason}`;
    }
  }
}

/**
 * Caches the last scan so the Tokens tab has a tree on the next open.
 *
 * Written once per successful scan, never on an edit (ADR-0004 §6) — a 700KB write on a keystroke
 * is exactly the thing the two-store split exists to avoid. A failure here is not surfaced: the
 * cache is a convenience, and the fallback is the "scan the file first" state the tab already has.
 */
async function persistImportCache(result: ImportResult): Promise<void> {
  const owner = resolveFileIdentity();
  try {
    const previous = await figma.clientStorage.getAsync(IMPORT_CACHE_OWNER_KEY);
    if (typeof previous === "string" && previous !== owner) {
      await figma.clientStorage.deleteAsync(IMPORT_CACHE_PREFIX + previous);
    }
    await figma.clientStorage.setAsync(importCacheKey(), {
      version: 2,
      importedAt: lastScanAt,
      fileName: snapshot === null ? figma.root.name : snapshot.variables.fileName,
      result,
      // Cached with the tree rather than in a third store, for the same reason the tree *is* the
      // drift baseline: they describe the same scan and must never be restorable apart from it.
      styleGuards: snapshot === null ? [] : Array.from(styleGuards(snapshot.styles).entries()),
      nonLocalPaths: nonLocalPaths(),
    });
    await figma.clientStorage.setAsync(IMPORT_CACHE_OWNER_KEY, owner);
  } catch {
    // Best effort. Losing the cache costs one rescan; failing the scan over it costs the session,
    // so a half-written cache is cleared and the scan carries on.
    try {
      await figma.clientStorage.deleteAsync(importCacheKey());
    } catch {
      // Nothing left to try, and nothing depends on it.
    }
  }
}

interface CachedImport {
  importedAt: string | null;
  fileName: string;
  result: ImportResult;
  /** `null` for a v1 cache, written before the guards were part of it. Unknown, not empty. */
  styleGuards: Array<[string, Refusal]> | null;
  nonLocalPaths: string[] | null;
}

async function loadImportCache(): Promise<CachedImport | null> {
  try {
    const stored = await figma.clientStorage.getAsync(importCacheKey());
    if (stored === null || typeof stored !== "object") return null;
    const record = stored as {
      version?: unknown;
      result?: unknown;
      importedAt?: unknown;
      fileName?: unknown;
      styleGuards?: unknown;
      nonLocalPaths?: unknown;
    };
    // v1 is still readable — it just predates the guards, and losing a whole cached tree over a
    // field the payload marks as unknown anyway would cost a rescan for no safety gained.
    if (record.version !== 1 && record.version !== 2) return null;
    if (record.result === null || typeof record.result !== "object") return null;
    const result = record.result as ImportResult;
    if (!Array.isArray(result.files) || result.manifest === undefined) return null;
    return {
      importedAt: typeof record.importedAt === "string" ? record.importedAt : null,
      fileName: typeof record.fileName === "string" ? record.fileName : figma.root.name,
      result,
      styleGuards: Array.isArray(record.styleGuards)
        ? (record.styleGuards as Array<[string, Refusal]>)
        : null,
      nonLocalPaths: Array.isArray(record.nonLocalPaths) ? (record.nonLocalPaths as string[]) : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

/**
 * `refresh` marks a re-emit that is *not* a fresh read of the file — the same snapshot, re-derived
 * because an overlay change (resolving a conflict, discarding an orphan) altered what the report
 * says about a token. The UI keeps its tree expansion across one of these; a rescan resets it.
 */
function emitImport(fileName: string, refresh = false): void {
  if (!importResult) return;

  const files: SerializedFile[] = importResult.files.map((file) => ({
    path: file.path,
    json: stableStringify(file.content),
  }));

  // Live where there is a snapshot, restored from the cache where there isn't, `null` where neither
  // has them — never silently empty.
  const guards =
    snapshot === null ? cachedGuards : Array.from(styleGuards(snapshot.styles).entries());
  const nonLocal = snapshot === null ? cachedNonLocal : nonLocalPaths();

  post({
    type: "import-result",
    payload: {
      fileName,
      importedAt: lastScanAt ?? "",
      counts: importResult.counts,
      candidates: importResult.candidates,
      entries: importResult.report.entries,
      files,
      manifest: importResult.manifest,
      overlay,
      merge: pendingMerge,
      fromCache: importFromCache,
      refresh,
      drift: drift.entries,
      driftKnown: driftKnown(),
      styleGuards: guards ?? [],
      nonLocalPaths: nonLocal ?? [],
      // Empty-because-clean and empty-because-unasked are different answers to "what would this
      // write overwrite?", and only one of them may enable Apply — §8's rule, applied a second time.
      guardsKnown: guards !== null && nonLocal !== null,
      driftBaseline: repoBaseline === null ? "scan" : "repo",
    } satisfies ImportPayload,
  });
  pendingMerge = undefined;
}

/**
 * Paths that name a variable in a published team library — ADR-0005 §11's locality check.
 *
 * Not re-derived: `scan.ts` populates `aliasTargetNames` for exactly the alias targets that were
 * **not** in the local set, so this set is already the non-local one by construction. Every token
 * in the tree is local (the scan reads only `getLocalVariablesAsync`), which is why apply never
 * has to ask whether its *write* target is writable — only whether an *alias* target is.
 */
function nonLocalPaths(): string[] {
  if (snapshot === null) return [];
  const names = snapshot.variables.aliasTargetNames;
  return Object.keys(names).map((id) => normalizePathKey(toDottedPath(names[id])));
}

/**
 * Rebuilds from the current snapshot and reconciles the persisted overlay against it.
 *
 * This is ADR-0004 §4's merge point, and it sits deliberately *outside* `buildMergedImport`:
 * `build.ts` and `merge.ts` stay reproducible from Figma plus `userSubtypes` alone, and the
 * overlay is a declared transform layered on top rather than a hidden input to the build.
 */
async function rebuild(fromScan: boolean, refresh = false): Promise<void> {
  if (!snapshot) return;

  const result = buildMergedImport(snapshot, {
    userSubtypes,
    // Stamped from the last real scan, never from a subtype edit: `importedAt` claims the Figma
    // file was read at that moment, and retagging hours later does not re-read anything.
    importedAt: lastScanAt ?? new Date().toISOString(),
  });

  const flat = flattenImport(treeIndex(result.files), result.manifest);
  const now = new Date().toISOString();
  const merged = mergeOverlay(flat, overlay, now);

  // Drift is computed **before** the merge's outcome retires anything, and against the overlay as
  // it stood going in: a token carrying an edit is excluded here and reported as `edit-conflict`
  // by the merge instead (ADR-0005 §7). One mechanism widened, not two that can disagree.
  // Recomputed on a scan, and also when the repo baseline moved under us (ADR-0006 §7): connecting
  // a repo, or pulling one, changes what "drifted" *means* without the Figma file having moved at
  // all, and a stale drift set would keep describing the previous question.
  if (fromScan || driftDirty) {
    const edited = new Set(indexOverlay(overlay).keys());
    if (fromScan) {
      for (const key of justWrote) edited.add(key);
      justWrote = new Set();
    }
    const against = repoBaseline ?? baseline;
    const known = repoBaseline !== null || baselineKnown;
    drift = known ? detectDrift(against, flat, edited) : emptyDrift();
    driftDirty = false;
    if (fromScan) {
      // The scan watermark advances whether or not it is the drift baseline: disconnecting a repo
      // has to leave Phase 5's behaviour intact and immediately correct, not stale by one scan.
      baseline = flat;
      baselineKnown = true;
    }
  }

  const changed = stableStringify(merged.overlay) !== stableStringify(overlay);
  overlay = merged.overlay;

  // Drift rides the existing report rather than a parallel channel, which is what lets it inherit
  // the `⚑` badge, the flagged filter chip and the post-scan banner's `[ Review ]` for free
  // (UX §6.2) instead of growing a second attention vocabulary in a 460px column.
  const reported = merged.entries.concat(drift.report);
  if (reported.length > 0) {
    result.report.entries = result.report.entries.concat(reported);
    result.report.counts.flagged = result.report.entries.length;
    result.counts.flagged = result.report.entries.length;
  }
  // Absent, not zero, when there is no baseline — §8's "unknown is not none", all the way down.
  if (driftKnown()) {
    result.report.counts.drifted = drift.entries.length;
    result.counts.drifted = drift.entries.length;
  }
  result.report.counts.editsApplied = merged.applied;
  result.report.counts.editConflicts = merged.conflicts;
  result.counts.editsApplied = merged.applied;
  result.counts.editConflicts = merged.conflicts;

  importResult = result;
  importFromCache = false;
  // The merge summary belongs to a rescan (UX §5.5). A subtype retag rebuilds against the same
  // snapshot, so reporting "7 edits reapplied" there would announce an event that didn't happen.
  pendingMerge =
    fromScan &&
    merged.applied + merged.conflicts + merged.orphaned + merged.retired + drift.entries.length > 0
      ? {
          applied: merged.applied,
          conflicts: merged.conflicts,
          orphaned: merged.orphaned,
          retired: merged.retired,
          drifted: drift.entries.length,
        }
      : undefined;

  // Once per successful scan, never on an edit (ADR-0004 §6) — the 700KB write is exactly what
  // the two-store split exists to keep off the keystroke path.
  if (fromScan) await persistImportCache(result);
  if (changed) {
    const storageError = await persistOverlay();
    if (storageError !== undefined) post({ type: "overlay-state", overlay, storageError });
  }

  emitImport(snapshot.variables.fileName, refresh);
}

async function handleScan(): Promise<void> {
  const sequence = ++scanSequence;
  scanning = true;

  try {
    // One Figma-side read covering both sources (ADR-0003 §7). Issued together because they are
    // independent round trips and a partial pair is useless: the merge needs both.
    const [variables, styles] = await Promise.all([scanFile(), scanStyles()]);
    // A newer scan started while this one was in flight — let that one win.
    if (sequence !== scanSequence) return;
    snapshot = { variables, styles };
    lastScanAt = new Date().toISOString();
  } finally {
    if (sequence === scanSequence) scanning = false;
  }

  await rebuild(true);
}

async function handleSetSubtypes(subtypes: Record<string, SubtypeSelection | null>): Promise<void> {
  for (const variableId of Object.keys(subtypes)) {
    const selection = subtypes[variableId];
    // `null` clears the override entirely, handing the variable back to auto-detection.
    // `"untagged"` is itself a choice and is stored like any other.
    if (selection === null) delete userSubtypes[variableId];
    else userSubtypes[variableId] = selection;
  }

  await figma.clientStorage.setAsync(resolveStorageKey(), userSubtypes);

  // A scan in flight will emit once it lands, reading these tags then. Emitting now would
  // publish a result mixing the new tag with the pre-scan snapshot.
  if (!scanning) await rebuild(false);
}

// ---------------------------------------------------------------------------
// Overlay edits — the plugin side is a store, not an editor
// ---------------------------------------------------------------------------

/**
 * Persists an overlay change and echoes the result back.
 *
 * The UI applies edits to its own view model optimistically and immediately; this exists so the
 * change survives the session and so a storage failure reaches the user (ADR-0004 §6). Echoing
 * the whole overlay back — a few KB — keeps the two sides from drifting without retransmitting
 * the 700KB tree on every keystroke.
 */
async function commitOverlay(next: EditOverlay, resolvedFlag = false): Promise<void> {
  overlay = next;
  const storageError = await persistOverlay();
  post({ type: "overlay-state", overlay, storageError });

  // A conflict or orphan flag lives on the *import report*, not on the overlay, so clearing the
  // entry alone leaves the row's `⚑ conflict` badge and the Import tab's Flagged count claiming an
  // unresolved item until the next rescan. Re-derive so the flag clears on the same interaction.
  // Only on a resolution: an ordinary edit must not put a 700KB re-emit on the keystroke path.
  if (resolvedFlag && snapshot !== null && !scanning) await rebuild(false, true);
}

/** Whether the entries about to be dropped or rebased are carrying a merge flag. */
function carriesFlag(target: OverlayTarget, op: OverlayOp | undefined): boolean {
  const key = targetKey(target);
  if (key === null) return false;
  return overlay.entries.some(
    (entry) =>
      targetKey(entry.target) === key &&
      (op === undefined || entry.op === op) &&
      (entry.conflict !== undefined || entry.orphaned === true)
  );
}

async function handleEdit(entries: Array<Omit<OverlayEntry, "at">>): Promise<void> {
  const now = new Date().toISOString();
  let next = overlay;
  for (const entry of entries) next = recordEdit(next, entry, now);
  await commitOverlay(next);
}

async function handleRevert(targets: OverlayTarget[], op: OverlayOp | undefined): Promise<void> {
  const resolvedFlag = targets.some((target) => carriesFlag(target, op));
  let next = overlay;
  for (const target of targets) {
    next = op === undefined ? removeEntries(next, target) : dropEntry(next, target, op);
  }
  await commitOverlay(next, resolvedFlag);
}

/**
 * Drops exactly the named entries — the durable half of the Changes list's *Undo all*.
 *
 * Never `emptyOverlay()`. That button lives on a tab that filters conflicts out, so clearing the
 * whole store would silently discard resolutions the user was never shown under it. The UI sends
 * the list it rendered, and this drops that list and nothing else.
 */
async function handleRevertEntries(refs: EntryRef[]): Promise<void> {
  const resolvedFlag = refs.some((ref) => carriesFlag(ref.target, ref.op));
  await commitOverlay(dropEntries(overlay, refs), resolvedFlag);
}

// ---------------------------------------------------------------------------
// Writing to Figma — ADR-0005 §5, §6
// ---------------------------------------------------------------------------

/**
 * Applies a confirmed plan and rescans.
 *
 * The rescan is not housekeeping — **it is what retires the overlay** (§6). ADR-0004 §4's merge
 * table already says *"Value equals the entry's `value` → Figma caught up to the edit. Retire the
 * entry silently."* An applied edit is exactly that case, so applied entries retire through
 * existing code with no new retirement logic and no new lifecycle state. An entry that failed to
 * apply does not match, stays in the overlay, and stays visible — which is the whole reason this
 * needs no bookkeeping of its own.
 *
 * The report goes out *before* the rescan so the toast lands immediately rather than after a
 * full re-read of the file.
 */
async function handleApply(writes: PlannedWrite[], destructive: boolean): Promise<void> {
  if (writes.length === 0) {
    post({ type: "apply-result", report: { outcomes: [], applied: 0, failed: 0, destructive } });
    return;
  }

  const outcomes = await applyWrites(writes);
  const succeeded = new Set(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.key));
  // Only what actually landed. A write that failed did *not* move Figma, so if the value differs
  // from the baseline on the next scan it is genuinely someone else's change and must still report.
  for (const write of writes) {
    if (succeeded.has(write.key)) justWrote.add(write.targetKey);
  }

  const applied = outcomes.filter((outcome) => outcome.ok).length;
  const report: ApplyReport = {
    outcomes,
    applied,
    failed: outcomes.length - applied,
    destructive,
  };
  post({ type: "apply-result", report });

  // Even a fully failed apply rescans: something refused the write, and the tree the user is
  // looking at is the one that made a claim about Figma that turned out to be wrong.
  await handleScan();
}

/**
 * The delete flow — its own handler, never a branch inside `handleApply` (UX §10).
 *
 * `clearOverlayFor` is the confirmation's checked-by-default *"Also remove the token from the local
 * tree"*. Dropping the target's overlay entries is what that means in practice: the Variable is
 * gone, so the token leaves the tree on the next scan either way, and any edit still keyed to it
 * would otherwise surface as an `orphaned-edit` the user has to clean up after their own
 * deliberate deletion (UX §5.7, *Afterwards*).
 */
async function handleDeleteInFigma(
  writes: PlannedWrite[],
  clearOverlayFor: OverlayTarget[]
): Promise<void> {
  if (clearOverlayFor.length > 0) {
    let next = overlay;
    for (const target of clearOverlayFor) next = removeEntries(next, target);
    overlay = next;
    const storageError = await persistOverlay();
    post({ type: "overlay-state", overlay, storageError });
  }
  await handleApply(writes, true);
}

/**
 * What `[ Show them ]` actually managed, said in one line.
 *
 * Figma's selection is per-page, so consumers spread across pages cannot all be selected at once.
 * The count on the delete screen ("Used by 14 layers") counts every page, and a toast reading
 * "Selected 9 layers" against it would look like five layers had quietly gone missing — so the
 * remainder is named rather than dropped.
 */
function describeSelection(result: { selected: number; found: number; pages: number }): string {
  if (result.found === 0) return "Those layers aren't reachable any more.";
  const selected = `Selected ${result.selected} layer${result.selected === 1 ? "" : "s"}`;
  if (result.pages <= 1) return `${selected}.`;
  const elsewhere = result.found - result.selected;
  const others = result.pages - 1;
  return `${selected} on this page. ${elsewhere} more ${elsewhere === 1 ? "is" : "are"} on ${others} other page${others === 1 ? "" : "s"} — Figma can only select one page at a time.`;
}

// ---------------------------------------------------------------------------
// Git sync — ADR-0006 §1, §3, §5, §7
// ---------------------------------------------------------------------------

/**
 * The sandbox half of git sync: storage, and nothing else.
 *
 * `clientStorage` is sandbox-only and `fetch` is iframe-only, so the plugin controller owns the
 * connection and the credential while the iframe owns every request. Neither half can do the other's
 * job, which is why the PAT crosses the channel at all (§1) — the ADR says so rather than implying
 * otherwise, and the mitigation is that it crosses for one operation and is never stored on the
 * far side.
 */
async function loadGitConfig(): Promise<GitConfig> {
  const settings = parseSettings(await figma.clientStorage.getAsync(SETTINGS_KEY));
  repoConnected = settings !== null;
  const stored = parseSyncState(await figma.clientStorage.getAsync(syncKey(resolveFileIdentity())));
  const token = await figma.clientStorage.getAsync(PAT_KEY);
  return {
    settings,
    // A sync state for a different repo or branch is not a base — §9: *"a different branch is a
    // different base"*. Filtered on read rather than deleted on write, so switching branch and back
    // doesn't throw away a perfectly good base the user still had.
    sync: syncStateApplies(stored, settings) ? stored : null,
    hasToken: typeof token === "string" && token.length > 0,
  };
}

async function handleGitSaveSettings(
  settings: RepoSettings | null,
  token: string | undefined | null
): Promise<void> {
  if (token === null) {
    await figma.clientStorage.deleteAsync(PAT_KEY);
  } else if (typeof token === "string" && token.trim().length > 0) {
    await figma.clientStorage.setAsync(PAT_KEY, token.trim());
  }

  if (settings === null) {
    // Disconnect. The credential is cleared with the settings, and the sync state with it — but
    // nothing touches the tokens, the overlay, Figma, or the repo (UX §5.2). The one consequence
    // worth naming, and the prompt names it: drift goes back to comparing against the last scan.
    await figma.clientStorage.deleteAsync(SETTINGS_KEY);
    await figma.clientStorage.deleteAsync(PAT_KEY);
    await figma.clientStorage.deleteAsync(syncKey(resolveFileIdentity()));
    setRepoBaseline(null);
  } else {
    const next: RepoSettings = { ...settings };
    if (typeof token === "string" && token.trim().length > 0) {
      // Derived once, at save time, and stored beside the token — so rendering the masked field
      // never requires reading the PAT out of storage at all (§1).
      next.patLastFour = lastFour(token);
    } else if (token === null) {
      delete next.patLastFour;
    }
    await figma.clientStorage.setAsync(SETTINGS_KEY, next);
  }

  post({ type: "git-config", config: await loadGitConfig() });
  if (settings === null && snapshot !== null && !scanning) await rebuild(false, true);
}

async function handleGitSaveSync(state: SyncState | null): Promise<void> {
  const key = syncKey(resolveFileIdentity());
  if (state === null) await figma.clientStorage.deleteAsync(key);
  else await figma.clientStorage.setAsync(key, state);
  post({ type: "git-config", config: await loadGitConfig() });
}

/** Swaps the drift baseline — ADR-0006 §7. `null` reverts to Phase 5's scan watermark. */
function setRepoBaseline(files: SerializedFile[] | null): void {
  if (files === null) {
    if (repoBaseline === null) return;
    repoBaseline = null;
    driftDirty = true;
    return;
  }
  // A baseline fetch that resolves after the user disconnected must not silently re-point drift at
  // a repo this file is no longer connected to — the disconnect prompt promised the opposite (§7).
  if (importResult === null || !repoConnected) return;

  const trees = new Map<string, TokenGroup>();
  for (const file of files) {
    if (file.path.startsWith("tokens/$")) continue;
    try {
      trees.set(file.path, JSON.parse(file.json) as TokenGroup);
    } catch {
      // An unreadable repo file is named in the UI (UX §11) and excluded here. One bad file must
      // not cost the baseline for the eleven good ones.
    }
  }
  repoBaseline = flattenImport(trees, importResult.manifest);
  driftDirty = true;
}

/**
 * Lands a pull as overlay entries — ADR-0006 §5, and the phase's biggest saving.
 *
 * **Pull never writes to Figma.** It leaves pending entries, and getting them onto the canvas is
 * Phase 5's existing apply flow: the same preview modal, the same executor, the same per-entry
 * report. This is the second `ApplyPlan` producer ADR-0005 §1 built the seam for, and it arrives
 * without a second write path.
 */
async function handleGitPull(entries: Array<Omit<OverlayEntry, "at">>): Promise<void> {
  const merged = applyPull(overlay, entries, new Date().toISOString());
  overlay = merged.overlay;
  const storageError = await persistOverlay();
  post({ type: "overlay-state", overlay, storageError });
  post({ type: "git-pull-result", applied: merged.applied, conflicts: merged.conflicts });
  // A conflict flag lives on the import report, so the report has to be re-derived for the badge to
  // appear on the same interaction rather than after the next scan — same reason `commitOverlay`
  // does it for a resolution.
  if (snapshot !== null && !scanning) await rebuild(false, true);
}

function handleCopyTree(): void {
  if (!importResult) {
    post({ type: "tree-json", json: "", files: 0 });
    return;
  }
  const files = applyOverlayToFiles(importResult.files, overlay);
  const tree: Record<string, unknown> = {};
  for (const file of files) tree[file.path] = file.content;
  post({ type: "tree-json", json: JSON.stringify(tree, null, 2), files: files.length });
}

// ---------------------------------------------------------------------------

/**
 * Messages are handled strictly one at a time.
 *
 * Every overlay handler is read-modify-write over the module-level `overlay` and ends in an
 * `await figma.clientStorage.setAsync`. Dispatched concurrently, two edits sent a frame apart can
 * both read the pre-edit overlay, and whichever `setAsync` settles last wins — so the durable
 * store can end up holding the *first* edit's snapshot while the live session shows both. Queueing
 * costs nothing here (the handlers are short and user-paced) and removes the race entirely.
 */
let queue: Promise<void> = Promise.resolve();

figma.ui.onmessage = (message: UiToPluginMessage) => {
  const run = async (): Promise<void> => {
    if (message.type === "ui-ready") {
      userSubtypes = await loadUserSubtypes();
      overlay = parseOverlay(await figma.clientStorage.getAsync(editStorageKey()));
      post({ type: "plugin-ready", fileName: figma.root.name });
      // The connection, before the tree: the header chip's repo half and the Repo tab both have to
      // know whether this file is connected at all before they render anything (UX §6.1).
      post({ type: "git-config", config: await loadGitConfig() });

      // The overlay is durable and the import is not, so the panel can legitimately open with
      // edits and no tree (ADR-0004 §1). The cache is what stops that being the normal case.
      const cached = await loadImportCache();
      if (cached !== null) {
        importResult = cached.result;
        lastScanAt = cached.importedAt;
        importFromCache = true;
        // The cache *is* the drift baseline (ADR-0005 §7) — no third store. Restoring it here is
        // what lets the first scan of a session say what changed while the panel was closed.
        baseline = flattenImport(treeIndex(cached.result.files), cached.result.manifest);
        baselineKnown = true;
        cachedGuards = cached.styleGuards;
        cachedNonLocal = cached.nonLocalPaths;
        emitImport(cached.fileName);
      } else if (overlay.entries.length > 0) {
        post({ type: "overlay-state", overlay });
      }
      return;
    }
    if (message.type === "scan") {
      await handleScan();
      return;
    }
    if (message.type === "set-subtypes") {
      await handleSetSubtypes(message.subtypes);
      return;
    }
    if (message.type === "edit") {
      await handleEdit(message.entries);
      return;
    }
    if (message.type === "revert") {
      await handleRevert(message.targets, message.op);
      return;
    }
    if (message.type === "revert-entries") {
      await handleRevertEntries(message.entries);
      return;
    }
    if (message.type === "keep-mine") {
      // `keep-mine` only exists as a conflict resolution, so it always clears a flag.
      await commitOverlay(keepMine(overlay, message.target, message.op), true);
      return;
    }
    if (message.type === "copy-tree") {
      handleCopyTree();
      return;
    }
    if (message.type === "apply") {
      await handleApply(message.writes, false);
      return;
    }
    if (message.type === "delete-in-figma") {
      await handleDeleteInFigma(message.writes, message.clearOverlayFor);
      return;
    }
    if (message.type === "count-consumers") {
      post({ type: "consumer-counts", counts: await countConsumers(message.targets) });
      return;
    }
    if (message.type === "select-nodes") {
      figma.notify(describeSelection(await selectNodes(message.nodeIds)));
      return;
    }
    // --- Phase 6 (ADR-0006) ---

    if (message.type === "git-load") {
      post({ type: "git-config", config: await loadGitConfig() });
      return;
    }
    if (message.type === "git-save-settings") {
      await handleGitSaveSettings(message.settings, message.token);
      return;
    }
    if (message.type === "git-save-sync") {
      await handleGitSaveSync(message.state);
      return;
    }
    if (message.type === "git-request-token") {
      // The credential crosses the channel here and nowhere else — ADR-0006 §1. It is read on
      // demand rather than pushed with the config, so the iframe holds it only while an operation
      // that needs it is actually running.
      const token = await figma.clientStorage.getAsync(PAT_KEY);
      post({ type: "git-token", token: typeof token === "string" && token.length > 0 ? token : null });
      return;
    }
    if (message.type === "git-repo-baseline") {
      setRepoBaseline(message.files);
      // `driftDirty` survives if there is nothing to rebuild against yet, so the next rebuild
      // honours it. Reporting a baseline the panel has not actually compared against would be
      // exactly the "unknown read as none" lie ADR-0005 §8 spends a section refusing.
      if (driftDirty && snapshot !== null && !scanning) await rebuild(false, true);
      return;
    }
    if (message.type === "git-pull") {
      await handleGitPull(message.entries);
      return;
    }

    if (message.type === "copy-scan") {
      // `stableStringify` rather than `JSON.stringify` so a captured fixture has the same key
      // ordering as everything else in the repo and re-capturing it produces a readable diff.
      post({ type: "scan-snapshot", json: snapshot === null ? null : stableStringify(snapshot) });
    }
  };

  // The error handler is inside the chain so one failed message never breaks the queue: the next
  // message still runs, and the failure is reported rather than left as an unhandled rejection.
  queue = queue.then(() =>
    run().catch((error: unknown) => {
      scanning = false;
      post({ type: "import-error", message: error instanceof Error ? error.message : String(error) });
    })
  );
};
