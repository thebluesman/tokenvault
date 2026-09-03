// Theme-scoped resolution and the four authoring rules — ADR-0007 §4, §5.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { FlatToken } from "../src/tokens/view";
import {
  buildFlatResolveContext,
  buildResolveContext,
  checkAuthoredValue,
  graphReport,
  referencePathsOf,
  resolveToken,
  themePathSet,
} from "../src/tokens/resolve";
import { flat, varToken } from "./helpers";

function num(path: string, set: string, value: unknown): FlatToken {
  return flat(path, set, varToken("number", value));
}

function color(path: string, set: string, value: unknown): FlatToken {
  return flat(path, set, varToken("color", value));
}

function find(tokens: FlatToken[], path: string, set?: string): FlatToken {
  const found = tokens.filter((entry) => entry.path === path && (set === undefined || entry.setId === set));
  assert.equal(found.length > 0, true, `no ${path}`);
  return found[0];
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

test("a literal resolves to itself", () => {
  const tokens = [num("a", "S", 8)];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.deepEqual(resolved, { kind: "literal", value: 8 });
});

test("a reference resolves through the chain to the literal at the end of it", () => {
  // Chains are followed rather than capped — termination is the cycle check's job (ADR-0007 §1).
  const tokens = [num("a", "S", "{b}"), num("b", "S", "{c}"), num("c", "S", 12)];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal(resolved.kind, "reference");
  assert.equal(resolved.value, 12);
  assert.equal(resolved.target, "b");
});

test("an expression evaluates for display and the string stays the value", () => {
  const tokens = [num("space.button", "S", "{core.4} * 2"), num("core.4", "S", 16)];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal(resolved.kind, "expression");
  assert.equal(resolved.value, 32);
  assert.equal(resolved.expression, "{core.4} * 2");
  // Nothing was written back: the token still holds the string (ADR-0007 §2).
  assert.equal(tokens[0].token.$value, "{core.4} * 2");
});

test("an expression resolves through a reference operand", () => {
  const tokens = [num("a", "S", "{b} * 2"), num("b", "S", "{c}"), num("c", "S", 5)];
  assert.equal(resolveToken(tokens[0], buildFlatResolveContext(tokens)).value, 10);
});

test("a non-numeric operand is a resolve-time error naming the operand", () => {
  const tokens = [num("a", "S", "{swatch} * 2"), color("swatch", "S", "#c33a2e")];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal(resolved.kind, "error");
  assert.match(resolved.error?.message ?? "", /is a color\. Expressions only work with numbers/);
});

// ---------------------------------------------------------------------------
// A cycle produces no value — ADR-0007 §3, UX §7.1
// ---------------------------------------------------------------------------

test("a token on a cycle has no value — not zero, not the last good number", () => {
  const tokens = [num("a", "S", "{b}"), num("b", "S", "{a}")];
  const context = buildFlatResolveContext(tokens);
  for (const entry of tokens) {
    const resolved = resolveToken(entry, context);
    assert.equal(resolved.kind, "cycle");
    assert.equal(resolved.value, undefined);
    assert.notEqual(resolved.cycle, undefined);
  }
});

test("a token pointing *into* a loop errors rather than being put on it", () => {
  const tokens = [num("a", "S", "{b}"), num("b", "S", "{a}"), num("d", "S", "{a} + 1")];
  const context = buildFlatResolveContext(tokens);
  const resolved = resolveToken(find(tokens, "d"), context);
  assert.equal(resolved.kind, "error");
  assert.equal(resolved.value, undefined);
});

test("a self-reference is a cycle of one and has no value either", () => {
  const tokens = [num("a", "S", "{a}")];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal(resolved.kind, "cycle");
  assert.equal(resolved.value, undefined);
});

// ---------------------------------------------------------------------------
// Theme scoping
// ---------------------------------------------------------------------------

test("resolution is theme-scoped: the same token resolves differently under two stacks", () => {
  const all = [
    num("accent", "Base", "{ramp}"),
    num("ramp", "Light", 10),
    num("ramp", "Dark", 90),
  ];
  const light = buildResolveContext([all[0], all[1]], all);
  const dark = buildResolveContext([all[0], all[2]], all);
  assert.equal(resolveToken(all[0], light).value, 10);
  assert.equal(resolveToken(all[0], dark).value, 90);
});

test("a target outside the stack is unresolved, with no value invented for it", () => {
  // The token genuinely has no value in that theme, and inventing one would be the single worst
  // thing this feature could do (UX §5.4).
  const all = [num("accent", "Base", "{brand}"), num("brand", "Brand", 4)];
  const withoutBrand = buildResolveContext([all[0]], all);
  const resolved = resolveToken(all[0], withoutBrand);
  assert.equal(resolved.kind, "unresolved");
  assert.equal(resolved.value, undefined);
  assert.equal(resolved.target, "brand");
});

test("the stack resolves last-wins, so a theme set overrides its base", () => {
  const all = [num("size", "Base", 4), num("size", "Theme", 8), num("gap", "Base", "{size}")];
  const context = buildResolveContext([all[0], all[1], all[2]], all);
  assert.equal(resolveToken(all[2], context).value, 8);
});

// ---------------------------------------------------------------------------
// Authoring — the four rules
// ---------------------------------------------------------------------------

function author(tokens: FlatToken[], path: string, raw: string, stacks?: Array<{ name: string; paths: Set<string> }>) {
  const context = buildFlatResolveContext(tokens);
  return checkAuthoredValue({ entry: find(tokens, path), raw, context, themeStacks: stacks });
}

test("rule 1 — a path in no set at all is refused", () => {
  const tokens = [num("a", "S", 1), num("b", "S", 2)];
  const outcome = author(tokens, "a", "{typo.path}");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "reference-unknown");
});

test("rule 2 — a whole-value reference must match the editing token's type", () => {
  const tokens = [color("swatch", "S", "#c33a2e"), num("size", "S", 4)];
  const outcome = author(tokens, "swatch", "{size}");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "reference-type-mismatch");
  // Named both ways round in one sentence (UX §5.2).
  assert.match((outcome as { message: string }).message, /is a number.*is a color/);
});

test("rule 2 — an operand inside an expression must resolve to a number", () => {
  const tokens = [num("gap", "S", 4), color("swatch", "S", "#c33a2e")];
  const outcome = author(tokens, "gap", "{swatch} * 2");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "reference-type-mismatch");
});

test("rule 3 — a candidate that closes a loop is refused, and carries the loop", () => {
  const tokens = [num("a", "S", "{b}"), num("b", "S", 4)];
  const outcome = author(tokens, "b", "{a}");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "reference-cycle");
  assert.notEqual((outcome as { cycle?: unknown }).cycle, undefined);
});

test("rule 3 — a self-reference is refused as a cycle, not as a type mismatch", () => {
  const tokens = [num("a", "S", 4)];
  const outcome = author(tokens, "a", "{a}");
  assert.equal((outcome as { reason: string }).reason, "reference-cycle");
});

test("rule 4 — a target missing from another theme warns and commits", () => {
  // Refusing would make theme-specific tokens impossible, which would make the theme feature and
  // the reference feature mutually exclusive (ADR-0007 §5, confirmed by Shyam).
  const tokens = [num("accent", "Base", 1), num("brand", "Brand", 4)];
  const stacks = [
    { name: "Light", paths: themePathSet(tokens, ["Base"]) },
    { name: "Brand", paths: themePathSet(tokens, ["Base", "Brand"]) },
  ];
  const outcome = author(tokens, "accent", "{brand}", stacks);
  assert.equal(outcome.ok, true);
  assert.deepEqual((outcome as { missingThemes?: string[] }).missingThemes, ["Light"]);
  assert.match((outcome as { warning: string }).warning, /isn't in Light/);
});

test("rule 4 holds for the active theme too — only rule 1 refuses a missing target", () => {
  const all = [num("accent", "Base", 1), num("brand", "Brand", 4)];
  const activeContext = buildResolveContext([all[0]], all);
  const outcome = checkAuthoredValue({
    entry: all[0],
    raw: "{brand}",
    context: activeContext,
    themeStacks: [{ name: "Light", paths: themePathSet(all, ["Base"]) }],
  });
  assert.equal(outcome.ok, true);
});

test("a value with nothing wrong with it commits with nothing to say", () => {
  const tokens = [num("a", "S", 1), num("b", "S", 2)];
  assert.deepEqual(author(tokens, "a", "{b}"), { ok: true });
  assert.deepEqual(author(tokens, "a", "{b} * 2"), { ok: true });
});

test("a parse failure is refused with the field's own copy", () => {
  const tokens = [num("a", "S", 1)];
  assert.equal((author(tokens, "a", "4px * 2") as { reason: string }).reason, "unit-in-expression");
  assert.equal((author(tokens, "a", "{a} * ") as { reason: string }).reason, "unfinished-expression");
});

test("division by zero is caught at authoring time, where it can be fixed", () => {
  const tokens = [num("a", "S", 1), num("b", "S", 4)];
  assert.equal((author(tokens, "a", "{b} / 0") as { reason: string }).reason, "divide-by-zero");
});

test("all four rules run before anything is written — the refusals carry no committed flag", () => {
  const tokens = [num("a", "S", "{b}"), num("b", "S", 4)];
  const outcome = author(tokens, "b", "{a}");
  assert.equal(outcome.ok, false);
});

// ---------------------------------------------------------------------------
// Candidate paths
// ---------------------------------------------------------------------------

test("the paths a candidate points at cover both shapes", () => {
  assert.deepEqual(referencePathsOf("{a}"), ["a"]);
  assert.deepEqual(referencePathsOf("({a} + {b}) / 2"), ["a", "b"]);
  assert.deepEqual(referencePathsOf("8"), []);
  assert.deepEqual(referencePathsOf("{a} * "), []);
});

// ---------------------------------------------------------------------------
// The build/merge report — ADR-0007 §3's second checkpoint, §5's three kinds
// ---------------------------------------------------------------------------

test("every token on a loop gets an entry, and each carries the whole loop", () => {
  // The error state is the cycle, not the token: any one of them can be edited to break it, so
  // singling one out sends the user to what may be the least appropriate place to fix it.
  const tokens = [num("a", "S", "{b}"), num("b", "S", "{c}"), num("c", "S", "{a}")];
  const entries = graphReport(tokens, buildFlatResolveContext(tokens));
  const cycles = entries.filter((entry) => entry.kind === "reference-cycle");
  assert.equal(cycles.length, 3);
  for (const entry of cycles) assert.match(entry.message, /a → b → c → a/);
});

test("a self-reference reports as a cycle with its own reason", () => {
  const tokens = [num("a", "S", "{a}")];
  const entries = graphReport(tokens, buildFlatResolveContext(tokens));
  assert.equal(entries[0].kind, "reference-cycle");
  assert.equal(entries[0].reason, "self-reference");
});

test("an expression that can't be worked out reports as expression-error", () => {
  const tokens = [num("a", "S", "{b} / 0"), num("b", "S", 4)];
  const entries = graphReport(tokens, buildFlatResolveContext(tokens));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "expression-error");
  assert.equal(entries[0].reason, "divide-by-zero");
});

test("a target missing from another theme is a warning, not an error", () => {
  // Frequently the correct state of a correct token — the copy says so in as many words.
  const tokens = [num("accent", "Base", "{brand}"), num("brand", "Brand", 4)];
  const context = buildFlatResolveContext(tokens);
  const entries = graphReport(tokens, context, [
    { name: "Light", paths: themePathSet(tokens, ["Base"]) },
    { name: "Brand", paths: themePathSet(tokens, ["Base", "Brand"]) },
  ]);
  const warnings = entries.filter((entry) => entry.kind === "unresolved-in-theme");
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].omitted, ["Light"]);
  assert.match(warnings[0].message, /Nothing is broken/);
});

test("the active theme's own gap reports separately, with no value invented", () => {
  const all = [num("accent", "Base", "{brand}"), num("brand", "Brand", 4)];
  const active = buildResolveContext([all[0]], all);
  const entries = graphReport([all[0]], active);
  assert.equal(entries[0].kind, "unresolved-in-theme");
  assert.equal(entries[0].reason, "active-theme");
});

test("a clean tree reports nothing at all", () => {
  const tokens = [num("a", "S", "{b} * 2"), num("b", "S", 4)];
  assert.deepEqual(graphReport(tokens, buildFlatResolveContext(tokens)), []);
});

test("report kinds are additive — the three are all ReportEntry, version 1 untouched", () => {
  const tokens = [num("a", "S", "{a}")];
  const entries = graphReport(tokens, buildFlatResolveContext(tokens));
  assert.equal(typeof entries[0].message, "string");
  assert.equal(typeof entries[0].path, "string");
  assert.equal(typeof entries[0].set, "string");
});

test("an expression on a non-number token is refused, not committed as a string", () => {
  // An expression works out to a number (ADR-0007 §1), so it can only ever be a `number` token's
  // value. Committing it would leave `toFigma` to refuse at the write boundary instead, which is
  // days later and in the wrong place.
  const tokens = [color("swatch", "S", "#c33a2e"), num("size", "S", 4)];
  const outcome = author(tokens, "swatch", "{size} * 2");
  assert.equal(outcome.ok, false);
  assert.equal((outcome as { reason: string }).reason, "expression-on-non-number");
});
