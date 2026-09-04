import type {
  Appearance,
  ApplyReport,
  GitConfig,
  OverlayRecovery,
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
  applyOverlay,
  applyOverlayToFiles,
  dropEntries,
  dropEntry,
  emptyOverlay,
  indexOverlay,
  keepMine,
  mergeEvaluator,
  mergeOverlay,
  readOverlay,
  recordEdit,
  removeEntries,
  targetKey,
} from "./tokens/overlay";
import { flattenImport, treeIndex } from "./tokens/view";
import {
  multiModeCollections,
  themeModePlan,
  themeOnCanvas,
  themeSetStack,
  themeState,
  tokensInStack,
} from "./tokens/themes";
import { buildResolveContext, graphReport, themePathSet } from "./tokens/resolve";
import { currentPageModes, switchPageToModes } from "./figma/modes";
import { buildMergedImport } from "./tokens/merge";
import { makeRuleSetFile, parseRuleSet, type PathRule } from "./tokens/rules";
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

/**
 * Where an unreadable overlay blob is set aside — UX `error-states.md` §4.1.
 *
 * The overlay is the one thing in the plugin that cannot be re-derived (ADR-0004's opening
 * constraint), so a read that fails must not be followed by a write that destroys the evidence.
 * The blob is copied here *before* the session's first `setAsync` can overwrite the live key, and it
 * is never written to twice for the same file: a second corruption would otherwise bury the first
 * one's quarantine, which is the same silent-loss failure one layer down.
 */
const EDIT_QUARANTINE_PREFIX = "tokenvault:edits-unreadable:";

/**
 * The active theme, per file — ADR-0007 §7(a).
 *
 * A single string: the theme's name from `$manifest.json`'s `themes[]`. A few bytes on the same
 * `resolveFileIdentity()` scheme as every other per-file store, so ADR-0004 §6's quota story is
 * unchanged and the import cache is still the only large tenant.
 */
const ACTIVE_THEME_PREFIX = "tokenvault:active-theme:";

/**
 * The working copy of the committed rule set — ADR-0002 Amendment 2 §F.
 *
 * `clientStorage` holds it the way it holds the edit overlay: a few KB, negligible against
 * ADR-0004 §1's 5MB budget, and the *committed* `tokens/$rules.json` is the durable one.
 */
const PATH_RULES_PREFIX = "tokenvault:rules:";

/** Which file the import cache currently holds, so a different file's cache can be evicted. */
const IMPORT_CACHE_OWNER_KEY = "tokenvault:last-import-owner";

/** Fallback file identity, stored on the document only when `figma.fileKey` is unavailable. */
const FILE_ID_PLUGIN_DATA_KEY = "tokenvault:file-id";

/**
 * The panel's Appearance setting (UX `dark-mode.md` §2.3) — its own key, not per file, and not in
 * the tokens overlay: a personal display preference must never travel to someone else's checkout.
 * Absence means `"auto"`, which is why there is nothing to migrate for existing installs.
 */
const APPEARANCE_KEY = "tokenvault:appearance";

/**
 * `themeColors: true` is what makes dark mode possible at all (UX `dark-mode.md` §2): Figma stamps
 * a `figma-light` / `figma-dark` class on the iframe's `<html>` and injects a `<style>` block of
 * `--figma-color-*` variables, both updating live when the editor theme changes with the panel
 * open. There is no other supported way for a plugin to learn Figma's theme. It changes nothing
 * else — not sizing, not messaging, not the `ui-ready` handshake.
 */
figma.showUI(__html__, { width: 460, height: 640, themeColors: true });

let snapshot: FileScan | null = null;
let userSubtypes: Record<string, SubtypeSelection> = {};

/** The rule set in force for this file — Amendment 2 §A's third build input. */
let pathRules: PathRule[] = [];
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

/**
 * The theme the panel resolves against — ADR-0007 §7(a).
 *
 * Plugin state, not document state and not token data: picking a theme is a lens and writes
 * nothing anywhere (UX §8.3). `null` before the first read, and after a rescan that lost it — in
 * which case the fallback is reported rather than applied silently (`themeFellBackFrom`).
 */
let activeThemeName: string | null = null;

/**
 * A fallback that has not been reported yet — the same one-shot shape as `pendingMerge`.
 *
 * The stored name is rewritten as soon as the fallback happens, so the *state* is corrected
 * immediately and the *explanation* is delivered exactly once. Reporting it on every emit would
 * turn a one-time explanation into a recurring alarm; not reporting it at all would change every
 * displayed value with no explanation, which ADR-0007 §7a refuses.
 */
let pendingThemeFallback: string | undefined;

function post(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

/**
 * The one place `overlay-state` goes out, so the session's read-recovery rides every emit.
 *
 * Carried on every message rather than sent once: the UI's notice has to survive a rescan, a pull
 * and a tab switch, and re-attaching a small object is cheaper than a second lifecycle for it.
 */
function postOverlayState(storageError?: string): void {
  post({ type: "overlay-state", overlay, storageError, recovery: overlayRecovery });
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

function pathRulesKey(): string {
  return PATH_RULES_PREFIX + resolveFileIdentity();
}

function activeThemeKey(): string {
  return ACTIVE_THEME_PREFIX + resolveFileIdentity();
}

function quarantineKey(): string {
  return EDIT_QUARANTINE_PREFIX + resolveFileIdentity();
}

/**
 * What the session's overlay read cost, if anything — carried so the UI can be told once and keep
 * saying it. `undefined` for the overwhelmingly common case of a clean read.
 */
let overlayRecovery: OverlayRecovery | undefined;

/**
 * Reads the stored overlay, recovering what parses and setting aside what doesn't.
 *
 * The three-step order is the decision (`error-states.md` §4.1): recover, quarantine, *then* report.
 * Quarantining before the first write is what makes the report safe to be non-blocking — the user
 * can keep working, and the unreadable bytes are still there afterwards.
 */
async function loadOverlay(): Promise<EditOverlay> {
  const stored = await figma.clientStorage.getAsync(editStorageKey());
  const read = readOverlay(stored);
  if (read.outcome === "empty" || read.outcome === "ok") return read.overlay;

  let raw: string | null = null;
  try {
    raw = JSON.stringify(stored) ?? String(stored);
  } catch {
    // A blob that cannot even be serialized still has to be reported; it just can't be handed back.
    raw = null;
  }

  let stored_at: string | null = null;
  try {
    const existing = await figma.clientStorage.getAsync(quarantineKey());
    // Never overwrite an earlier quarantine — see the prefix's comment.
    if (existing === undefined || existing === null) {
      await figma.clientStorage.setAsync(quarantineKey(), stored);
    }
    stored_at = quarantineKey();
  } catch {
    // Quota, most likely. The report is the part that matters and it still goes out; it just says
    // the data could not be set aside, which is worse news honestly delivered.
    stored_at = null;
  }

  overlayRecovery = {
    outcome: read.outcome,
    kept: read.kept,
    dropped: read.dropped,
    quarantineKey: stored_at,
    raw,
  };
  return read.overlay;
}

async function loadPathRules(): Promise<PathRule[]> {
  try {
    return parseRuleSet(await figma.clientStorage.getAsync(pathRulesKey()));
  } catch {
    // A rule set that cannot be read is no rules, not a broken panel: the tree still builds, just
    // with the paths Figma's own names give it, and the editor can write a fresh set over it.
    return [];
  }
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

  const state = themeState(importResult.manifest, activeThemeName);
  const themes = state.themes;
  const active = state.active;
  const onCanvas = themeOnCanvas(importResult.manifest, themes, currentPageModes());

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
      // Sent with the tree so the rules editor and its preview (Amendment 2 §G) read the same set
      // the build used, rather than re-reading storage and possibly disagreeing with the paths on
      // screen.
      pathRules,
      themes,
      activeTheme: active === null ? null : active.name,
      themeFellBackFrom: pendingThemeFallback ?? state.fellBackFrom,
      // Read here rather than cached: the user can change page between two emits, and a stale
      // `on canvas` tag beside a theme is a claim about the document that has quietly stopped
      // being true.
      themeOnCanvas: onCanvas,
      multiModeCollections: multiModeCollections(importResult.manifest),
    } satisfies ImportPayload,
  });
  pendingMerge = undefined;
  pendingThemeFallback = undefined;
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
    // Amendment 2 §H: a build is a pure function of (scan, userSubtypes, pathRules). Read live from
    // the module-level rule set rather than baked into the tree, which is what makes "editing a
    // rule updates the paths without a re-import" a rebuild rather than a rescan.
    pathRules,
    // Stamped from the last real scan, never from a subtype edit: `importedAt` claims the Figma
    // file was read at that moment, and retagging hours later does not re-read anything.
    importedAt: lastScanAt ?? new Date().toISOString(),
  });

  const flat = flattenImport(treeIndex(result.files), result.manifest);
  const now = new Date().toISOString();

  // The active theme decides what every reference and expression resolves to (ADR-0002 §2 via
  // ADR-0007 §7), so it is settled *before* the merge — which needs an evaluator for §6's amended
  // expression row — and before the report, which needs the cycle set.
  const state = themeState(result.manifest, activeThemeName);
  if (state.fellBackFrom !== undefined) {
    pendingThemeFallback = state.fellBackFrom;
    try {
      await figma.clientStorage.setAsync(activeThemeKey(), state.active?.name ?? "");
    } catch {
      // The correction is in memory either way; losing the write costs it surviving a reopen.
    }
  }
  if (state.active !== null) activeThemeName = state.active.name;
  const stack = themeSetStack(result.manifest, state.active);
  // The evaluator resolves against the **effective** tree — `flat` plus the overlay going in — not
  // against the raw scan; `mergeEvaluator` owns that and says why. The report below builds its own
  // context against the merge's *output* overlay, which is a different tree on purpose.
  const merged = mergeOverlay(flat, overlay, now, {
    evaluate: mergeEvaluator(flat, overlay, stack),
  });

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
  // The whole-graph pass — ADR-0007 §3's second checkpoint. Run over the *effective* tree, so a
  // loop the user just authored in the overlay reports like one that arrived by scan or pull.
  const effective = applyOverlay(flat, overlay).tokens;
  const effectiveContext = buildResolveContext(tokensInStack(effective, stack), effective);
  const graphEntries = graphReport(
    effective,
    effectiveContext,
    state.themes.map((theme) => ({
      name: theme.name,
      paths: themePathSet(effective, theme.selectedTokenSets),
    }))
  );

  const reported = merged.entries.concat(drift.report).concat(graphEntries);
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
    if (storageError !== undefined) postOverlayState(storageError);
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
  postOverlayState(storageError);

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
    postOverlayState(storageError);
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

/**
 * The stored Appearance setting, defaulting to Auto — UX `dark-mode.md` §2.3.
 *
 * Anything unrecognised in the store reads as Auto rather than throwing: the worst outcome of a
 * corrupt display preference is that the panel follows Figma, which is the behaviour the user would
 * have got by never opening this setting.
 */
async function loadAppearance(): Promise<Appearance> {
  const stored = await figma.clientStorage.getAsync(APPEARANCE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
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
  postOverlayState(storageError);
  post({ type: "git-pull-result", applied: merged.applied, conflicts: merged.conflicts });
  // A conflict flag lives on the import report, so the report has to be re-derived for the badge to
  // appear on the same interaction rather than after the next scan — same reason `commitOverlay`
  // does it for a resolution.
  if (snapshot !== null && !scanning) await rebuild(false, true);
}

// ---------------------------------------------------------------------------
// Themes — ADR-0007 §7. A lens, and one deliberate document mutation
// ---------------------------------------------------------------------------

/**
 * Picks the theme the panel resolves against.
 *
 * Writes a few bytes and re-derives the report, and **touches nothing else** — not the canvas, not
 * the overlay, not the repo (UX §8.3). The rebuild is what makes values, flags and the cycle set
 * follow the new stack, all of which are theme-scoped by construction.
 */
async function handleSetActiveTheme(name: string): Promise<void> {
  activeThemeName = name;
  try {
    await figma.clientStorage.setAsync(activeThemeKey(), name);
  } catch {
    // A few bytes that failed to persist costs the selection surviving a reopen, and nothing else.
    // Refusing the lens change over it would be a worse trade than the one ADR-0004 §6 makes for
    // the import cache.
  }
  // A cache-restored tree has no snapshot to rebuild from, but it does have a tree — and the whole
  // point of the lens is that the panel re-resolves against it. So it re-emits either way.
  if (snapshot !== null && !scanning) await rebuild(false, true);
  else if (importResult !== null) emitImport(figma.root.name, true);
}

/**
 * Puts the current page into a theme's variable modes — the only Figma write in Phase 7.
 *
 * Not an apply and never routed through the apply dialog: it writes no token values, so the
 * confirmation would guard nothing, and a dialog that guards nothing is how users learn to click
 * through the ones that do (ADR-0007 §7c).
 *
 * Scope is the **current page**, which is not a preference but the API's shape: `PageNode` carries
 * `ExplicitVariableModesMixin` and `DocumentNode` does not, so there is no document-root
 * equivalent to choose instead. See `src/figma/modes.ts`.
 */
async function handleSwitchPageTheme(name: string): Promise<void> {
  if (importResult === null) return;
  const state = themeState(importResult.manifest, name);
  const theme = state.themes.filter((each) => each.name === name)[0] ?? null;
  const plan = themeModePlan(importResult.manifest, theme);
  const outcome = await switchPageToModes(plan.targets);
  post({
    type: "theme-switch-result",
    theme: name,
    switched: outcome.switched,
    failed: outcome.failed,
    unmapped: plan.unmapped,
  });
  // The `on canvas` tag is derived from the page's explicit modes, so it only becomes true after
  // the write. Re-emitting is what moves it.
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
      pathRules = await loadPathRules();
      overlay = await loadOverlay();
      const storedTheme = await figma.clientStorage.getAsync(activeThemeKey());
      activeThemeName = typeof storedTheme === "string" && storedTheme.length > 0 ? storedTheme : null;
      post({ type: "plugin-ready", fileName: figma.root.name, appearance: await loadAppearance() });
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
        // `import-result` carries the overlay but not how it was read, so a bad read still needs its
        // own message even when the tree arrived fine.
        if (overlayRecovery !== undefined) postOverlayState();
      } else if (overlay.entries.length > 0 || overlayRecovery !== undefined) {
        // A failed read is worth an emit on its own: with no cache and no surviving entries there is
        // otherwise no message on which the recovery notice could ride, and the one session that
        // most needs to hear about it is the one where nothing was recovered.
        postOverlayState();
      }
      return;
    }
    if (message.type === "set-appearance") {
      // Written and forgotten: the class is stamped by the UI the moment the control is tapped, so
      // this is durability only and nothing waits on it (UX `dark-mode.md` §2.3, "live, not on
      // next open").
      if (message.appearance === "auto") await figma.clientStorage.deleteAsync(APPEARANCE_KEY);
      else await figma.clientStorage.setAsync(APPEARANCE_KEY, message.appearance);
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

    // --- Phase 7 (ADR-0007) ---

    if (message.type === "set-path-rules") {
      // §G: the preview is the editor's job and has already happened by the time this arrives —
      // this is the write, and it rebuilds rather than rescans, because the rules are a pure
      // function of names the last scan already read.
      pathRules = message.rules;
      try {
        await figma.clientStorage.setAsync(pathRulesKey(), makeRuleSetFile(pathRules));
      } catch {
        // In memory either way; losing the write costs it surviving a reopen, not this session.
      }
      await rebuild(false, true);
      return;
    }

    if (message.type === "set-active-theme") {
      await handleSetActiveTheme(message.name);
      return;
    }
    if (message.type === "switch-page-theme") {
      await handleSwitchPageTheme(message.name);
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
      const detail = error instanceof Error ? error.message : String(error);
      // Two destinations, not one — UX `error-states.md` §3.3. A failed *scan* is a named, expected,
      // retryable failure of one operation and gets §2's notice on the Import tab. Anything else
      // that threw is by definition unexpected: nothing designed a state for it, the operation's
      // outcome is unknown, and reporting it as "import failed" sent the user to the wrong tab with
      // a sentence about the wrong thing.
      if (message.type === "scan") post({ type: "import-error", message: detail });
      else post({ type: "plugin-error", message: detail, source: message.type });
    })
  );
};
