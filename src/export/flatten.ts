// The expression-flattening pass — issue #17's one real design decision.
//
// Phase 7 stores two value shapes that look alike and behave differently (ADR-0007 §1):
//
//   - a **reference**, `{core.space.4}`, is byte-identical to Style Dictionary's own reference
//     syntax and passes through untouched. Rewriting it would be work that can only introduce bugs;
//   - an **expression**, `{core.space.4} * 2`, is a literal string Style Dictionary does not
//     understand. Handed over raw it emits the string into the CSS. So it is evaluated here, by
//     `expr.ts` through `resolve.ts` — the same evaluator and the same semantics the apply path
//     uses (ADR-0007 §4: unitless, no rounding, division by zero is an error), never a second
//     implementation that could drift from it.
//
// **Order is theme → references → expressions, and it has to be.** An expression's operands are
// resolved through the active theme's set stack (ADR-0007 §4), so `{brand.base} * 2` is a different
// number under `Light` than under `Dark`. Flattening before theme selection would compute one
// number and emit it into every theme's CSS — silently wrong in exactly the case themes exist for.
// So each theme gets its own `ResolveContext` and its own flattening pass, which mirrors how
// `plan.ts` orders the apply path.
//
// **Every failure is named, and every failure fails the build.** A `reference-cycle` renders as no
// value at all in the editor (ADR-0007 §3 — never a zero, never the last good number); the CSS
// equivalent of "no value at all" is not emitting the file. A dangling reference would land the
// literal `{a.b}` in the stylesheet, which is a bad value by any reading. The editor warns rather
// than refuses on a dangling reference (Shyam, 2026-09-03) because a designer is mid-edit; a build
// has no mid-edit, and shipping a stylesheet with `{a.b}` in it to a consumer is worse than not
// shipping one.

import type { Token } from "../tokens/types";
import type { FlatToken } from "../tokens/view";
import { buildResolveContext, resolveToken } from "../tokens/resolve";
import { cycleSummary } from "../tokens/graph";
import { collectValueReferences, isReference } from "../tokens/references";
import { normalizePathKey } from "../tokens/paths";
import { tokensInStack } from "../tokens/themes";
import { valueShape } from "../tokens/expr";
import type { ExportTheme } from "./themes";

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type ExportDiagnosticKind =
  /** The token sits on a reference/expression loop. No value exists for it (ADR-0007 §3). */
  | "reference-cycle"
  /** A parse failure, a non-numeric operand, or division by zero (ADR-0007 §4). */
  | "expression-error"
  /** A `{path}` naming a token this theme's stack does not define. */
  | "dangling-reference"
  /** Two tokens whose paths cannot both exist in one tree — `a.b` and `a.b.c`. */
  | "path-conflict";

export interface ExportDiagnostic {
  kind: ExportDiagnosticKind;
  theme: string;
  /** The dotted path of the token the diagnostic is about. */
  path: string;
  /** The set the offending token came from, where one token is to blame. */
  setId?: string;
  /** One sentence, already readable in a CI log. */
  message: string;
}

// ---------------------------------------------------------------------------
// The flattened result
// ---------------------------------------------------------------------------

/** One token as Style Dictionary will see it: `$extensions` gone, expressions already numbers. */
export interface ExportToken {
  path: string;
  segments: string[];
  /** Which set won this path in the theme's stack — carried for diagnostics, not for output. */
  setId: string;
  token: Pick<Token, "$type" | "$value"> & { $description?: string };
}

export interface FlattenResult {
  theme: ExportTheme;
  tokens: ExportToken[];
  diagnostics: ExportDiagnostic[];
}

/**
 * The tokens one theme resolves to, with every expression already a number.
 *
 * The merge is last-wins over the theme's `selectedTokenSets` (ADR-0002 §1), which is the same
 * merge `buildResolveContext` performs internally — so the tree handed to Style Dictionary and the
 * tree references resolve against are the same tree by construction, not by two agreeing rules.
 */
export function flattenTheme(all: FlatToken[], theme: ExportTheme): FlattenResult {
  const stack = theme.selectedTokenSets;
  const stackTokens = tokensInStack(all, stack);
  const context = buildResolveContext(stackTokens, all, { resolution: "last" });

  const diagnostics: ExportDiagnostic[] = [];
  const tokens: ExportToken[] = [];

  // Last-wins, and iteration order is `tokensInStack`'s stack order, so the last writer for a key
  // is the winner — the same entry `context.stack` holds.
  const winners = new Map<string, FlatToken>();
  for (const entry of stackTokens) winners.set(normalizePathKey(entry.path), entry);

  for (const entry of winners.values()) {
    const resolution = resolveToken(entry, context);

    if (resolution.kind === "cycle") {
      const loop =
        resolution.cycle === undefined ? entry.path : cycleSummary(context.graph, resolution.cycle);
      diagnostics.push({
        kind: "reference-cycle",
        theme: theme.name,
        path: entry.path,
        setId: entry.setId,
        message: `"${entry.path}" is on a reference loop (${loop}), so it has no value to export.`,
      });
      continue;
    }

    if (resolution.kind === "unresolved") {
      diagnostics.push({
        kind: "dangling-reference",
        theme: theme.name,
        path: entry.path,
        setId: entry.setId,
        message: `"${entry.path}" references "${resolution.target ?? "?"}", which theme "${theme.name}" does not define.`,
      });
      continue;
    }

    if (resolution.kind === "error") {
      diagnostics.push({
        kind: "expression-error",
        theme: theme.name,
        path: entry.path,
        setId: entry.setId,
        message: `"${entry.path}" could not be evaluated: ${resolution.error?.message ?? "unknown error"}`,
      });
      continue;
    }

    const shape = valueShape(entry.token);
    // A reference keeps its `{path}` string — Style Dictionary resolves it, and it has just been
    // proved resolvable above. An expression takes the number the evaluator produced. Everything
    // else, including a composite, keeps the value it was authored with.
    const value = shape === "expression" ? (resolution.value as number) : entry.token.$value;

    // A composite's sub-values can hold references too (a text style bound to a size variable,
    // ADR-0003 §4). Those also pass through to Style Dictionary, so they get the same existence
    // check the whole-value reference got — an unresolvable one would reach the CSS verbatim.
    const missing = danglingSubReferences(entry, shape, context.stack);
    if (missing.length > 0) {
      diagnostics.push({
        kind: "dangling-reference",
        theme: theme.name,
        path: entry.path,
        setId: entry.setId,
        message: `"${entry.path}" references ${missing.map((one) => `"${one}"`).join(", ")}, which theme "${theme.name}" does not define.`,
      });
      continue;
    }

    const token: ExportToken["token"] = { $type: entry.token.$type, $value: value };
    if (entry.token.$description !== undefined && entry.token.$description.length > 0) {
      token.$description = entry.token.$description;
    }
    tokens.push({ path: entry.path, segments: entry.segments.slice(), setId: entry.setId, token });
  }

  tokens.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { theme, tokens, diagnostics };
}

/**
 * References inside a composite `$value` that the theme's stack does not define.
 *
 * Whole-value references and expressions are already covered by `resolveToken`, so they are skipped
 * here rather than re-checked — reporting the same missing path twice under two kinds would make a
 * CI log read as two problems.
 */
function danglingSubReferences(
  entry: FlatToken,
  shape: ReturnType<typeof valueShape>,
  stack: Map<string, FlatToken>
): string[] {
  if (shape !== "literal") return [];
  if (isReference(entry.token.$value)) return [];

  const missing: string[] = [];
  for (const target of collectValueReferences(entry.token.$value)) {
    if (!stack.has(normalizePathKey(target)) && !missing.includes(target)) missing.push(target);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// The Style Dictionary input tree
// ---------------------------------------------------------------------------

/** A DTCG group as Style Dictionary consumes it — no `$extensions`, no Tokenvault provenance. */
export interface SdGroup {
  [segment: string]: SdGroup | ExportToken["token"];
}

export interface SdTreeResult {
  tokens: SdGroup;
  diagnostics: ExportDiagnostic[];
}

/**
 * The nested tree Style Dictionary is handed.
 *
 * Built here rather than reusing `setTokenAtPath` because that helper takes a `Token` — with the
 * `$extensions` block this output deliberately drops. The one behaviour worth copying from it is
 * the refusal: a path blocked by an ancestor leaf (`a.b` when `a.b.c` already exists, or the
 * reverse) is a `path-conflict` diagnostic, never a silent overwrite that would drop a token from
 * the CSS with nothing to show for it.
 */
export function toStyleDictionaryTokens(
  tokens: ExportToken[],
  themeName: string
): SdTreeResult {
  const root: SdGroup = {};
  const diagnostics: ExportDiagnostic[] = [];

  for (const entry of tokens) {
    const segments = entry.segments;
    let node = root;
    let blocked = false;

    for (let i = 0; i < segments.length - 1; i += 1) {
      const existing = node[segments[i]];
      if (existing === undefined) {
        const created: SdGroup = {};
        node[segments[i]] = created;
        node = created;
      } else if (isLeaf(existing)) {
        blocked = true;
        break;
      } else {
        node = existing;
      }
    }

    const leaf = segments[segments.length - 1];
    if (blocked || node[leaf] !== undefined) {
      diagnostics.push({
        kind: "path-conflict",
        theme: themeName,
        path: entry.path,
        setId: entry.setId,
        message: `"${entry.path}" cannot be written into the export tree — another token occupies part of that path.`,
      });
      continue;
    }
    node[leaf] = entry.token;
  }

  return { tokens: root, diagnostics };
}

function isLeaf(node: SdGroup | ExportToken["token"]): node is ExportToken["token"] {
  return typeof node === "object" && node !== null && "$value" in node;
}
