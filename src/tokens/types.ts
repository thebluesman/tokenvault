// Types for the Variables → token JSON import, per ADR-0002.
//
// Split into three layers:
//   1. Snapshot   — a plain-data mirror of the Figma Variables API surface, so the
//                   conversion logic never touches the `figma` global and stays testable.
//   2. Token JSON — the DTCG-compatible output shape (token files, manifest, report).
//   3. Build I/O  — the options and result of the pure conversion.

// ---------------------------------------------------------------------------
// 1. Snapshot (plain-data mirror of the Figma API)
// ---------------------------------------------------------------------------

/** Figma's `VariableResolvedDataType`, kept as a raw string so unknown/new types survive to the report. */
export type FigmaResolvedType = "BOOLEAN" | "COLOR" | "FLOAT" | "STRING" | "EASING" | "TIMING";

export interface RgbaSnapshot {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface AliasSnapshot {
  type: "VARIABLE_ALIAS";
  id: string;
}

/** A single `valuesByMode` entry, in the shape Figma hands it to us. */
export type VariableValueSnapshot = boolean | number | string | RgbaSnapshot | AliasSnapshot | null;

export interface ModeSnapshot {
  modeId: string;
  name: string;
}

export interface CollectionSnapshot {
  id: string;
  name: string;
  defaultModeId: string;
  modes: ModeSnapshot[];
}

export interface VariableSnapshot {
  id: string;
  name: string;
  collectionId: string;
  resolvedType: string;
  scopes: string[];
  description: string;
  valuesByMode: Record<string, VariableValueSnapshot>;
}

/**
 * Everything the importer needs from one Figma file.
 *
 * `aliasTargetNames` maps a variable id to its `/`-delimited name for alias targets that are
 * NOT in `variables` — i.e. variables imported from a team library. Without it a
 * `VARIABLE_ALIAS` to a library variable would be unnameable and get reported as unmappable.
 */
export interface FileSnapshot {
  fileName: string;
  fileKey: string;
  collections: CollectionSnapshot[];
  variables: VariableSnapshot[];
  aliasTargetNames: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 2. Token JSON output shape
// ---------------------------------------------------------------------------

export type TokenType = "color" | "number" | "boolean" | "string";

/** ADR-0002 §3. `unitless` and `duration` are number-only; `easing` is string-only. */
export type Subtype = "spacing" | "sizing" | "radius" | "opacity" | "duration" | "unitless" | "easing";

export type SubtypeSource = "auto" | "user" | "default";

/**
 * What the confirm/override step can send back for one variable.
 *
 * Three states, not two: a subtype, the explicit choice of *no* subtype, and (by the key being
 * absent altogether) "no human has said anything — auto-detect it". `"untagged"` is a decision,
 * so it is recorded with `subtypeSource: "user"` and survives a re-import the same way a real
 * tag does; without it, clearing a tag would silently fall back to the `spacing` guess.
 */
export type SubtypeSelection = Subtype | "untagged";

export interface TokenFigmaProvenance {
  variableId: string;
  collectionId: string;
  modeId: string;
  scopes: string[];
}

export interface TokenvaultExtension {
  subtype?: Subtype;
  subtypeSource?: SubtypeSource;
  figma: TokenFigmaProvenance;
}

export interface Token {
  $type: TokenType;
  $value: string | number | boolean;
  $description?: string;
  $extensions: { "com.tokenvault": TokenvaultExtension };
}

/** A nested DTCG group. A node is a `Token` if it has `$value`, otherwise a group. */
export interface TokenGroup {
  [segment: string]: TokenGroup | Token;
}

export interface ManifestMode {
  name: string;
  slug: string;
  set: string;
  $figmaModeId: string;
  file: string;
}

export interface ManifestCollection {
  name: string;
  slug: string;
  $figmaCollectionId: string;
  modes: ManifestMode[];
}

export interface ManifestTheme {
  name: string;
  selectedTokenSets: string[];
}

export interface Manifest {
  version: 1;
  generatedBy: "tokenvault";
  tokenSetOrder: string[];
  collections: ManifestCollection[];
  themes: ManifestTheme[];
}

export type ReportEntryKind =
  | "collision"
  | "unmappable-value"
  | "unsupported-type"
  /** File-scoped, not token-scoped: no participants, no path. Amendment 1 §C. */
  | "theme-composition"
  /** A token that WAS written, whose `$value` references something that was not. Amendment 1 §G. */
  | "dangling-reference";

/**
 * Which criterion decided a collision, so the report can justify itself (Amendment 1 §F).
 *
 * `variable-count` applies only to `set-slug`, where the contest is between collections.
 */
export type WinnerRule =
  | "alias-references"
  | "namespace-majority"
  | "name-order"
  | "variable-count";

export interface ReportParticipant {
  variableId: string;
  variableName: string;
  collectionId: string;
  collectionName: string;
  outcome: "written" | "skipped";
}

export interface ReportEntry {
  kind: ReportEntryKind;
  /** Narrower machine-readable cause, e.g. `same-set-case`, `token-group`, `cross-set`. */
  reason: string;
  /** Human-readable one-liner, safe to render straight into the UI. */
  message: string;
  /** The contested dotted token path, where the entry has one. */
  path?: string;
  /** Set identifier (`"<Collection>/<Mode>"`) where the entry is mode-specific. */
  set?: string;
  /** Collisions only: which criterion picked the winner (Amendment 1 §F). */
  winnerRule?: WinnerRule;
  /** Absent on file-scoped entries — `theme-composition` has no participants (Amendment 1 §C). */
  participants?: ReportParticipant[];
}

export interface ImportReport {
  version: 1;
  importedAt: string;
  figmaFileKey: string;
  counts: {
    tokens: number;
    flagged: number;
    unconfirmedSubtypes: number;
  };
  entries: ReportEntry[];
}

// ---------------------------------------------------------------------------
// 3. Build input/output
// ---------------------------------------------------------------------------

/** A number/string variable the user may want to tag, surfaced by the confirm/override step. */
export interface SubtypeCandidate {
  variableId: string;
  variableName: string;
  collectionName: string;
  /** `number` or `string` — determines which subtypes are offerable. */
  tokenType: "number" | "string";
  subtype?: Subtype;
  subtypeSource: SubtypeSource;
  scopes: string[];
  /** True when the importer guessed (`subtypeSource: "default"`) and nobody has confirmed. */
  needsConfirmation: boolean;
  /** A representative value, for display only. */
  sampleValue: string | number | boolean | null;
}

export interface BuildOptions {
  /** Explicit user choices, keyed by Figma variable id. Produce `subtypeSource: "user"`. */
  userSubtypes?: Record<string, SubtypeSelection>;
  /** ISO timestamp stamped into `$import-report.json`. Injected so builds are reproducible in tests. */
  importedAt: string;
}

export interface TokenFileOutput {
  /** Repo-relative path, e.g. `tokens/theme/light.json`. */
  path: string;
  /** The parsed JSON body. Serialize with `stableStringify` for the on-disk form. */
  content: TokenGroup | Manifest | ImportReport;
}

export interface ImportResult {
  files: TokenFileOutput[];
  manifest: Manifest;
  report: ImportReport;
  candidates: SubtypeCandidate[];
  counts: {
    collections: number;
    modes: number;
    variables: number;
    tokens: number;
    flagged: number;
    unconfirmedSubtypes: number;
  };
}
