// Message contract between the plugin controller (code.ts) and the UI iframe (ui/main.ts).

import type { ReportEntry, Subtype, SubtypeCandidate } from "./tokens/types";

/** One generated file, already serialized deterministically, ready to display or copy. */
export interface SerializedFile {
  path: string;
  json: string;
}

export interface ImportPayload {
  fileName: string;
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
   * Re-run the conversion with a changed set of user subtype tags, without re-reading Figma.
   * A `null` value clears the tag and lets auto-detection take over again.
   */
  | { type: "set-subtypes"; subtypes: Record<string, Subtype | null> };

export type PluginToUiMessage =
  | { type: "plugin-ready"; fileName: string }
  | { type: "import-result"; payload: ImportPayload }
  | { type: "import-error"; message: string };
