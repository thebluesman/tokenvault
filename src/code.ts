import type { ImportPayload, PluginToUiMessage, SerializedFile, UiToPluginMessage } from "./messages";
import type { FileSnapshot, Subtype } from "./tokens/types";
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
 */
const SUBTYPE_STORAGE_KEY = "tokenvault:user-subtypes";

figma.showUI(__html__, { width: 460, height: 640 });

let snapshot: FileSnapshot | null = null;
let userSubtypes: Record<string, Subtype> = {};

function post(message: PluginToUiMessage): void {
  figma.ui.postMessage(message);
}

async function loadUserSubtypes(): Promise<Record<string, Subtype>> {
  const stored = await figma.clientStorage.getAsync(SUBTYPE_STORAGE_KEY);
  if (stored === undefined || stored === null || typeof stored !== "object") return {};
  const result: Record<string, Subtype> = {};
  const record = stored as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === "string") result[key] = value as Subtype;
  }
  return result;
}

function emitImport(): void {
  if (!snapshot) return;

  const result = buildImport(snapshot, {
    userSubtypes,
    importedAt: new Date().toISOString(),
  });

  const files: SerializedFile[] = result.files.map((file) => ({
    path: file.path,
    json: stableStringify(file.content),
  }));

  const payload: ImportPayload = {
    fileName: snapshot.fileName,
    counts: result.counts,
    candidates: result.candidates,
    entries: result.report.entries,
    files,
  };

  post({ type: "import-result", payload });
}

async function handleScan(): Promise<void> {
  snapshot = await scanFile();
  emitImport();
}

async function handleSetSubtypes(subtypes: Record<string, Subtype | null>): Promise<void> {
  for (const variableId of Object.keys(subtypes)) {
    const subtype = subtypes[variableId];
    if (subtype === null) delete userSubtypes[variableId];
    else userSubtypes[variableId] = subtype;
  }
  await figma.clientStorage.setAsync(SUBTYPE_STORAGE_KEY, userSubtypes);
  emitImport();
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
    post({ type: "import-error", message: error instanceof Error ? error.message : String(error) });
  });
};
