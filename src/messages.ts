// Message contract between the plugin controller (code.ts) and the UI iframe (ui/main.ts).

import type {
  ImportResultCounts,
  ReportEntry,
  SubtypeCandidate,
  SubtypeSelection,
} from "./tokens/types";

/** One generated file, already serialized deterministically, ready to display or copy. */
export interface SerializedFile {
  path: string;
  json: string;
}

export interface ImportPayload {
  fileName: string;
  /** ISO timestamp of the last real read of the Figma file; "" before the first scan. */
  importedAt: string;
  counts: ImportResultCounts;
  candidates: SubtypeCandidate[];
  entries: ReportEntry[];
  files: SerializedFile[];
}

export type UiToPluginMessage =
  | { type: "ui-ready" }
  /** Re-read the Figma file from scratch. */
  | { type: "scan" }
  /**
   * Re-run the conversion with a changed set of user subtype choices, without re-reading Figma.
   * `null` clears the choice and hands the variable back to auto-detection; `"untagged"` is the
   * deliberate choice of no subtype, which is a different thing and is remembered as one.
   */
  | { type: "set-subtypes"; subtypes: Record<string, SubtypeSelection | null> }
  /**
   * Hand back the raw `FileScan` from the last scan, so a real Figma file can be captured as a
   * test fixture. The import is only reproducible in CI if the *input* is committed too, and
   * there is no other way to get a live file's Variables and Styles out of the plugin sandbox.
   */
  | { type: "copy-scan" };

export type PluginToUiMessage =
  | { type: "plugin-ready"; fileName: string }
  | { type: "import-result"; payload: ImportPayload }
  /** The serialized `FileScan` requested by `copy-scan`; `null` before the first scan. */
  | { type: "scan-snapshot"; json: string | null }
  | { type: "import-error"; message: string };
