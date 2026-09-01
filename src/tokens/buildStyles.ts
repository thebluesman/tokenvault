// The Figma Styles → token candidate conversion — ADR-0003.
//
// Pure, and deliberately *not* an extension of build.ts: the two paths share almost no logic (no
// modes, no aliases-by-mode, no subtypes on the styles side) and what they do share is the pure
// helpers, which is the right seam (ADR-0003 §7).
//
// This module emits *candidates*, not files. Whether a candidate is written depends on contests
// it cannot see from here — against other style tokens and against Variables tokens — and
// ADR-0003 §7 puts that decision in one place, merge.ts, rather than splitting it across two
// builders.

import type {
  EffectStyleSnapshot,
  FigmaStyleType,
  GridStyleSnapshot,
  PaintStyleSnapshot,
  ReportEntry,
  ReportParticipant,
  StyleSnapshotBase,
  StylesSnapshot,
  TextStyleSnapshot,
  Token,
  TokenFigmaProvenance,
  TokenType,
  TokenValue,
} from "./types";
import { compareKeys } from "./serialize";
import { normalizePathKey, splitVariableName, toDottedPath } from "./paths";
import { toReference } from "./values";
import {
  gridValue,
  paintValue,
  shadowBoundVariables,
  shadowValue,
  textExtras,
  typographyValue,
} from "./styleValues";
import type { StyleValueResult } from "./styleValues";

/** ADR-0003 §1. `styles` is a reserved set-slug; merge.ts enforces that against collections. */
export const STYLES_DIR = "styles";

export interface StyleSetDefinition {
  kind: FigmaStyleType;
  /** Display name, and the second half of the set identifier. */
  name: string;
  /** File slug under `tokens/styles/`. */
  slug: string;
  set: string;
  file: string;
}

/** The four synthetic, mode-free sets, in the order they are written (ADR-0003 §1). */
export const STYLE_SETS: StyleSetDefinition[] = [
  { kind: "PAINT", name: "Paint", slug: "paint", set: "Styles/Paint", file: `${STYLES_DIR}/paint.json` },
  { kind: "TEXT", name: "Text", slug: "text", set: "Styles/Text", file: `${STYLES_DIR}/text.json` },
  { kind: "EFFECT", name: "Effect", slug: "effect", set: "Styles/Effect", file: `${STYLES_DIR}/effect.json` },
  { kind: "GRID", name: "Grid", slug: "grid", set: "Styles/Grid", file: `${STYLES_DIR}/grid.json` },
];

export function styleSetOf(kind: FigmaStyleType): StyleSetDefinition {
  const found = STYLE_SETS.filter((definition) => definition.kind === kind)[0];
  if (!found) throw new Error(`No style set defined for kind ${kind}`);
  return found;
}

/**
 * What the styles builder needs to know about the Variables side.
 *
 * Both fields exist for the same reason: a style token's relationship to a Variable is only
 * decidable with the Variables build in hand. The mirror rule (§4) needs to know a Variable was
 * actually written, and a bound paint needs the target's name to write a reference at all.
 */
export interface StyleBuildContext {
  /** Variable id → `/`-delimited name, including team-library targets a style binds. */
  variableNames: Map<string, string>;
  /** Dotted paths of Variables tokens the Variables build actually wrote. */
  writtenVariablePaths: Set<string>;
}

export interface StyleCandidate {
  kind: FigmaStyleType;
  setId: string;
  styleId: string;
  styleName: string;
  path: string;
  segments: string[];
  normalizedPath: string;
  token: Token;
}

export interface StylesBuildResult {
  candidates: StyleCandidate[];
  entries: ReportEntry[];
  counts: {
    /** Styles read, all four kinds, whether or not each produced a token. */
    styles: number;
    /** Candidates written but degraded — one per `partial-token` entry. */
    partialTokens: number;
  };
}

export function buildStyleTokens(
  snapshot: StylesSnapshot,
  context: StyleBuildContext
): StylesBuildResult {
  const candidates: StyleCandidate[] = [];
  const entries: ReportEntry[] = [];

  // Figma's return order from `getLocal*StylesAsync` is undocumented, and the output must not
  // depend on it (ADR-0002 Amendment 1 §F, applied to styles by ADR-0003 §7).
  const paint = sortStyles(snapshot.paint);
  const text = sortStyles(snapshot.text);
  const effect = sortStyles(snapshot.effect);
  const grid = sortStyles(snapshot.grid);

  for (const style of paint) convertPaint(style, context, candidates, entries);
  for (const style of text) convertText(style, context, candidates, entries);
  for (const style of effect) convertEffect(style, context, candidates, entries);
  for (const style of grid) convertGrid(style, candidates, entries);

  return {
    candidates,
    entries,
    counts: {
      styles: paint.length + text.length + effect.length + grid.length,
      partialTokens: entries.filter((entry) => entry.kind === "partial-token").length,
    },
  };
}

function sortStyles<T extends StyleSnapshotBase>(styles: T[]): T[] {
  return styles.slice().sort((a, b) => compareKeys(a.name, b.name) || compareKeys(a.id, b.id));
}

// ---------------------------------------------------------------------------
// Per-kind conversion
// ---------------------------------------------------------------------------

function convertPaint(
  style: PaintStyleSnapshot,
  context: StyleBuildContext,
  candidates: StyleCandidate[],
  entries: ReportEntry[]
): void {
  const target = pathOf(style, "PAINT", entries);
  if (!target) return;

  const result = paintValue(style);
  if (!record(result, style, "PAINT", target.path, entries)) return;

  const { paint, hex } = result.value;
  const provenance = provenanceOf(style, "PAINT");
  let value: TokenValue = hex;

  if (paint.boundVariableId !== undefined) {
    const targetName = context.variableNames.get(paint.boundVariableId);

    if (targetName === undefined) {
      // Bound, but unnameable — a deleted variable, or a library the file can no longer reach.
      // The literal is still true, so the token is written rather than dropped, and the lost
      // semantic link is reported.
      entries.push({
        kind: "partial-token",
        reason: "unresolved-binding",
        message: `Paint style "${style.name}" is bound to variable ${paint.boundVariableId}, which could not be named, so the colour was written as a literal and the link to the variable was lost.`,
        path: target.path,
        set: styleSetOf("PAINT").set,
        omitted: ["$value alias"],
        participants: [participantOf(style, "skipped")],
      });
    } else {
      const variablePath = toDottedPath(targetName);

      // ADR-0003 §4 — the provable mirror. Narrow on purpose: it fires only on a real binding at
      // the same path, never on a name match, because two things that merely share a name are
      // exactly the case a designer needs to see.
      if (variablePath === target.path && context.writtenVariablePaths.has(variablePath)) {
        entries.push({
          kind: "redundant-style",
          reason: "mirrors-variable",
          message: `Paint style "${style.name}" is bound to the variable "${targetName}", which already writes the token "${target.path}". The style adds nothing, so no duplicate token was written.`,
          path: target.path,
          set: styleSetOf("PAINT").set,
          participants: [participantOf(style, "skipped")],
        });
        return;
      }

      // The semantic link is the point; resolving it to hex would throw away exactly what the
      // tool exists to preserve (ADR-0003 §3).
      value = toReference(targetName);

      if (!context.writtenVariablePaths.has(variablePath)) {
        entries.push({
          kind: "dangling-reference",
          reason: "alias-target-skipped",
          message: `Paint style "${style.name}" references "${targetName}", which was not written to the token files, so the reference will not resolve until that is fixed in Figma.`,
          path: target.path,
          set: styleSetOf("PAINT").set,
          participants: [participantOf(style, "written")],
        });
      }

      provenance.boundVariables = { color: toReference(targetName) };
    }
  }

  candidates.push(candidate(style, "PAINT", target, token("color", value, style, provenance)));
}

function convertText(
  style: TextStyleSnapshot,
  context: StyleBuildContext,
  candidates: StyleCandidate[],
  entries: ReportEntry[]
): void {
  const target = pathOf(style, "TEXT", entries);
  if (!target) return;

  const result = typographyValue(style);
  if (!record(result, style, "TEXT", target.path, entries)) return;

  const provenance = provenanceOf(style, "TEXT");
  provenance.fontStyle = style.fontStyle;
  provenance.text = textExtras(style);

  const bound = boundVariableReferences(style.boundVariables, context);
  if (bound !== undefined) provenance.boundVariables = bound;

  candidates.push(
    candidate(style, "TEXT", target, token("typography", result.value, style, provenance))
  );
}

function convertEffect(
  style: EffectStyleSnapshot,
  context: StyleBuildContext,
  candidates: StyleCandidate[],
  entries: ReportEntry[]
): void {
  const target = pathOf(style, "EFFECT", entries);
  if (!target) return;

  const result = shadowValue(style);
  if (!record(result, style, "EFFECT", target.path, entries)) return;

  const provenance = provenanceOf(style, "EFFECT");
  const bound = boundVariableReferences(shadowBoundVariables(style), context);
  if (bound !== undefined) provenance.boundVariables = bound;

  candidates.push(candidate(style, "EFFECT", target, token("shadow", result.value, style, provenance)));
}

function convertGrid(
  style: GridStyleSnapshot,
  candidates: StyleCandidate[],
  entries: ReportEntry[]
): void {
  const target = pathOf(style, "GRID", entries);
  if (!target) return;

  const result = gridValue(style);
  if (!record(result, style, "GRID", target.path, entries)) return;

  candidates.push(
    candidate(style, "GRID", target, token("grid", result.value, style, provenanceOf(style, "GRID")))
  );
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface StylePath {
  path: string;
  segments: string[];
}

/**
 * `/`-delimited style names split into nested groups verbatim — the same `splitVariableName`,
 * the same rules, and no kind prefix (ADR-0003 §2). A paint style named `brand/primary` becomes
 * `brand.primary`, exactly as the equivalent Variable would.
 */
function pathOf(style: StyleSnapshotBase, kind: FigmaStyleType, entries: ReportEntry[]): StylePath | null {
  const segments = splitVariableName(style.name);
  if (segments.length === 0) {
    entries.push({
      kind: "unmappable-value",
      reason: "empty-path",
      message: `${label(kind)} style ${style.id} has a name that produces no token path ("${style.name}"). Not written.`,
      set: styleSetOf(kind).set,
      participants: [participantOf(style, "skipped")],
    });
    return null;
  }
  return { path: segments.join("."), segments };
}

/**
 * Turns a value conversion into report entries, and says whether a token follows.
 *
 * The two outcomes are deliberately different kinds: a failure is `unmappable-value` (nothing
 * written, PRD §11's "fail loud and specific"), while a partial success is `partial-token` — the
 * token exists but a reader of the JSON alone would not know what Figma still holds.
 */
function record<T>(
  result: StyleValueResult<T>,
  style: StyleSnapshotBase,
  kind: FigmaStyleType,
  path: string,
  entries: ReportEntry[]
): result is Extract<StyleValueResult<T>, { ok: true }> {
  const set = styleSetOf(kind).set;

  if (!result.ok) {
    entries.push({
      kind: "unmappable-value",
      reason: result.reason,
      message: `${label(kind)} style "${style.name}" ${result.message} Not written.`,
      path,
      set,
      participants: [participantOf(style, "skipped")],
    });
    return false;
  }

  if (result.omitted.length > 0) {
    entries.push({
      kind: "partial-token",
      reason: result.partialReason ?? partialReason(kind),
      message: `${label(kind)} style "${style.name}" was written, but ${result.note}.`,
      path,
      set,
      omitted: result.omitted.slice().sort(compareKeys),
      participants: [participantOf(style, "written")],
    });
  } else if (result.note.length > 0) {
    // A note with nothing omitted: the token carries every sub-key, but one of them is degraded
    // (an unmapped font style string kept as text where a number was wanted).
    entries.push({
      kind: "partial-token",
      reason: "unmapped-font-style",
      message: `${label(kind)} style "${style.name}" was written, but ${result.note}.`,
      path,
      set,
      participants: [participantOf(style, "written")],
    });
  }

  return true;
}

function partialReason(kind: FigmaStyleType): string {
  if (kind === "EFFECT") return "unsupported-effect";
  if (kind === "GRID") return "unsupported-grid";
  return "omitted-sub-value";
}

function candidate(
  style: StyleSnapshotBase,
  kind: FigmaStyleType,
  target: StylePath,
  value: Token
): StyleCandidate {
  return {
    kind,
    setId: styleSetOf(kind).set,
    styleId: style.id,
    styleName: style.name,
    path: target.path,
    segments: target.segments,
    normalizedPath: normalizePathKey(target.path),
    token: value,
  };
}

function token(
  type: TokenType,
  value: TokenValue,
  style: StyleSnapshotBase,
  figma: TokenFigmaProvenance
): Token {
  const result: Token = { $type: type, $value: value, $extensions: { "com.tokenvault": { figma } } };
  if (style.description.length > 0) result.$description = style.description;
  return result;
}

/**
 * Provenance for a style token — ADR-0003 §2.
 *
 * `subtype`/`subtypeSource` are absent by construction: style types are self-describing, so
 * there is no flag/tag step for Styles and no `SubtypeCandidate`s to confirm.
 */
function provenanceOf(style: StyleSnapshotBase, kind: FigmaStyleType): TokenFigmaProvenance {
  return { styleId: style.id, styleKey: style.key, styleType: kind };
}

/** Style-bound variables as `field → {dot.path}`, falling back to the raw id when unnameable. */
function boundVariableReferences(
  bound: Record<string, string>,
  context: StyleBuildContext
): Record<string, string> | undefined {
  const fields = Object.keys(bound).sort(compareKeys);
  if (fields.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const field of fields) {
    const name = context.variableNames.get(bound[field]);
    result[field] = name === undefined ? bound[field] : toReference(name);
  }
  return result;
}

export function participantOf(
  style: StyleSnapshotBase,
  outcome: "written" | "skipped"
): ReportParticipant {
  return {
    // Empty, not omitted: the precedent Amendment 1 §E set for collection participants, kept so
    // a report consumer can read every participant the same way (ADR-0003 §5).
    variableId: "",
    variableName: "",
    collectionId: "",
    collectionName: "",
    styleId: style.id,
    styleName: style.name,
    outcome,
  };
}

function label(kind: FigmaStyleType): string {
  return styleSetOf(kind).name;
}
