import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isStrictPathPrefix,
  isToken,
  normalizePathKey,
  setTokenAtPath,
  slugify,
  splitVariableName,
  toDottedPath,
} from "../src/tokens/paths";
import type { Token, TokenGroup } from "../src/tokens/types";

function token(value: string): Token {
  return {
    $type: "color",
    $value: value,
    $extensions: {
      "com.tokenvault": {
        figma: { variableId: "v", collectionId: "c", modeId: "m", scopes: [] },
      },
    },
  };
}

test("splitVariableName keeps segments verbatim — no casing, slugging or prefixing", () => {
  assert.deepEqual(splitVariableName("atlas/ref/palette/neutral/black"), [
    "atlas",
    "ref",
    "palette",
    "neutral",
    "black",
  ]);
  assert.deepEqual(splitVariableName("Color/Brand Primary"), ["Color", "Brand Primary"]);
});

test("splitVariableName drops empty segments from stray slashes", () => {
  assert.deepEqual(splitVariableName("/a//b/"), ["a", "b"]);
  assert.deepEqual(splitVariableName("///"), []);
  assert.deepEqual(splitVariableName("  "), []);
});

test("toDottedPath produces the reference form", () => {
  assert.equal(toDottedPath("tv/ref/palette/blue-500"), "tv.ref.palette.blue-500");
});

test("slugify lowercases and collapses non-alphanumerics", () => {
  assert.equal(slugify("Core"), "core");
  assert.equal(slugify("Theme (2024)"), "theme-2024");
  assert.equal(slugify("  Light  "), "light");
  assert.equal(slugify("!!!"), "untitled");
});

test("isStrictPathPrefix matches whole segments only", () => {
  assert.equal(isStrictPathPrefix("a.b", "a.b.c"), true);
  assert.equal(isStrictPathPrefix("a.b", "a.bc"), false);
  assert.equal(isStrictPathPrefix("a.b", "a.b"), false);
});

test("normalizePathKey folds case for collision keys", () => {
  assert.equal(normalizePathKey("Color.Brand"), "color.brand");
});

test("setTokenAtPath builds nested groups", () => {
  const root: TokenGroup = {};
  assert.equal(setTokenAtPath(root, ["a", "b", "c"], token("#000000")), true);
  const group = root["a"] as TokenGroup;
  assert.equal(isToken(group), false);
  assert.equal(((group["b"] as TokenGroup)["c"] as Token).$value, "#000000");
});

test("setTokenAtPath refuses to overwrite a token or nest under one", () => {
  const root: TokenGroup = {};
  setTokenAtPath(root, ["a", "b"], token("#111111"));

  // Same leaf twice.
  assert.equal(setTokenAtPath(root, ["a", "b"], token("#222222")), false);
  // Nesting under an existing token leaf.
  assert.equal(setTokenAtPath(root, ["a", "b", "c"], token("#333333")), false);
  // The original survives untouched.
  assert.equal(((root["a"] as TokenGroup)["b"] as Token).$value, "#111111");
});

test("setTokenAtPath rejects an empty path", () => {
  assert.equal(setTokenAtPath({}, [], token("#000000")), false);
});
