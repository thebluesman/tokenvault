// The expression-flattening pass and the Style Dictionary input shape — issue #17's core.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { FlatToken } from "../src/tokens/view";
import type { ExportTheme } from "../src/export/themes";
import { flattenTheme, toStyleDictionaryTokens } from "../src/export/flatten";
import { flat, varToken } from "./helpers";

function theme(sets: string[], name = "Light"): ExportTheme {
  return { name, slug: name.toLowerCase(), selectedTokenSets: sets, unknownSets: [], synthesized: false };
}

function find(tokens: Array<{ path: string }>, path: string): number {
  return tokens.findIndex((token) => token.path === path);
}

// ---------------------------------------------------------------------------
// References pass through; expressions do not
// ---------------------------------------------------------------------------

test("a reference keeps its {path} string — Style Dictionary's syntax is ours", () => {
  const tokens: FlatToken[] = [
    flat("core.space.4", "Base", varToken("number", 4)),
    flat("core.space.8", "Base", varToken("number", "{core.space.4}")),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.tokens[find(result.tokens, "core.space.8")].token.$value, "{core.space.4}");
});

test("an expression is flattened to the number the Phase 7 evaluator computes", () => {
  const tokens: FlatToken[] = [
    flat("core.space.4", "Base", varToken("number", 4)),
    flat("core.space.8", "Base", varToken("number", "{core.space.4} * 2")),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.tokens[find(result.tokens, "core.space.8")].token.$value, 8);
});

test("expression flattening happens per theme, so the same expression differs by theme", () => {
  // The reason the order is theme → references → expressions rather than the reverse: flattening
  // once, before theme selection, would emit one of these two numbers into both stylesheets.
  const tokens: FlatToken[] = [
    flat("brand.base", "Light", varToken("number", 10)),
    flat("brand.base", "Dark", varToken("number", 20)),
    flat("brand.double", "Base", varToken("number", "{brand.base} * 2")),
  ];
  const light = flattenTheme(tokens, theme(["Base", "Light"], "Light"));
  const dark = flattenTheme(tokens, theme(["Base", "Dark"], "Dark"));
  assert.equal(light.tokens[find(light.tokens, "brand.double")].token.$value, 20);
  assert.equal(dark.tokens[find(dark.tokens, "brand.double")].token.$value, 40);
});

test("evaluation semantics are Phase 7's — full precision, no rounding", () => {
  const tokens: FlatToken[] = [
    flat("a", "Base", varToken("number", 10)),
    flat("b", "Base", varToken("number", "{a} / 3")),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.equal(result.tokens[find(result.tokens, "b")].token.$value, 10 / 3);
});

test("division by zero is an error, never Infinity in a stylesheet", () => {
  const tokens: FlatToken[] = [
    flat("a", "Base", varToken("number", 0)),
    flat("b", "Base", varToken("number", "10 / {a}")),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].kind, "expression-error");
  assert.equal(find(result.tokens, "b"), -1);
});

test("an unparseable expression is named and its token is not emitted", () => {
  const tokens: FlatToken[] = [flat("b", "Base", varToken("number", "4px * 2"))];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.equal(result.diagnostics[0].kind, "expression-error");
  assert.match(result.diagnostics[0].message, /"b"/);
  assert.deepEqual(result.tokens, []);
});

// ---------------------------------------------------------------------------
// Cycles and dangling references
// ---------------------------------------------------------------------------

test("a cycle produces no value at all — never a zero, never the last good number", () => {
  const tokens: FlatToken[] = [
    flat("a", "Base", varToken("number", "{b} * 2")),
    flat("b", "Base", varToken("number", "{a}")),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.deepEqual(result.tokens, []);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every((one) => one.kind === "reference-cycle"));
  // The loop itself is in the message, so a CI log says which tokens to look at.
  assert.match(result.diagnostics[0].message, /→/);
});

test("a reference to a path outside the theme's stack is a dangling reference", () => {
  const tokens: FlatToken[] = [
    flat("dark.only", "Dark", varToken("number", 4)),
    flat("a", "Base", varToken("number", "{dark.only}")),
  ];
  const result = flattenTheme(tokens, theme(["Base", "Light"]));
  assert.equal(result.diagnostics[0].kind, "dangling-reference");
  assert.match(result.diagnostics[0].message, /dark\.only/);
  assert.deepEqual(result.tokens, []);
});

test("a reference inside a composite value is checked too", () => {
  // A text style bound to a size variable (ADR-0003 §4) passes through to Style Dictionary the same
  // way a whole-value reference does, so an unresolvable one would reach the CSS verbatim.
  const tokens: FlatToken[] = [
    flat(
      "type.body",
      "Styles",
      varToken("typography", {
        fontFamily: "Inter",
        fontSize: "{missing.size}",
        fontWeight: 400,
        letterSpacing: { unit: "px", value: 0 },
      })
    ),
  ];
  const result = flattenTheme(tokens, theme(["Styles"]));
  assert.equal(result.diagnostics[0].kind, "dangling-reference");
  assert.match(result.diagnostics[0].message, /missing\.size/);
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

test("later sets in the stack win, matching ADR-0002 §1", () => {
  const tokens: FlatToken[] = [
    flat("color.bg", "Base", varToken("color", "#ffffff")),
    flat("color.bg", "Dark", varToken("color", "#000000")),
  ];
  const result = flattenTheme(tokens, theme(["Base", "Dark"]));
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0].token.$value, "#000000");
  assert.equal(result.tokens[0].setId, "Dark");
});

test("a set outside the theme contributes nothing", () => {
  const tokens: FlatToken[] = [
    flat("a", "Base", varToken("number", 1)),
    flat("z", "Dark", varToken("number", 2)),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.deepEqual(result.tokens.map((token) => token.path), ["a"]);
});

test("output order is path order, so a rebuild produces no diff", () => {
  const tokens: FlatToken[] = [
    flat("z.one", "Base", varToken("number", 1)),
    flat("a.two", "Base", varToken("number", 2)),
    flat("m.three", "Base", varToken("number", 3)),
  ];
  const result = flattenTheme(tokens, theme(["Base"]));
  assert.deepEqual(result.tokens.map((token) => token.path), ["a.two", "m.three", "z.one"]);
});

test("provenance is stripped — $extensions never reaches the export tree", () => {
  const tokens: FlatToken[] = [flat("a", "Base", varToken("number", 1))];
  const [entry] = flattenTheme(tokens, theme(["Base"])).tokens;
  assert.deepEqual(Object.keys(entry.token).sort(), ["$type", "$value"]);
});

test("a description survives, because Style Dictionary emits it as a comment", () => {
  const token = varToken("number", 1);
  token.$description = "Base unit";
  const [entry] = flattenTheme([flat("a", "Base", token)], theme(["Base"])).tokens;
  assert.equal(entry.token.$description, "Base unit");
});

// ---------------------------------------------------------------------------
// The Style Dictionary input tree
// ---------------------------------------------------------------------------

test("the tree nests by path segment", () => {
  const tokens: FlatToken[] = [
    flat("core.space.4", "Base", varToken("number", 4)),
    flat("core.color.bg", "Base", varToken("color", "#ffffff")),
  ];
  const flattened = flattenTheme(tokens, theme(["Base"]));
  const tree = toStyleDictionaryTokens(flattened.tokens, "Light");
  assert.deepEqual(tree.diagnostics, []);
  assert.deepEqual(tree.tokens, {
    core: {
      color: { bg: { $type: "color", $value: "#ffffff" } },
      space: { "4": { $type: "number", $value: 4 } },
    },
  });
});

test("a path blocked by another token is a named conflict, not a silent overwrite", () => {
  const tokens: FlatToken[] = [
    flat("a.b", "Base", varToken("number", 1)),
    flat("a.b.c", "Base", varToken("number", 2)),
  ];
  const flattened = flattenTheme(tokens, theme(["Base"]));
  const tree = toStyleDictionaryTokens(flattened.tokens, "Light");
  assert.equal(tree.diagnostics.length, 1);
  assert.equal(tree.diagnostics[0].kind, "path-conflict");
  assert.equal(tree.diagnostics[0].path, "a.b.c");
});
