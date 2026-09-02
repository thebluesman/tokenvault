// Message contract between the plugin controller (code.ts) and the UI iframe (ui/main.ts).

import type { EditOverlay, OverlayEntry, OverlayOp, OverlayTarget } from "./tokens/overlay";
import type {
  ImportResultCounts,
  Manifest,
  ReportEntry,
  SubtypeCandidate,
  SubtypeSelection,
} from "./tokens/types";

/** One generated file, already serialized deterministically, ready to display or copy. */
export interface SerializedFile {
  path: string;
  json: string;
}

/** What the rescan three-way merge did to the persisted overlay (ADR-0004 §4, UX §5.5). */
export interface MergeSummary {
  applied: number;
  conflicts: number;
  orphaned: number;
  retired: number;
}

export interface ImportPayload {
  fileName: string;
  /** ISO timestamp of the last real read of the Figma file; "" before the first scan. */
  importedAt: string;
  counts: ImportResultCounts;
  candidates: SubtypeCandidate[];
  entries: ReportEntry[];
  /**
   * The token files **as imported** — the overlay is not applied here. The Tokens tab parses
   * these into its view model and lays the overlay over them itself, so that the pristine values
   * stay available for "revert to imported value" and for the `base` of a new edit.
   */
  files: SerializedFile[];
  /** The set inventory and ordering the merged browser is keyed by (UX §4.2). */
  manifest: Manifest;
  overlay: EditOverlay;
  /** Present only when a rescan reconciled a non-empty overlay. */
  merge?: MergeSummary;
  /**
   * True when this result was restored from the `clientStorage` import cache rather than a live
   * scan (ADR-0004 §1). The Tokens tab is usable either way; the Import tab says which it is.
   */
  fromCache: boolean;
  /**
   * True when this payload was re-derived from the *same* snapshot rather than a fresh read —
   * emitted after a conflict or orphan resolution so the report's flags clear immediately. The
   * tree hasn't changed shape, so the UI keeps its expansion state instead of resetting it.
   */
  refresh?: boolean;
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
  | { type: "copy-scan" }
  /** Record one local edit, or a batch of them (a group delete is one message, many entries). */
  | { type: "edit"; entries: Array<Omit<OverlayEntry, "at">> }
  /** Drop the overlay entries for one target — all of them, or just one op. */
  | { type: "revert"; targets: OverlayTarget[]; op?: OverlayOp }
  /** Undo everything. The header chip's *Undo all*. */
  | { type: "revert-all" }
  /** Resolve an `edit-conflict` by keeping the local value, rebased on Figma's (UX §5.5). */
  | { type: "keep-mine"; target: OverlayTarget; op: OverlayOp }
  /** The edited token tree, serialized — the only durable exit until Phase 6 (UX §5.4). */
  | { type: "copy-tree" };

export type PluginToUiMessage =
  | { type: "plugin-ready"; fileName: string }
  | { type: "import-result"; payload: ImportPayload }
  /** The serialized `FileScan` requested by `copy-scan`; `null` before the first scan. */
  | { type: "scan-snapshot"; json: string | null }
  /**
   * The overlay after an edit, plus whether persisting it worked.
   *
   * `storageError` is never swallowed (ADR-0004 §6): an edit that silently failed to persist is
   * worse than one that refused to, so the UI surfaces it and keeps pointing at "copy the tree".
   */
  | { type: "overlay-state"; overlay: EditOverlay; storageError?: string }
  | { type: "tree-json"; json: string; files: number }
  | { type: "import-error"; message: string };
