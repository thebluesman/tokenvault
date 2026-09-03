// Math expressions — ADR-0007 §1, §2.
//
// Pure: tokenize → parse → evaluate, with no view of the tree. The resolver for `{a}` operands is
// injected, because *what a path resolves to* is theme-scoped (ADR-0002 §2) and belongs to
// `resolve.ts`; this module only knows arithmetic.
//
// Three things here are load-bearing and easy to erode:
//
//   1. **`isReference` is not widened** (ADR-0007 §1). `{a}` is an alias and keeps a live Figma
//      link; `{a} * 1` is an expression and flattens to a number. Recognising them together would
//      be silent data loss in a designer's file, so `valueShape` asks `references.ts` first and
//      only then considers an expression.
//   2. **The string is the value** (§2). Nothing here ever produces a value to store — `evaluate`
//      is for display and for the apply write, and the caller never writes the number back into
//      `$value`.
//   3. **Errors are values, never exceptions.** Same rule as `toFigma.ts`'s `Refusal`: a parse
//      failure has to reach the user as the sentence UX §6.4 wrote, not as whatever a throw
//      stringifies to.

import type { Token } from "./types";
import { isReference } from "./references";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Machine-readable slug plus the sentence the field renders (UX §6.4's table). */
export interface ExprError {
  reason: string;
  message: string;
}

export type ExprResult<T> = { ok: true; value: T } | { ok: false; error: ExprError };

function fail<T>(reason: string, message: string): ExprResult<T> {
  return { ok: false, error: { reason, message } };
}

function ok<T>(value: T): ExprResult<T> {
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// The AST
// ---------------------------------------------------------------------------

export type BinaryOp = "+" | "-" | "*" | "/";

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "reference"; path: string }
  | { kind: "negate"; operand: ExprNode }
  | { kind: "binary"; op: BinaryOp; left: ExprNode; right: ExprNode };

// ---------------------------------------------------------------------------
// Recognition — ADR-0007 §1's three shapes
// ---------------------------------------------------------------------------

export type ValueShape = "literal" | "reference" | "expression";

/**
 * Which of ADR-0007 §1's three shapes a token's `$value` is.
 *
 * **Type-aware, deliberately.** A `string` token holding `"Regular - Italic"` is a literal, not a
 * subtraction, and a recogniser that decided on the string alone would turn a font style into a
 * parse error. Expressions exist only where the result could be one: a `number` token whose value
 * arrived as a string. Everything else that is a string and not a reference is a literal.
 *
 * Composite sub-keys are out of scope (ADR-0007 §10), so a `typography`/`shadow`/`grid` token is
 * never an expression however its sub-values read.
 */
export function valueShape(token: Pick<Token, "$type" | "$value">): ValueShape {
  if (isReference(token.$value)) return "reference";
  if (token.$type === "number" && typeof token.$value === "string") return "expression";
  return "literal";
}

/** True when this string, on a `number` token, would be parsed as an expression rather than stored. */
export function isExpressionValue(token: Pick<Token, "$type" | "$value">): boolean {
  return valueShape(token) === "expression";
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { kind: "number"; value: number; text: string }
  | { kind: "reference"; path: string }
  | { kind: "op"; op: BinaryOp }
  | { kind: "lparen" }
  | { kind: "rparen" };

const DIGIT = /[0-9]/;
const IDENT = /[A-Za-z_%]/;

/**
 * Lexes an expression string.
 *
 * The two error branches carry more weight than the happy path, because they are the ones UX §6.4
 * writes copy for: a unit glued to a number (`4px`), and an identifier that is trying to be a
 * function call (`round(`). Both are legal-looking and both have a specific, non-obvious reason for
 * being refused, so neither is allowed to fall through to a generic "unexpected character".
 */
function tokenize(input: string): ExprResult<Tok[]> {
  const out: Tok[] = [];
  let at = 0;

  while (at < input.length) {
    const char = input[at];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      at += 1;
      continue;
    }

    if (char === "(") {
      out.push({ kind: "lparen" });
      at += 1;
      continue;
    }
    if (char === ")") {
      out.push({ kind: "rparen" });
      at += 1;
      continue;
    }

    if (char === "+" || char === "-" || char === "*" || char === "/") {
      out.push({ kind: "op", op: char });
      at += 1;
      continue;
    }

    if (char === "{") {
      const close = input.indexOf("}", at);
      if (close === -1) {
        return fail("unclosed-reference", "Unfinished reference — this `{` has no closing `}`.");
      }
      const path = input.slice(at + 1, close).trim();
      if (path.length === 0) {
        return fail("empty-reference", "Empty reference — `{}` doesn't name a token.");
      }
      if (path.indexOf("{") !== -1) {
        return fail("bad-reference", "References can't be nested.");
      }
      out.push({ kind: "reference", path });
      at = close + 1;
      continue;
    }

    if (DIGIT.test(char) || (char === "." && DIGIT.test(input[at + 1] ?? ""))) {
      let end = at;
      let dots = 0;
      while (end < input.length && (DIGIT.test(input[end]) || input[end] === ".")) {
        if (input[end] === ".") {
          dots += 1;
          if (dots > 1) break;
        }
        end += 1;
      }
      const text = input.slice(at, end);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        return fail("bad-number", `"${text}" isn't a number.`);
      }
      // A unit welded to a number is the mistake worth naming, because "no units" reads as an
      // arbitrary restriction and the real reason — units are added at export, ADR-0002 §3 — is
      // what stops the user working around it by writing `4` and meaning `4rem`.
      if (end < input.length && input[end] === "%") {
        return fail(
          "percentage-in-expression",
          "Percentages aren't in this version. Write the multiplier instead — `0.5` rather than `50%`."
        );
      }
      if (end < input.length && IDENT.test(input[end])) {
        return fail(
          "unit-in-expression",
          `Units don't go in expressions. Write \`${text}\` — units get added when tokens are exported, not here.`
        );
      }
      out.push({ kind: "number", value, text });
      at = end;
      continue;
    }

    if (IDENT.test(char)) {
      let end = at;
      while (end < input.length && (IDENT.test(input[end]) || DIGIT.test(input[end]))) end += 1;
      const word = input.slice(at, end);
      if (word === "%") {
        return fail(
          "unsupported-operator",
          "`%` isn't something expressions can do. They handle `+`, `-`, `*`, `/`, brackets, and nothing else."
        );
      }
      // `round(`, `lighten(` — a function call. Named as such rather than as a stray word, because
      // that is the thing the user was actually reaching for (ADR-0007 §10).
      return fail(
        "function-in-expression",
        "Expressions can't call functions. `round`, `min`, `clamp` and colour functions aren't in this version."
      );
    }

    return fail(
      "unsupported-operator",
      `\`${char}\` isn't something expressions can do. They handle \`+\`, \`-\`, \`*\`, \`/\`, brackets, and nothing else.`
    );
  }

  if (out.length === 0) return fail("empty", "Enter a number, a reference, or an expression.");
  return ok(out);
}

// ---------------------------------------------------------------------------
// Parser — ADR-0007 §1's grammar, verbatim
// ---------------------------------------------------------------------------
//
//   expr    := term (("+" | "-") term)*
//   term    := factor (("*" | "/") factor)*
//   factor  := "-"? primary
//   primary := number | reference | "(" expr ")"
//
// Recursive descent with two precedence levels and nothing else. No `%`, no comparison, no string
// concatenation, no functions — every one of those is a tokenizer refusal above, so the parser
// never has to decide whether something is "supported".

/**
 * Parses an expression string into an AST.
 *
 * Chained and nested expressions come for free from the recursion and are *deliberately not*
 * restricted (ADR-0007 §1): capping at a single binary operation would be code written to enforce
 * a limit that costs nothing to lift.
 */
export function parseExpression(input: string): ExprResult<ExprNode> {
  const lexed = tokenize(input);
  if (!lexed.ok) return lexed;
  const toks = lexed.value;

  let at = 0;
  const peek = (): Tok | undefined => toks[at];

  const unfinished = (): ExprResult<ExprNode> =>
    fail("unfinished-expression", "Unfinished expression.");

  const parsePrimary = (): ExprResult<ExprNode> => {
    const tok = peek();
    if (tok === undefined) return unfinished();
    if (tok.kind === "number") {
      at += 1;
      return ok({ kind: "number", value: tok.value });
    }
    if (tok.kind === "reference") {
      at += 1;
      return ok({ kind: "reference", path: tok.path });
    }
    if (tok.kind === "lparen") {
      at += 1;
      const inner = parseExpr();
      if (!inner.ok) return inner;
      const next = peek();
      if (next === undefined || next.kind !== "rparen") return unfinished();
      at += 1;
      return inner;
    }
    return unfinished();
  };

  const parseFactor = (): ExprResult<ExprNode> => {
    const tok = peek();
    if (tok !== undefined && tok.kind === "op" && tok.op === "-") {
      at += 1;
      const operand = parseFactor();
      if (!operand.ok) return operand;
      return ok({ kind: "negate", operand: operand.value });
    }
    return parsePrimary();
  };

  const parseTerm = (): ExprResult<ExprNode> => {
    const first = parseFactor();
    if (!first.ok) return first;
    let node: ExprNode = first.value;
    for (;;) {
      const tok = peek();
      if (tok === undefined || tok.kind !== "op" || (tok.op !== "*" && tok.op !== "/")) break;
      at += 1;
      const right = parseFactor();
      if (!right.ok) return right;
      node = { kind: "binary", op: tok.op, left: node, right: right.value };
    }
    return ok(node);
  };

  const parseExpr = (): ExprResult<ExprNode> => {
    const first = parseTerm();
    if (!first.ok) return first;
    let node: ExprNode = first.value;
    for (;;) {
      const tok = peek();
      if (tok === undefined || tok.kind !== "op" || (tok.op !== "+" && tok.op !== "-")) break;
      at += 1;
      const right = parseTerm();
      if (!right.ok) return right;
      node = { kind: "binary", op: tok.op, left: node, right: right.value };
    }
    return ok(node);
  };

  const parsed = parseExpr();
  if (!parsed.ok) return parsed;
  // Trailing junk is an unfinished expression from the user's point of view: `({a} + 2` and
  // `{a} 2` are both "this isn't a complete thing yet", and splitting the copy would say the same
  // thing twice in two voices.
  if (at !== toks.length) return unfinished();
  return parsed;
}

// ---------------------------------------------------------------------------
// The reference edges an expression carries
// ---------------------------------------------------------------------------

/** Every `{path}` inside an expression, in source order — the graph's outgoing edges (§3). */
export function expressionReferences(node: ExprNode): string[] {
  const out: string[] = [];
  const walk = (current: ExprNode): void => {
    if (current.kind === "reference") {
      out.push(current.path);
      return;
    }
    if (current.kind === "negate") {
      walk(current.operand);
      return;
    }
    if (current.kind === "binary") {
      walk(current.left);
      walk(current.right);
    }
  };
  walk(node);
  return out;
}

/**
 * The paths an expression string points at, or `[]` when it doesn't parse.
 *
 * The graph deliberately keeps the edges of an *unparseable* expression out: they are not
 * dependencies the user has expressed, and inventing them would let a typo manufacture a cycle.
 */
export function referencesInExpression(input: string): string[] {
  const parsed = parseExpression(input);
  return parsed.ok ? expressionReferences(parsed.value) : [];
}

// ---------------------------------------------------------------------------
// Evaluation — ADR-0007 §4
// ---------------------------------------------------------------------------

/** What the caller's index says one operand resolves to. Non-numeric is an error, not a coercion. */
export type OperandResolution = { ok: true; value: number } | { ok: false; error: ExprError };

/**
 * Evaluates an AST against a resolver for its `{path}` operands.
 *
 * Full precision, no rounding: ADR-0002 Amendment 1 §H's float32 handling still happens at the
 * Figma boundary and is not duplicated here. Division by zero is an **error**, never `Infinity` —
 * an infinite number written into a Variable is a value nobody can see is wrong.
 */
export function evaluateExpression(
  node: ExprNode,
  resolve: (path: string) => OperandResolution
): ExprResult<number> {
  if (node.kind === "number") return ok(node.value);

  if (node.kind === "reference") {
    const resolved = resolve(node.path);
    return resolved.ok ? ok(resolved.value) : { ok: false, error: resolved.error };
  }

  if (node.kind === "negate") {
    const operand = evaluateExpression(node.operand, resolve);
    return operand.ok ? ok(-operand.value) : operand;
  }

  const left = evaluateExpression(node.left, resolve);
  if (!left.ok) return left;
  const right = evaluateExpression(node.right, resolve);
  if (!right.ok) return right;

  switch (node.op) {
    case "+":
      return ok(left.value + right.value);
    case "-":
      return ok(left.value - right.value);
    case "*":
      return ok(left.value * right.value);
    default: {
      if (right.value === 0) {
        return fail("divide-by-zero", "Dividing by zero gives no value.");
      }
      const result = left.value / right.value;
      // Belt and braces: a denominator small enough to overflow to `Infinity` is the same failure
      // as dividing by zero, and the same sentence is the honest thing to say about it.
      if (!Number.isFinite(result)) {
        return fail("divide-by-zero", "Dividing by zero gives no value.");
      }
      return ok(result);
    }
  }
}

/** Parse and evaluate in one step — the shape every caller outside the picker actually wants. */
export function evaluate(
  input: string,
  resolve: (path: string) => OperandResolution
): ExprResult<number> {
  const parsed = parseExpression(input);
  if (!parsed.ok) return parsed;
  return evaluateExpression(parsed.value, resolve);
}

// ---------------------------------------------------------------------------
// The no-op nudge — UX §6.5, resolution 3
// ---------------------------------------------------------------------------

/**
 * The single reference an expression is arithmetically identical to, or `null`.
 *
 * `{a} * 1`, `{a} + 0`, `{a} / 1`, `({a})`, `-(-{a})` — and nothing else. This is the *only* place
 * the editor steers a user away from an expression (UX §6.5, resolved by Shyam 2026-09-03): where
 * we can prove a plain reference does the same job strictly better, because it keeps a live Figma
 * link the expression destroys.
 *
 * It offers; it never rewrites. `{a} * 1` may be a user halfway to `{a} * 1.5`, and a tool that
 * silently normalises what you typed is one you stop trusting with what it doesn't understand.
 *
 * Deliberately conservative: `{a} + {b} - {b}` is *also* a no-op and is *not* matched. Proving that
 * needs algebra over the whole tree, the answer changes with the theme, and being wrong about it
 * would offer a swap that silently changes the value.
 */
export function noOpReference(node: ExprNode): string | null {
  if (node.kind === "reference") return node.path;

  if (node.kind === "negate") {
    // Only a double negation cancels. A single `-{a}` genuinely differs from `{a}`.
    if (node.operand.kind !== "negate") return null;
    return noOpReference(node.operand.operand);
  }

  if (node.kind !== "binary") return null;

  const { op, left, right } = node;
  if (op === "*") {
    if (isLiteral(right, 1)) return noOpReference(left);
    if (isLiteral(left, 1)) return noOpReference(right);
    return null;
  }
  if (op === "/") {
    // Only `{a} / 1`. `1 / {a}` is a reciprocal, which is a real computation.
    return isLiteral(right, 1) ? noOpReference(left) : null;
  }
  if (op === "+") {
    if (isLiteral(right, 0)) return noOpReference(left);
    if (isLiteral(left, 0)) return noOpReference(right);
    return null;
  }
  // `{a} - 0` is a no-op; `0 - {a}` is a negation and is not.
  return isLiteral(right, 0) ? noOpReference(left) : null;
}

function isLiteral(node: ExprNode, value: number): boolean {
  return node.kind === "number" && node.value === value;
}

/**
 * The same, from the raw string — `null` when it doesn't parse or isn't a no-op.
 *
 * A bare `{a}` never reaches here: `valueShape` classifies it as a reference before an expression
 * is considered at all (§1). Guarded anyway, because a caller that skipped `valueShape` offering
 * "use `{a}` instead of `{a}`" would be a confusing way to say nothing.
 */
export function noOpReferenceIn(input: string): string | null {
  if (isReference(input)) return null;
  const parsed = parseExpression(input);
  return parsed.ok ? noOpReference(parsed.value) : null;
}
