// Types for the Variables → token JSON import (ADR-0002) and the Styles → token JSON import
// (ADR-0003).
//
// Split into three layers:
//   1. Snapshot   — a plain-data mirror of the Figma Variables and Styles API surfaces, so the
//                   conversion logic never touches the `figma` global and stays testable.
//   2. Token JSON — the DTCG-compatible output shape (token files, manifest, report).
//   3. Build I/O  — the options and result of the pure conversion.
//
// Everything ADR-0003 adds is *additive and optional*, deliberately: ADR-0002 §7 guarantees a
// re-import produces byte-identical files, and a newly required key on a shared interface would
// have changed the bytes of every token a Phase 2 file already wrote.

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
// 1b. Styles snapshot (ADR-0003 §7)
// ---------------------------------------------------------------------------

/** Figma's `StyleType`. Doubles as the `styleType` provenance value (ADR-0003 §2). */
export type FigmaStyleType = "PAINT" | "TEXT" | "EFFECT" | "GRID";

export interface StyleSnapshotBase {
  /** Local node id — the re-import matching key, the analogue of `variableId`. */
  id: string;
  /** The id that survives library publication; Phase 5's apply/drift path needs it. */
  key: string;
  /** `/`-delimited, exactly as Figma reports it. */
  name: string;
  description: string;
}

/**
 * One paint off a paint style.
 *
 * `type` is a raw string rather than a union so a paint type Figma adds later reaches the report
 * as `unmappable-value` instead of failing to compile or being silently coerced.
 */
export interface PaintSnapshot {
  type: string;
  visible: boolean;
  /** Figma defaults an absent `opacity` to 1; the scanner materialises that. */
  opacity: number;
  /** SOLID only. Figma's `RGB` has no alpha — effective alpha is `opacity`. */
  color?: RgbaSnapshot;
  /** `paint.boundVariables.color`, when the paint's colour is bound to a Variable. */
  boundVariableId?: string;
}

export interface PaintStyleSnapshot extends StyleSnapshotBase {
  paints: PaintSnapshot[];
}

export interface TextStyleSnapshot extends StyleSnapshotBase {
  fontFamily: string;
  /** Figma's free-text weight/slant name ("Semibold Italic"). Round-trip identity, ADR-0003 §3. */
  fontStyle: string;
  fontSize: number;
  letterSpacing: { value: number; unit: string };
  /** `value` is absent when `unit` is `AUTO`. */
  lineHeight: { value?: number; unit: string };
  textDecoration: string;
  textCase: string;
  leadingTrim: string;
  textWrapStyle: string;
  paragraphIndent: number;
  paragraphSpacing: number;
  listSpacing: number;
  hangingPunctuation: boolean;
  hangingList: boolean;
  /** Bindable text field → variable id. */
  boundVariables: Record<string, string>;
}

export interface EffectSnapshot {
  type: string;
  visible: boolean;
  /** Shadow effects only. */
  color?: RgbaSnapshot;
  offsetX?: number;
  offsetY?: number;
  radius: number;
  spread?: number;
  /** Bindable effect field (`color`, `radius`, `spread`, `offsetX`, `offsetY`) → variable id. */
  boundVariables: Record<string, string>;
}

export interface EffectStyleSnapshot extends StyleSnapshotBase {
  effects: EffectSnapshot[];
}

export interface LayoutGridSnapshot {
  pattern: string;
  visible: boolean;
  /** Present on ROWS/COLUMNS grids only; absent keys stay absent in the token (ADR-0003 §3). */
  alignment?: string;
  gutterSize?: number;
  count?: number;
  sectionSize?: number;
  offset?: number;
}

export interface GridStyleSnapshot extends StyleSnapshotBase {
  layoutGrids: LayoutGridSnapshot[];
}

/**
 * Every local style in the file, by kind.
 *
 * `boundVariableNames` is the Styles-side analogue of `FileSnapshot.aliasTargetNames`: a style
 * can bind a variable that lives in a team library, and without a name lookup that binding could
 * not be written as a reference.
 */
export interface StylesSnapshot {
  paint: PaintStyleSnapshot[];
  text: TextStyleSnapshot[];
  effect: EffectStyleSnapshot[];
  grid: GridStyleSnapshot[];
  boundVariableNames: Record<string, string>;
}

/** The single Figma-side read: Variables and Styles from one file (ADR-0003 §7). */
export interface FileScan {
  variables: FileSnapshot;
  styles: StylesSnapshot;
}

// ---------------------------------------------------------------------------
// 2. Token JSON output shape
// ---------------------------------------------------------------------------

/**
 * `typography` and `shadow` are DTCG composite types; `grid` is a declared divergence
 * (ADR-0003 §3) alongside ADR-0002 §4's `boolean` and `string`.
 */
export type TokenType =
  | "color"
  | "number"
  | "boolean"
  | "string"
  | "typography"
  | "shadow"
  | "grid";

/** DTCG `dimension`. `em` is only ever produced from Figma's percentage letter-spacing. */
export interface DimensionValue {
  unit: "px" | "em";
  value: number;
}

export interface TypographyValue {
  fontFamily: string;
  fontSize: DimensionValue;
  /** A 100–900 number, or the raw Figma style string when the keyword table has no entry. */
  fontWeight: number | string;
  letterSpacing: DimensionValue;
  /** Omitted entirely when Figma's line height is `AUTO` (ADR-0003 §3). */
  lineHeight?: number | DimensionValue;
}

export interface ShadowValue {
  blur: DimensionValue;
  color: string;
  inset: boolean;
  offsetX: DimensionValue;
  offsetY: DimensionValue;
  spread: DimensionValue;
}

export interface GridValue {
  pattern: "columns" | "rows" | "grid";
  alignment?: string;
  count?: number;
  gutter?: DimensionValue;
  offset?: DimensionValue;
  sectionSize?: DimensionValue;
}

export type TokenValue =
  | string
  | number
  | boolean
  | TypographyValue
  | ShadowValue
  | ShadowValue[]
  | GridValue[];

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

/**
 * Where a token came from in Figma.
 *
 * One interface with two disjoint halves, *structurally discriminated by which id is present*
 * (ADR-0003 §2). A `source`/`kind` discriminator key was rejected there because adding one would
 * change the bytes of every Variables-derived token and break ADR-0002 §7's byte-identical
 * re-import. `variableId` present ⇒ Variables half; `styleId` present ⇒ Styles half.
 */
export interface TokenFigmaProvenance {
  // --- Variables (ADR-0002 §3) ---
  variableId?: string;
  collectionId?: string;
  modeId?: string;
  scopes?: string[];

  // --- Styles (ADR-0003 §2) ---
  styleId?: string;
  styleKey?: string;
  styleType?: FigmaStyleType;
  /** Text styles: the raw `fontName.style`, which a numeric `fontWeight` cannot round-trip. */
  fontStyle?: string;
  /** Text styles: everything Figma carries that DTCG typography does not (ADR-0003 §3). */
  text?: Record<string, string | number | boolean>;
  /** Style-bound Variables, as `field → {dot.path}` (or the raw id when it cannot be named). */
  boundVariables?: Record<string, string>;
}

export interface TokenvaultExtension {
  subtype?: Subtype;
  subtypeSource?: SubtypeSource;
  figma: TokenFigmaProvenance;
}

export interface Token {
  $type: TokenType;
  $value: TokenValue;
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

/**
 * One synthetic, mode-free style set (ADR-0003 §1).
 *
 * No `$figmaCollectionId`/`$figmaModeId`: styles have neither, and there is nothing to point at.
 */
export interface ManifestStyleSet {
  file: string;
  kind: FigmaStyleType;
  name: string;
  set: string;
  slug: string;
}

export interface Manifest {
  /**
   * `1` — Variables only (ADR-0002). `2` — may carry `styleSets` (ADR-0003 §1). Bumped rather
   * than inferred so the Phase 8 export reader is told the contract changed.
   */
  version: 1 | 2;
  generatedBy: "tokenvault";
  tokenSetOrder: string[];
  collections: ManifestCollection[];
  /** Omitted on a v1 manifest, and on a v2 manifest for a file with no importable styles. */
  styleSets?: ManifestStyleSet[];
  themes: ManifestTheme[];
}

export type ReportEntryKind =
  | "collision"
  | "unmappable-value"
  | "unsupported-type"
  /** File-scoped, not token-scoped: no participants, no path. Amendment 1 §C. */
  | "theme-composition"
  /** A token that WAS written, whose `$value` references something that was not. Amendment 1 §G. */
  | "dangling-reference"
  /**
   * The token was written but one or more sub-values were not — auto line height, a blur inside
   * an effect style, an unmapped font style string. The composite-type analogue of
   * `subtypeSource: "default"`: imported, but degraded (ADR-0003 §6).
   */
  | "partial-token"
  /**
   * A paint style provably bound to a Variable at the same token path (ADR-0003 §4).
   * Informational, not a failure — a distinct kind so severity filters can drop it.
   */
  | "redundant-style"
  /**
   * A local edit and Figma both moved from the same `base` (ADR-0004 §4–5). The local edit is
   * applied — it is the only side that cannot be recovered by rescanning — and flagged.
   */
  | "edit-conflict"
  /** The Variable or Style a local edit targeted no longer exists in the file (ADR-0004 §4–5). */
  | "orphaned-edit";

/**
 * Which criterion decided a collision, so the report can justify itself (Amendment 1 §F).
 *
 * `variable-count` applies only to `set-slug`, where the contest is between collections.
 */
export type WinnerRule =
  | "alias-references"
  | "namespace-majority"
  | "name-order"
  | "variable-count"
  /**
   * ADR-0003 §5: a contest with participants from both sources is decided by source, not by
   * Amendment 1 §F's comparator — a Variable can be an alias target and a style token cannot, so
   * dropping the Variable cascades where dropping the style token cannot. Also the rule that
   * hands the reserved `styles/` directory to the style sets (ADR-0003 §1).
   */
  | "source-precedence";

/**
 * One side of a contest.
 *
 * Style participants leave `variableId`/`variableName` empty and carry `styleId`/`styleName`
 * instead — the precedent Amendment 1 §E set for collection participants (ADR-0003 §5).
 */
export interface ReportParticipant {
  variableId: string;
  variableName: string;
  collectionId: string;
  collectionName: string;
  styleId?: string;
  styleName?: string;
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
  /** `partial-token` only: the sub-keys that were not written (ADR-0003 §6). */
  omitted?: string[];
  /** Absent on file-scoped entries — `theme-composition` has no participants (Amendment 1 §C). */
  participants?: ReportParticipant[];
}

/**
 * Import tallies.
 *
 * The Styles-side counts are optional so the Variables-only build in `build.ts` keeps emitting
 * the exact ADR-0002 report shape; `merge.ts` always fills them (ADR-0003 §6).
 */
export interface ImportCounts {
  tokens: number;
  flagged: number;
  unconfirmedSubtypes: number;
  /** Styles read from the file, all four kinds, whether or not they produced a token. */
  styles?: number;
  /** Tokens written but degraded — `partial-token` entries. */
  partialTokens?: number;
  /** Local edits from the `clientStorage` overlay reapplied over this build (ADR-0004 §5). */
  editsApplied?: number;
  /** Of those, how many were `edit-conflict`s. */
  editConflicts?: number;
}

export interface ImportReport {
  version: 1;
  importedAt: string;
  figmaFileKey: string;
  counts: ImportCounts;
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

/** What the UI shows above the report. Styles-side keys are absent on a Variables-only build. */
export interface ImportResultCounts extends ImportCounts {
  collections: number;
  modes: number;
  variables: number;
  /** Style sets written, i.e. how many of the four kinds produced at least one token. */
  styleSets?: number;
  /** Tokens derived from styles, of the `tokens` total. */
  styleTokens?: number;
}

export interface ImportResult {
  files: TokenFileOutput[];
  manifest: Manifest;
  report: ImportReport;
  candidates: SubtypeCandidate[];
  counts: ImportResultCounts;
}
