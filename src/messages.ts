// Message contract between the plugin controller (code.ts) and the UI iframe (ui/main.ts).

import type { EditOverlay, EntryRef, OverlayEntry, OverlayOp, OverlayTarget } from "./tokens/overlay";
import type {
  ImportResultCounts,
  Manifest,
  ReportEntry,
  SubtypeCandidate,
  SubtypeSelection,
} from "./tokens/types";
import type { DriftEntry } from "./tokens/drift";
import type { Refusal } from "./tokens/toFigma";
import type { ConsumerCount, PlannedWrite, WriteOutcome } from "./figma/apply";
import type { RepoSettings, SyncState } from "./git/types";

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
  /** Tokens Figma changed under us, added by Phase 5 to the same banner (UX §6.1). */
  drifted: number;
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

  // --- Phase 5 (ADR-0005) ---

  /**
   * What Figma changed since the baseline scan, for tokens carrying no local edit (§7).
   *
   * Sent alongside the report entries rather than folded into them because the tree needs the
   * *keys* to badge a value line, and the report is keyed by path — which a rename would break.
   */
  drift: DriftEntry[];
  /**
   * Whether a baseline existed to compare against at all.
   *
   * `false` means drift is **unknown**, not **none** (§8). The import cache is evictable by design
   * (ADR-0004 §6), and a "no drift detected" that actually meant "we had nothing to compare with"
   * would be the worst possible lie for this feature to tell — so the two states stay distinct all
   * the way to the chip.
   */
  driftKnown: boolean;
  /**
   * Styles apply must refuse, by `styleId` (ADR-0005 §3). Derived plugin-side from the scan, where
   * the live shape is known, and shipped to the UI so it can build a plan without a round trip.
   */
  styleGuards: Array<[string, Refusal]>;
  /** Normalised dotted paths naming a published-library variable — §11's up-front locality check. */
  nonLocalPaths: string[];
  /**
   * Whether the two fields above came from a scan at all.
   *
   * Both are collections whose *emptiness is meaningful*, and both are derived from the live Figma
   * read rather than from the token tree — so a payload restored from the import cache can carry
   * neither. `false` means "we never asked", which every apply path has to treat as a refusal
   * rather than as an all-clear: an unpopulated guard map passes every lookup made against it.
   */
  guardsKnown: boolean;

  // --- Phase 6 (ADR-0006) ---

  /**
   * What the drift baseline actually was — ADR-0006 §7's swap, reported rather than assumed.
   *
   * `"repo"` means drift is divergence from the source of truth and the block reads *In the repo* /
   * *Now in Figma*. `"scan"` is Phase 5's changelog against a local watermark, and keeps Phase 5's
   * wording. Both are live code paths: a file can be disconnected at any time, and a connected file
   * whose repo content hasn't been fetched this session legitimately has only the scan baseline
   * (§3 never persists the pulled tree). The labels follow this field, never a feature flag (UX §14).
   */
  driftBaseline: "repo" | "scan";
}

/** The connection, as the UI is allowed to know it — never including the PAT (ADR-0006 §1). */
export interface GitConfig {
  settings: RepoSettings | null;
  /** Present only when it still describes the configured repo and branch (`syncStateApplies`). */
  sync: SyncState | null;
  /** Whether a PAT is stored at all. The token itself crosses only on `git-token`. */
  hasToken: boolean;
}

/** What one apply run did, per entry (ADR-0005 §6 — a report, never a rollback). */
export interface ApplyReport {
  outcomes: WriteOutcome[];
  applied: number;
  failed: number;
  /** True for the delete flow, so the toast and the follow-up differ from a value apply. */
  destructive: boolean;
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
  /**
   * Drop a named list of `(target, op)` entries — the Changes list's *Undo all*.
   *
   * Deliberately a list rather than a "clear the overlay" verb. *Undo all* sits on the Local tab,
   * which filters conflicts out (they are resolved one at a time in their own tab), so a global
   * wipe would discard entries that button never showed the user. The scope of a bulk action is
   * whatever is on screen under it, and this message is that rule made unrepresentable otherwise.
   */
  | { type: "revert-entries"; entries: EntryRef[] }
  /** Resolve an `edit-conflict` by keeping the local value, rebased on Figma's (UX §5.5). */
  | { type: "keep-mine"; target: OverlayTarget; op: OverlayOp }
  /** The edited token tree, serialized — the only durable exit until Phase 6 (UX §5.4). */
  | { type: "copy-tree" }
  /**
   * Write a confirmed plan to Figma — ADR-0005 §6.
   *
   * The plan itself is built in the UI, because `plan.ts` is pure and the UI already holds the
   * tree and the overlay; the plugin's half is the write and the rescan that retires the entries.
   * **There is no code path to this message that does not pass through the apply dialog**
   * (UX §5.2, and §10's "assert it if that's cheap").
   */
  | { type: "apply"; writes: PlannedWrite[] }
  /**
   * Remove Variables or Styles from the file — ADR-0005 §5, its own message on purpose.
   *
   * UX §10: *"don't let a delete become an op in the apply batch"*. Separate message, separate
   * handler, separate confirmation, and no shared code path with `apply` beyond the executor.
   *
   * `clearOverlayFor` drops any local edits on the removed targets, which is the checked-by-default
   * "Also remove the token from the local tree" (UX §5.7) — without it those edits orphan on the
   * next scan and the user has to clean up after their own deliberate deletion.
   */
  | { type: "delete-in-figma"; writes: PlannedWrite[]; clearOverlayFor: OverlayTarget[] }
  /** The delete confirmation's blast radius. Expensive, so it runs only for that one screen. */
  | { type: "count-consumers"; targets: Array<{ key: string; variableId?: string; styleId?: string }> }
  /** `[ Show them ]` / `[ Details ]` — selects those nodes on the canvas (UX §5.5, §5.7). */
  | { type: "select-nodes"; nodeIds: string[] }

  // --- Phase 6 (ADR-0006) ---

  /** Hand back the stored connection. Sent once at startup and after every settings write. */
  | { type: "git-load" }
  /**
   * Persist the connection. `token` is the one field that may be absent meaning *leave it alone*
   * and `null` meaning *clear it* — a distinction the settings overlay needs, because editing a
   * repo URL must not silently drop a credential the field can never show back to the user.
   */
  | { type: "git-save-settings"; settings: RepoSettings | null; token?: string | null }
  /** The merge base after a successful sync, or `null` to invalidate it (§9's branch change). */
  | { type: "git-save-sync"; state: SyncState | null }
  /**
   * Ask for the PAT, for the duration of one operation — ADR-0006 §1.
   *
   * The sandbox owns `clientStorage`; the iframe owns `fetch`. There is no arrangement that avoids
   * the credential crossing this channel, so the ADR says so plainly and mitigates it in code: the
   * iframe holds it in a closure for one operation and drops it.
   */
  | { type: "git-request-token" }
  /**
   * The repo's `tokens/**` content, for the drift baseline — ADR-0006 §7.
   *
   * Held in memory only and never written to `clientStorage`: §3 refuses a second ~700KB blob in a
   * 5MB store to cache something one cheap request re-derives. `null` clears it, which is what a
   * disconnect does — and is why disconnecting visibly reverts drift to Phase 5's meaning.
   */
  | { type: "git-repo-baseline"; files: SerializedFile[] | null }
  /** Land a pull as overlay entries — ADR-0006 §5. Never a Figma write. */
  | { type: "git-pull"; entries: Array<Omit<OverlayEntry, "at">> };

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
  /**
   * The apply report — ADR-0005 §6.
   *
   * Every entry's outcome, success and failure alike. There is no rollback: a rollback pass has
   * the same failure modes as the pass it undoes, and a failed rollback leaves a state neither
   * side modelled. A precise per-entry report plus Figma's own undo is the honest answer.
   */
  | { type: "apply-result"; report: ApplyReport }
  /** Layer counts for the delete confirmation's blast radius (UX §5.7). */
  | { type: "consumer-counts"; counts: ConsumerCount[] }
  | { type: "import-error"; message: string }

  // --- Phase 6 (ADR-0006) ---

  | { type: "git-config"; config: GitConfig }
  /** The PAT, for one operation. Never rendered, never logged, never cached (ADR-0006 §1). */
  | { type: "git-token"; token: string | null }
  /** What landing a pull did to the overlay — the count the toast reports (UX §8.1). */
  | { type: "git-pull-result"; applied: number; conflicts: number };
