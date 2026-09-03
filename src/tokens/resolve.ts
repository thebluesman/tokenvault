// Theme-scoped resolution — ADR-0007 §4, §5, §6.
//
// Pure. Given the active theme's set stack and the tree, answers three questions the panel asks
// constantly and the apply plan asks once:
//
//   - what does this token's value *come out as* right now (a number, a colour, an error);
//   - is a candidate value the user is typing legal (§5's four rules);
//   - which tokens are on a cycle (via `graph.ts`, one implementation).
//
// The rule this module exists to hold is ADR-0007 §3's: **a cycle produces an error where a value
// would go — never a zero, never the last good number, never a partial evaluation.** Every branch
// below that could plausibly return a fallback returns a `Resolution` with no `value` instead. If
// a default ever appears in this file, it is the bug §7.1 was written to prevent.

import type { ReportEntry, Token, TokenValue } from "./types";
import type { FlatToken } from "./view";
import type { Cycle, ReferenceGraph } from "./graph";
import type { ExprError } from "./expr";
import {
  buildReferenceGraph,
  cycleFromCandidate,
  cycleSummary,
  findCycles,
  graphNodeKey,
  outgoingPaths,
} from "./graph";
import { emptyCycleIndex } from "./graph";
import type { CycleIndex } from "./graph";
import { evaluate, expressionReferences, parseExpression, valueShape } from "./expr";
import { isReference, referenceTarget } from "./references";
import { normalizePathKey } from "./paths";

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

/**
 * Everything resolution needs, built once per rebuild.
 *
 * `stackTokens` is the theme's sets **in order**, so the graph's path index is last-wins
 * (ADR-0002 §1). `allTokens` is the whole tree, and the two being different is precisely what makes
 * `unresolved-in-theme` distinguishable from `dangling-reference`: a path present in `allTokens`
 * and absent from the stack exists but does not resolve *here*, which warns; a path in neither is a
 * typo, which refuses (§5 rules 1 and 4).
 */
export interface ResolveContext {
  graph: ReferenceGraph;
  cycles: CycleIndex;
  /** `normalizePathKey(path)` → the token the stack resolves it to. */
  stack: Map<string, FlatToken>;
  /** `normalizePathKey(path)` → some token at that path, anywhere in the tree. */
  everywhere: Map<string, FlatToken>;
}

export function buildResolveContext(
  stackTokens: FlatToken[],
  allTokens: FlatToken[]
): ResolveContext {
  const graph = buildReferenceGraph(stackTokens, { resolution: "last" });
  const stack = new Map<string, FlatToken>();
  for (const entry of stackTokens) stack.set(normalizePathKey(entry.path), entry);

  const everywhere = new Map<string, FlatToken>();
  for (const entry of allTokens) {
    const key = normalizePathKey(entry.path);
    if (!everywhere.has(key)) everywhere.set(key, entry);
  }

  return { graph, cycles: findCycles(graph), stack, everywhere };
}

/** For the paths that never have a theme — a context over the whole tree, no stack filtering. */
export function buildFlatResolveContext(tokens: FlatToken[]): ResolveContext {
  return buildResolveContext(tokens, tokens);
}

export function emptyResolveContext(): ResolveContext {
  return {
    graph: { edges: new Map(), nodes: new Map(), index: new Map() },
    cycles: emptyCycleIndex(),
    stack: new Map(),
    everywhere: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Resolving one token
// ---------------------------------------------------------------------------

export type ResolutionKind =
  | "literal"
  /** A whole-value reference that resolved. `value` is the target's resolved literal. */
  | "reference"
  /** A math expression that evaluated. `value` is the number, computed for display only. */
  | "expression"
  /** On a cycle. **No value, ever** (§7.1). */
  | "cycle"
  /** The path names no token in the active theme's stack. Warns; the value still stands. */
  | "unresolved"
  /** Parse failure, non-numeric operand, division by zero. */
  | "error";

export interface Resolution {
  kind: ResolutionKind;
  /**
   * What the value comes out as, where it comes out as anything.
   *
   * **Absent on `cycle`, `unresolved` and `error`** — those are the three states where a number
   * would be a lie, and the absence is load-bearing rather than incidental.
   */
  value?: TokenValue;
  /** The reference target, for a `reference`, or the one that failed, for `unresolved`. */
  target?: string;
  /** The verbatim expression string, for `expression` and for an `error` that came from one. */
  expression?: string;
  cycle?: Cycle;
  error?: ExprError;
}

/**
 * What a token's value resolves to under the active theme.
 *
 * The cycle check comes **first**, before anything is evaluated, because it is what guarantees
 * evaluation terminates (ADR-0007 §1 — no depth limit, the cycle check is the stop).
 */
export function resolveToken(entry: FlatToken, context: ResolveContext): Resolution {
  const node = graphNodeKey(entry.setId, entry.path);
  if (context.cycles.nodes.has(node)) {
    return { kind: "cycle", cycle: cycleContaining(context, node) };
  }
  return resolveValue(entry.token, context);
}

/** The token's value, once it is known not to be on a cycle. Exported for candidate previews. */
export function resolveValue(
  token: Pick<Token, "$type" | "$value">,
  context: ResolveContext
): Resolution {
  const shape = valueShape(token);

  if (shape === "literal") return { kind: "literal", value: token.$value };

  if (shape === "reference") {
    const target = referenceTarget(token.$value) as string;
    const resolved = followReference(target, context, new Set());
    if (resolved === null) return { kind: "unresolved", target };
    if (resolved.cycle !== undefined) return { kind: "cycle", cycle: resolved.cycle, target };
    if (resolved.error !== undefined) return { kind: "error", target, error: resolved.error };
    return { kind: "reference", target, value: resolved.value };
  }

  const expression = token.$value as string;
  const evaluated = evaluate(expression, (path) => operand(path, context));
  if (!evaluated.ok) return { kind: "error", expression, error: evaluated.error };
  return { kind: "expression", expression, value: evaluated.value };
}

/** The loop a node sits on, for the block to render (§7.2). */
export function cycleContaining(context: ResolveContext, node: string): Cycle | undefined {
  for (const cycle of context.cycles.cycles) {
    if (cycle.nodes.indexOf(node) !== -1) return cycle;
  }
  return undefined;
}

interface Followed {
  value?: TokenValue;
  cycle?: Cycle;
  error?: ExprError;
}

/**
 * Walks a reference chain to the literal at the end of it.
 *
 * Chains are followed rather than capped (ADR-0007 §1): termination is the cycle check's job, and
 * `seen` here is the belt to that braces — a chain that loops without the graph having said so
 * would otherwise spin, which is the one failure mode worse than a wrong answer.
 *
 * Returns `null` when the chain runs off the end of the active theme's stack, which is
 * `unresolved-in-theme`, not an error.
 */
function followReference(
  path: string,
  context: ResolveContext,
  seen: Set<string>
): Followed | null {
  const key = normalizePathKey(path);
  if (seen.has(key)) {
    // The graph's cycle pass should have caught this already. It is repeated here because a chain
    // that spins produces no answer at all, which is strictly worse than a wrong one — and because
    // §7.1's "no fallback value" rule means the only safe thing to return is an error.
    return { error: { reason: "reference-loop", message: `${path} is part of a loop, so it has no value.` } };
  }
  seen.add(key);

  const target = context.stack.get(key);
  if (target === undefined) return null;

  const node = graphNodeKey(target.setId, target.path);
  if (context.cycles.nodes.has(node)) {
    return { cycle: cycleContaining(context, node) };
  }

  const shape = valueShape(target.token);
  if (shape === "literal") return { value: target.token.$value };

  if (shape === "reference") {
    return followReference(referenceTarget(target.token.$value) as string, context, seen);
  }

  const evaluated = evaluate(target.token.$value as string, (each) => operand(each, context));
  return evaluated.ok ? { value: evaluated.value } : { error: evaluated.error };
}

/**
 * One expression operand.
 *
 * Every operand must come out a number (ADR-0007 §1). A reference to a colour, a boolean or a
 * string is a **resolve-time** error with the operand named — the copy UX §5.2 and §6.4 share —
 * rather than a coercion, because `#c33a2e * 2` has no meaning anyone would want.
 */
function operand(path: string, context: ResolveContext): { ok: true; value: number } | { ok: false; error: ExprError } {
  const target = context.stack.get(normalizePathKey(path));
  if (target === undefined) {
    const anywhere = context.everywhere.get(normalizePathKey(path));
    return {
      ok: false,
      error: {
        reason: anywhere === undefined ? "operand-unknown" : "operand-unresolved-in-theme",
        message:
          anywhere === undefined
            ? `No token at ${path}. Nothing in any set has that path.`
            : `${path} has no value in the active theme, so this can't be worked out.`,
      },
    };
  }

  const resolved = followReference(target.path, context, new Set());
  if (resolved === null) {
    return {
      ok: false,
      error: {
        reason: "operand-unresolved-in-theme",
        message: `${path} has no value in the active theme, so this can't be worked out.`,
      },
    };
  }
  if (resolved.cycle !== undefined) {
    return {
      ok: false,
      error: { reason: "operand-cycle", message: `${path} is part of a loop, so it has no value.` },
    };
  }
  if (resolved.error !== undefined) return { ok: false, error: resolved.error };

  if (typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) {
    return {
      ok: false,
      error: {
        reason: "operand-not-number",
        message: `${path} is a ${target.token.$type}. Expressions only work with numbers.`,
      },
    };
  }
  return { ok: true, value: resolved.value };
}

// ---------------------------------------------------------------------------
// Authoring — ADR-0007 §5's four rules
// ---------------------------------------------------------------------------

export type AuthorOutcome =
  /** Committed with nothing to say. */
  | { ok: true }
  /** Committed, with a grey note. Rule 4, and the no-op nudge (UX §5.4, §6.5). */
  | { ok: true; warning: string; missingThemes?: string[]; swapTo?: string }
  /** Refused. Rules 1–3. The overlay entry is never written. */
  | { ok: false; reason: string; message: string; cycle?: Cycle };

export interface AuthorInput {
  /** The token being edited, for its `$type` and its identity in the graph. */
  entry: FlatToken;
  /** The raw string from the value field. */
  raw: string;
  context: ResolveContext;
  /** Every theme's stack, for rule 4's "which themes does this dangle in". */
  themeStacks?: Array<{ name: string; paths: Set<string> }>;
}

/**
 * All four of ADR-0007 §5's rules, run in order, **before** the overlay entry is written.
 *
 * Three refuse and one warns, and the asymmetry is deliberate rather than an oversight: rules 1–3
 * describe values that cannot be right in *any* theme; rule 4 describes a value that is right in
 * the theme you are working in and absent in another. Refusing rule 4 would make theme-specific
 * tokens impossible, which would make the theme feature and the reference feature mutually
 * exclusive (ADR-0007 §5, confirmed by Shyam 2026-09-03).
 */
export function checkAuthoredValue(input: AuthorInput): AuthorOutcome {
  const { entry, raw, context } = input;
  const trimmed = raw.trim();

  if (isReference(trimmed)) {
    return checkReference(trimmed, input);
  }

  // An expression evaluates to a number, so it can only ever be a `number` token's value
  // (ADR-0007 §1). The per-type editors route literals away before they reach here, so a
  // non-`number` token arriving with a formula is refused rather than committed as a string that
  // `toFigma` would then have to refuse at the write boundary instead.
  if (entry.token.$type !== "number") {
    return {
      ok: false,
      reason: "expression-on-non-number",
      message: `Expressions work out to a number, so a ${entry.token.$type} token can't hold one. Point it at a token with {…}, or type a ${entry.token.$type} value.`,
    };
  }

  const parsed = parseExpression(trimmed);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.error.reason, message: parsed.error.message };
  }

  const paths = referencePathsOf(trimmed);

  // Rule 1, per operand.
  for (const path of paths) {
    if (context.everywhere.get(normalizePathKey(path)) === undefined) {
      return {
        ok: false,
        reason: "reference-unknown",
        message: `No token at ${path}. Nothing in any set has that path.`,
      };
    }
  }

  // Rule 3, before evaluation — the cycle check is what guarantees evaluation terminates.
  const cycle = cycleFromCandidate(
    context.graph,
    graphNodeKey(entry.setId, entry.path),
    paths
  );
  if (cycle !== null) {
    return {
      ok: false,
      reason: "reference-cycle",
      message: "These tokens point in a loop.",
      cycle,
    };
  }

  // Rule 2, per operand: everything inside an expression must resolve to a number.
  for (const path of paths) {
    const target = context.stack.get(normalizePathKey(path));
    if (target === undefined) continue; // rule 4's business, not rule 2's.
    const resolvedOperand = operand(path, context);
    if (!resolvedOperand.ok && resolvedOperand.error.reason === "operand-not-number") {
      return {
        ok: false,
        reason: "reference-type-mismatch",
        message: resolvedOperand.error.message,
      };
    }
  }

  // The expression has to actually evaluate — division by zero is caught here and nowhere earlier.
  const evaluated = evaluate(trimmed, (path) => operand(path, context));
  if (!evaluated.ok && evaluated.error.reason === "divide-by-zero") {
    return { ok: false, reason: evaluated.error.reason, message: evaluated.error.message };
  }

  // Rule 4 — warn, commit anyway. Includes the active theme (ADR-0007 §5's second paragraph): the
  // only authoring-time refusal for a missing target is rule 1's.
  const missing = missingThemesFor(paths, input);
  if (missing.length > 0) {
    return {
      ok: true,
      warning: `Committed. ${paths.join(", ")} ${paths.length === 1 ? "isn't" : "aren't"} in ${listThemes(missing)}, so this token has no value there.`,
      missingThemes: missing,
    };
  }

  return { ok: true };
}

/** Rules 1–4 for a whole-value reference, where rule 2 compares `$type` rather than requiring a number. */
function checkReference(value: string, input: AuthorInput): AuthorOutcome {
  const { entry, context } = input;
  const target = referenceTarget(value) as string;
  const key = normalizePathKey(target);

  // Rule 1.
  const anywhere = context.everywhere.get(key);
  if (anywhere === undefined) {
    return {
      ok: false,
      reason: "reference-unknown",
      message: `No token at ${target}. Nothing in any set has that path.`,
    };
  }

  // Rule 3, before rule 2: a self-reference is a cycle, not a type match.
  const cycle = cycleFromCandidate(context.graph, graphNodeKey(entry.setId, entry.path), [target]);
  if (cycle !== null) {
    return {
      ok: false,
      reason: "reference-cycle",
      message: "These tokens point in a loop.",
      cycle,
    };
  }

  // Rule 2. Compared against the token the *active theme* resolves to where there is one, and
  // against the tree otherwise — a path that exists only outside the stack still has a `$type`, and
  // pointing a colour at a number is wrong in every theme.
  const typed = context.stack.get(key) ?? anywhere;
  if (typed.token.$type !== entry.token.$type) {
    return {
      ok: false,
      reason: "reference-type-mismatch",
      message: `${target} is a ${typed.token.$type}. This token is a ${entry.token.$type}, so it can't point there.`,
    };
  }

  // Rule 4.
  const missing = missingThemesFor([target], input);
  if (missing.length > 0) {
    return {
      ok: true,
      warning: `Committed. ${target} isn't in ${listThemes(missing)}, so this token has no value there.`,
      missingThemes: missing,
    };
  }

  return { ok: true };
}

/** The themes in which at least one of these paths does not resolve. */
function missingThemesFor(paths: string[], input: AuthorInput): string[] {
  const stacks = input.themeStacks;
  if (stacks === undefined || stacks.length === 0) return [];
  const missing: string[] = [];
  for (const theme of stacks) {
    for (const path of paths) {
      if (!theme.paths.has(normalizePathKey(path))) {
        missing.push(theme.name);
        break;
      }
    }
  }
  return missing;
}

function listThemes(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The paths a candidate value points at — one for a reference, every operand for an expression. */
export function referencePathsOf(raw: string): string[] {
  const trimmed = raw.trim();
  if (isReference(trimmed)) return [referenceTarget(trimmed) as string];
  const parsed = parseExpression(trimmed);
  return parsed.ok ? expressionReferences(parsed.value) : [];
}

// ---------------------------------------------------------------------------
// Per-theme path sets — rule 4's input
// ---------------------------------------------------------------------------

/** The normalised paths one theme's stack can resolve, for `checkAuthoredValue`'s rule 4. */
export function themePathSet(tokens: FlatToken[], stack: string[]): Set<string> {
  const sets = new Set(stack);
  const paths = new Set<string>();
  for (const entry of tokens) {
    if (sets.has(entry.setId)) paths.add(normalizePathKey(entry.path));
  }
  return paths;
}

/** Every token still pointing at something the whole tree doesn't have — reused by the report. */
export function outgoingUnknown(entry: FlatToken, context: ResolveContext): string[] {
  return outgoingPaths(entry.token).filter(
    (path) => context.everywhere.get(normalizePathKey(path)) === undefined
  );
}

// ---------------------------------------------------------------------------
// The build/merge report — ADR-0007 §3's second checkpoint, §5's three kinds
// ---------------------------------------------------------------------------

/**
 * Whole-graph pass, after every scan, pull or theme change.
 *
 * Three additive kinds, so `ImportReport.version` stays `1` (the precedent ADR-0003 §6 and
 * ADR-0004 §5 both set), and all three render through the existing `⚑ flagged` chip and row
 * badges. No new UI concept.
 *
 * **Every token on a loop gets its own entry, all carrying the same loop**, because the error state
 * is the cycle rather than the token: any one of them can be edited to break it, and singling out
 * one would send the user to what may be the least appropriate place to fix it.
 */
export function graphReport(
  tokens: FlatToken[],
  context: ResolveContext,
  themeStacks: Array<{ name: string; paths: Set<string> }> = []
): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const reportedCycleNodes = new Set<string>();

  for (const cycle of context.cycles.cycles) {
    const summary = cycleSummary(context.graph, cycle);
    for (const key of cycle.nodes) {
      const node = context.graph.nodes.get(key);
      if (node === undefined || reportedCycleNodes.has(key)) continue;
      reportedCycleNodes.add(key);
      entries.push({
        kind: "reference-cycle",
        reason: cycle.nodes.length === 1 ? "self-reference" : "circular-reference",
        message: `These tokens point in a loop: ${summary}. Nothing in the loop has a value, because each one is waiting on the next. Editing any one of them breaks it.`,
        path: node.path,
        set: node.setId,
      });
    }
  }

  for (const entry of tokens) {
    const node = graphNodeKey(entry.setId, entry.path);
    if (context.cycles.nodes.has(node)) continue;

    const resolved = resolveValue(entry.token, context);

    if (resolved.kind === "error") {
      entries.push({
        kind: "expression-error",
        reason: resolved.error?.reason ?? "expression-error",
        message: `"${String(entry.token.$value)}" can't be worked out: ${resolved.error?.message ?? "no reason recorded"}`,
        path: entry.path,
        set: entry.setId,
      });
      continue;
    }

    if (resolved.kind === "unresolved") {
      // The active theme's own gap. Named separately from the per-theme sweep below so the message
      // can say "here, now" rather than listing themes the user isn't looking at.
      entries.push({
        kind: "unresolved-in-theme",
        reason: "active-theme",
        message: `Points at ${resolved.target ?? "a token"}, which has no value in the active theme. Nothing is broken — this token just has no value while that theme is on.`,
        path: entry.path,
        set: entry.setId,
        omitted: resolved.target === undefined ? undefined : [resolved.target],
      });
      continue;
    }

    if (themeStacks.length === 0) continue;
    const paths = outgoingPaths(entry.token);
    if (paths.length === 0) continue;

    const missing = themeStacks
      .filter((theme) => paths.some((path) => !theme.paths.has(normalizePathKey(path))))
      .map((theme) => theme.name);
    if (missing.length === 0) continue;

    entries.push({
      kind: "unresolved-in-theme",
      reason: "other-themes",
      message: `${paths.join(", ")} ${paths.length === 1 ? "isn't" : "aren't"} in ${listThemes(missing)}, so this token has no value there. Nothing is broken.`,
      path: entry.path,
      set: entry.setId,
      omitted: missing,
    });
  }

  return entries;
}
