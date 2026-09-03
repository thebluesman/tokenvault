// The math grammar — ADR-0007 §1, §2, and UX §6.4's error table.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Token } from "../src/tokens/types";
import {
  evaluate,
  evaluateExpression,
  expressionReferences,
  isExpressionValue,
  noOpReferenceIn,
  parseExpression,
  referencesInExpression,
  valueShape,
} from "../src/tokens/expr";

function node(input: string): ReturnType<typeof parseExpression> {
  return parseExpression(input);
}

function value(input: string, values: Record<string, number> = {}): number {
  const result = evaluate(input, (path) =>
    values[path] === undefined
      ? { ok: false as const, error: { reason: "unknown", message: `no ${path}` } }
      : { ok: true as const, value: values[path] }
  );
  assert.equal(result.ok, true, `expected ${input} to evaluate`);
  return (result as { ok: true; value: number }).value;
}

function error(input: string, values: Record<string, number> = {}): string {
  const result = evaluate(input, (path) =>
    values[path] === undefined
      ? { ok: false as const, error: { reason: "unknown", message: `no ${path}` } }
      : { ok: true as const, value: values[path] }
  );
  assert.equal(result.ok, false, `expected ${input} to fail`);
  return (result as { ok: false; error: { reason: string } }).error.reason;
}

function token(type: Token["$type"], raw: unknown): Pick<Token, "$type" | "$value"> {
  return { $type: type, $value: raw as Token["$value"] };
}

// ---------------------------------------------------------------------------
// Recognition — the three shapes
// ---------------------------------------------------------------------------

test("the three value shapes are distinguished at recognition time", () => {
  assert.equal(valueShape(token("number", 8)), "literal");
  assert.equal(valueShape(token("number", "{a}")), "reference");
  assert.equal(valueShape(token("number", "{a} * 2")), "expression");
  assert.equal(valueShape(token("color", "#c33a2e")), "literal");
  assert.equal(valueShape(token("color", "{a}")), "reference");
});

test("a string token's value is a literal however it reads — no expression on a non-number", () => {
  // `"Semibold - Italic"` is a font style, not a subtraction. A recogniser that decided on the
  // string alone would turn a legitimate value into a parse error.
  assert.equal(valueShape(token("string", "Semibold - Italic")), "literal");
  assert.equal(valueShape(token("string", "{a} * 2")), "literal");
  assert.equal(isExpressionValue(token("string", "1 + 1")), false);
  // Composite sub-keys are ADR-0007 §10's deferral, so a composite is never an expression.
  assert.equal(valueShape(token("typography", "{a} * 2")), "literal");
});

test("`isReference` is not widened — an alias and an expression stay different things", () => {
  // The load-bearing distinction (ADR-0007 §1): `{a}` keeps a live Figma link, `{a} * 1` does not.
  assert.equal(valueShape(token("number", "{a}")), "reference");
  assert.equal(valueShape(token("number", "{a} * 1")), "expression");
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("the grammar is exactly ADR-0007 §1's — four operators, unary minus, parentheses", () => {
  assert.equal(value("2 + 3"), 5);
  assert.equal(value("10 - 4"), 6);
  assert.equal(value("3 * 4"), 12);
  assert.equal(value("12 / 4"), 3);
  assert.equal(value("-5"), -5);
  assert.equal(value("(2 + 3) * 4"), 20);
});

test("precedence is two levels: * and / bind tighter than + and -", () => {
  assert.equal(value("2 + 3 * 4"), 14);
  assert.equal(value("2 * 3 + 4"), 10);
  assert.equal(value("(2 + 3) * 4"), 20);
});

test("chained and nested expressions work — the limit costs nothing to lift", () => {
  // Recursive descent gives chaining for free; restricting to one binary op would be code written
  // to enforce a limit (ADR-0007 §1, and the same false economy §11 rejected for alias chains).
  assert.equal(value("1 + 2 + 3 + 4"), 10);
  assert.equal(value("((({a} + 1) * 2) - 3) / 2", { a: 4 }), 3.5);
  assert.equal(value("-(-{a})", { a: 8 }), 8);
  assert.equal(value("{a} * {b} / {c}", { a: 8, b: 3, c: 4 }), 6);
});

test("references inside an expression are collected in source order", () => {
  const parsed = node("({a} + {b}) * {c}");
  assert.equal(parsed.ok, true);
  assert.deepEqual(expressionReferences((parsed as { ok: true; value: never }).value), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(referencesInExpression("{x} / 2"), ["x"]);
});

test("an expression that doesn't parse contributes no edges", () => {
  // Inventing dependencies from a half-typed string would let a typo manufacture a cycle.
  assert.deepEqual(referencesInExpression("{a} * "), []);
});

// ---------------------------------------------------------------------------
// Parse errors — UX §6.4's table, one row at a time
// ---------------------------------------------------------------------------

test("a unit is a parse error, not a silently stripped unit", () => {
  // ADR-0002 §3 keeps units a Phase 8 transform concern; inventing one here would bake the guess
  // into the source of truth a layer earlier than the decision belongs.
  const parsed = node("4px * 2");
  assert.equal(parsed.ok, false);
  const failed = parsed as { ok: false; error: { reason: string; message: string } };
  assert.equal(failed.error.reason, "unit-in-expression");
  assert.match(failed.error.message, /units get added when tokens are exported/);
});

test("an unfinished expression is one message, not two", () => {
  assert.equal(error("{a} * ", { a: 1 }), "unfinished-expression");
  assert.equal(error("({a} + 2", { a: 1 }), "unfinished-expression");
  assert.equal(error("{a} 2", { a: 1 }), "unfinished-expression");
});

test("operators outside the grammar are named rather than swallowed", () => {
  assert.equal(error("{a} % 2", { a: 1 }), "unsupported-operator");
  assert.equal(error("{a} > 2", { a: 1 }), "unsupported-operator");
  assert.equal(error("{a} ^ 2", { a: 1 }), "unsupported-operator");
});

test("a function call says it is a function call", () => {
  assert.equal(error("round({a})", { a: 1 }), "function-in-expression");
  assert.equal(error("lighten({a}, 10)", { a: 1 }), "function-in-expression");
});

test("a percentage gets its own message rather than being read as a unit", () => {
  assert.equal(error("50% * {a}", { a: 2 }), "percentage-in-expression");
});

test("a malformed reference is caught in the lexer", () => {
  assert.equal(error("{a * 2"), "unclosed-reference");
  assert.equal(error("{} * 2"), "empty-reference");
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

test("there is no rounding — the result is a full-precision float", () => {
  assert.equal(value("1 / 3"), 1 / 3);
  assert.equal(value("{a} * 1.5", { a: 5 }), 7.5);
});

test("division by zero is an evaluation error, never Infinity written to a variable", () => {
  assert.equal(error("{a} / 0", { a: 8 }), "divide-by-zero");
  assert.equal(error("8 / (2 - 2)"), "divide-by-zero");
});

test("an operand the resolver refuses fails the whole expression, never partially", () => {
  // No partial evaluation and no fallback value (ADR-0007 §3). `{missing} + 2` is not `2`.
  assert.equal(error("{missing} + 2"), "unknown");
});

test("evaluation is over the AST, so a resolver is consulted once per occurrence", () => {
  const seen: string[] = [];
  const parsed = node("{a} + {a}");
  assert.equal(parsed.ok, true);
  const result = evaluateExpression((parsed as { ok: true; value: never }).value, (path) => {
    seen.push(path);
    return { ok: true, value: 3 };
  });
  assert.deepEqual(result, { ok: true, value: 6 });
  assert.deepEqual(seen, ["a", "a"]);
});

// ---------------------------------------------------------------------------
// The no-op nudge — UX §6.5, resolved by Shyam 2026-09-03
// ---------------------------------------------------------------------------

test("a no-op over a single reference is recognised, and only where it is provable", () => {
  assert.equal(noOpReferenceIn("{a} * 1"), "a");
  assert.equal(noOpReferenceIn("{a} + 0"), "a");
  assert.equal(noOpReferenceIn("{a} / 1"), "a");
  assert.equal(noOpReferenceIn("{a} - 0"), "a");
  assert.equal(noOpReferenceIn("({a})"), "a");
  assert.equal(noOpReferenceIn("-(-{a})"), "a");
  assert.equal(noOpReferenceIn("1 * {a}"), "a");
  assert.equal(noOpReferenceIn("0 + {a}"), "a");
});

test("a real expression is never nudged — the steering is one case, not a standing warning", () => {
  assert.equal(noOpReferenceIn("{a} * 2"), null);
  assert.equal(noOpReferenceIn("{a} + {b}"), null);
  assert.equal(noOpReferenceIn("({a} + {b}) / 2"), null);
  // Deliberately conservative: `{a} + {b} - {b}` *is* a no-op, and proving it needs algebra over
  // the whole tree whose answer changes with the theme. Being wrong here would offer a swap that
  // silently changes the value.
  assert.equal(noOpReferenceIn("{a} + {b} - {b}"), null);
  // A reciprocal and a negation are real computations, not no-ops.
  assert.equal(noOpReferenceIn("1 / {a}"), null);
  assert.equal(noOpReferenceIn("0 - {a}"), null);
  assert.equal(noOpReferenceIn("-{a}"), null);
});

test("a plain reference is never nudged toward itself", () => {
  assert.equal(noOpReferenceIn("{a}"), null);
});
