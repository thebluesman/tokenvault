// Message contract between the plugin controller (code.ts) and the UI iframe (ui/main.ts).

import type { ReportEntry, SubtypeCandidate, SubtypeSelection } from "./tokens/types";

/** One generated file, already serialized deterministically, ready to display or copy. */
export interface SerializedFile {
  path: string;
  json: string;
}

export interface ImportPayload {
  fileName: string;
  /** ISO timestamp of the last real read of the Figma file; "" before the first scan. */
  importedAt: string;
  counts: {
    collections: number;
    modes: number;
    variables: number;
    tokens: number;
    flagged: number;
    unconfirmedSubtypes: number;
  };
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
  | { type: "set-subtypes"; subtypes: Record<string, SubtypeSelection | null> };

export type PluginToUiMessage =
  | { type: "plugin-ready"; fileName: string }
  | { type: "import-result"; payload: ImportPayload }
  | { type: "import-error"; message: string };
