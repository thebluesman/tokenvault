import type {
  ImportPayload,
  MergeSummary,
  PluginToUiMessage,
  SerializedFile,
  UiToPluginMessage,
} from "./messages";
import type { FileScan, ImportResult, SubtypeSelection } from "./tokens/types";
import type { EditOverlay, OverlayEntry, OverlayOp, OverlayTarget } from "./tokens/overlay";
import {
  applyOverlayToFiles,
  dropEntry,
  emptyOverlay,
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
import { scanFile } from "./figma/scan";
import { scanStyles } from "./figma/scanStyles";

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
      version: 1,
      importedAt: lastScanAt,
      fileName: snapshot === null ? figma.root.name : snapshot.variables.fileName,
      result,
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
}

async function loadImportCache(): Promise<CachedImport | null> {
  try {
    const stored = await figma.clientStorage.getAsync(importCacheKey());
    if (stored === null || typeof stored !== "object") return null;
    const record = stored as { version?: unknown; result?: unknown; importedAt?: unknown; fileName?: unknown };
    if (record.version !== 1 || record.result === null || typeof record.result !== "object") return null;
    const result = record.result as ImportResult;
    if (!Array.isArray(result.files) || result.manifest === undefined) return null;
    return {
      importedAt: typeof record.importedAt === "string" ? record.importedAt : null,
      fileName: typeof record.fileName === "string" ? record.fileName : figma.root.name,
      result,
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
    } satisfies ImportPayload,
  });
  pendingMerge = undefined;
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

  const changed = stableStringify(merged.overlay) !== stableStringify(overlay);
  overlay = merged.overlay;

  if (merged.entries.length > 0) {
    result.report.entries = result.report.entries.concat(merged.entries);
    result.report.counts.flagged = result.report.entries.length;
    result.counts.flagged = result.report.entries.length;
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
    fromScan && merged.applied + merged.conflicts + merged.orphaned + merged.retired > 0
      ? {
          applied: merged.applied,
          conflicts: merged.conflicts,
          orphaned: merged.orphaned,
          retired: merged.retired,
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

      // The overlay is durable and the import is not, so the panel can legitimately open with
      // edits and no tree (ADR-0004 §1). The cache is what stops that being the normal case.
      const cached = await loadImportCache();
      if (cached !== null) {
        importResult = cached.result;
        lastScanAt = cached.importedAt;
        importFromCache = true;
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
    if (message.type === "revert-all") {
      const resolvedFlag = overlay.entries.some(
        (entry) => entry.conflict !== undefined || entry.orphaned === true
      );
      await commitOverlay(emptyOverlay(), resolvedFlag);
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
