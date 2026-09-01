import type { ImportPayload, PluginToUiMessage, SerializedFile, UiToPluginMessage } from "./messages";
import type { FileSnapshot, SubtypeSelection } from "./tokens/types";
import { buildImport } from "./tokens/build";
import { stableStringify } from "./tokens/serialize";
import { scanFile } from "./figma/scan";

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

/** Fallback file identity, stored on the document only when `figma.fileKey` is unavailable. */
const FILE_ID_PLUGIN_DATA_KEY = "tokenvault:file-id";

figma.showUI(__html__, { width: 460, height: 640 });

let snapshot: FileSnapshot | null = null;
let userSubtypes: Record<string, SubtypeSelection> = {};
let storageKey: string | null = null;

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
function resolveStorageKey(): string {
  if (storageKey !== null) return storageKey;

  let identity = figma.fileKey;
  if (!identity) {
    identity = figma.root.getPluginData(FILE_ID_PLUGIN_DATA_KEY);
    if (!identity) {
      identity = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      figma.root.setPluginData(FILE_ID_PLUGIN_DATA_KEY, identity);
    }
  }

  storageKey = SUBTYPE_STORAGE_PREFIX + identity;
  return storageKey;
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

function emitImport(): void {
  if (!snapshot) return;

  const result = buildImport(snapshot, {
    userSubtypes,
    // Stamped from the last real scan, never from a subtype edit: `importedAt` claims the Figma
    // file was read at that moment, and retagging hours later does not re-read anything.
    importedAt: lastScanAt ?? new Date().toISOString(),
  });

  const files: SerializedFile[] = result.files.map((file) => ({
    path: file.path,
    json: stableStringify(file.content),
  }));

  post({
    type: "import-result",
    payload: {
      fileName: snapshot.fileName,
      importedAt: lastScanAt ?? "",
      counts: result.counts,
      candidates: result.candidates,
      entries: result.report.entries,
      files,
    } satisfies ImportPayload,
  });
}

async function handleScan(): Promise<void> {
  const sequence = ++scanSequence;
  scanning = true;

  try {
    const next = await scanFile();
    // A newer scan started while this one was in flight — let that one win.
    if (sequence !== scanSequence) return;
    snapshot = next;
    lastScanAt = new Date().toISOString();
  } finally {
    if (sequence === scanSequence) scanning = false;
  }

  emitImport();
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
  if (!scanning) emitImport();
}

figma.ui.onmessage = (message: UiToPluginMessage) => {
  const run = async (): Promise<void> => {
    if (message.type === "ui-ready") {
      userSubtypes = await loadUserSubtypes();
      post({ type: "plugin-ready", fileName: figma.root.name });
      return;
    }
    if (message.type === "scan") {
      await handleScan();
      return;
    }
    if (message.type === "set-subtypes") {
      await handleSetSubtypes(message.subtypes);
    }
  };

  run().catch((error: unknown) => {
    scanning = false;
    post({ type: "import-error", message: error instanceof Error ? error.message : String(error) });
  });
};
