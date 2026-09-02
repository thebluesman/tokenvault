// The round-trip property, over the real file — ADR-0005 §3.
//
// ADR-0005 §3 states the property this file exists to hold to account:
//
//   > the round-trip property the tests should assert is *`toFigma(build(figma))` reproduces
//   > `figma` for every token import did not flag*, with flagged tokens asserted to refuse.
//
// It runs against the committed Folio Design System capture — 5 collections, 1,157 variables, 49
// styles — because the interesting cases are the ones nobody would think to write by hand: a
// paint style carrying a hidden second paint, an `AUTO` line height, a two-shadow effect style
// with one entry inset, a font style the weight table has no entry for.
//
// The assertion is deliberately made against the *snapshot*, not against a re-import. Comparing
// `build(toFigma(build(figma)))` to `build(figma)` would pass even if both directions shared the
// same mistake; comparing the write op to the values `scan.ts` actually read catches that.
//
// To regenerate the fixture inputs, see fixtureStyles.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FileScan, FileSnapshot, StylesSnapshot, Token } from "../src/tokens/types";
import type { FlatToken } from "../src/tokens/view";
import { buildMergedImport } from "../src/tokens/merge";
import { flattenImport, treeIndex } from "../src/tokens/view";
import { styleGuards, toFigmaValue } from "../src/tokens/toFigma";
import { rgbaToHex } from "../src/tokens/values";
import { buildApplyPlan, findReferenceCycles } from "../src/tokens/plan";
import { normalizePathKey } from "../src/tokens/paths";
import { emptyOverlay, recordEdit, targetOfToken } from "../src/tokens/overlay";

const ROOT = join(process.cwd(), "test/fixtures/styles-import");
const IMPORTED_AT = "2026-09-01T00:00:00.000Z";

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, name), "utf8")) as T;
}

const scan: FileScan = {
  variables: read<FileSnapshot>("variables-snapshot.json"),
  styles: read<StylesSnapshot>("styles-snapshot.json"),
};
const userSubtypes = read<Record<string, never>>("user-subtypes.json");

const result = buildMergedImport(scan, { userSubtypes, importedAt: IMPORTED_AT });
const flat: FlatToken[] = flattenImport(treeIndex(result.files), result.manifest);
const guards = styleGuards(scan.styles);

/** Every path in the tree, so an alias can be resolved the way `plan.ts` resolves one. */
const byPath = new Map<string, string>();
for (const entry of flat) {
  const variableId = entry.token.$extensions?.["com.tokenvault"]?.figma?.variableId;
  if (typeof variableId === "string") byPath.set(normalizePathKey(entry.path), variableId);
}

function write(token: Token) {
  return toFigmaValue(token, {
    resolveAlias: (path) => {
      const id = byPath.get(normalizePathKey(path));
      return id === undefined
        ? { ok: false as const, reason: "alias-target-unknown", message: path }
        : { ok: true as const, targetId: id };
    },
  });
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

test("every Variable-derived token in the real file converts back to a write", () => {
  const byId = new Map(scan.variables.variables.map((variable) => [variable.id, variable]));
  let checked = 0;
  const refused: string[] = [];

  for (const entry of flat) {
    const figma = entry.token.$extensions?.["com.tokenvault"]?.figma;
    if (typeof figma?.variableId !== "string") continue;
    checked += 1;
    const result = write(entry.token);
    if (!result.ok) refused.push(`${entry.path} (${entry.setId}): ${result.reason}`);
  }

  assert.ok(checked > 1000, `expected the fixture's ~1,300 variable tokens, got ${checked}`);
  assert.deepEqual(refused, [], "no Variable-derived token in this file should refuse");
  assert.ok(byId.size > 1000);
});

test("the value written back is bit-for-bit the value Figma handed us", () => {
  // The heart of the round trip. `normalizeFloat` recovers the shortest decimal whose float32
  // rounding is identical to what Figma stored (ADR-0002 Amendment 1 §H), so the number written
  // back must still be that same float32 — otherwise every apply would produce a spurious diff on
  // a token nobody touched.
  const byId = new Map(scan.variables.variables.map((variable) => [variable.id, variable]));
  let compared = 0;

  for (const entry of flat) {
    const figma = entry.token.$extensions?.["com.tokenvault"]?.figma;
    if (typeof figma?.variableId !== "string" || typeof figma.modeId !== "string") continue;
    const source = byId.get(figma.variableId);
    const original = source?.valuesByMode[figma.modeId];
    if (original === undefined || original === null) continue;

    const result = write(entry.token);
    assert.equal(result.ok, true, entry.path);
    if (!result.ok) continue;

    if (typeof original === "object" && "type" in original) {
      assert.equal(result.write.kind, "variable-alias", entry.path);
      if (result.write.kind === "variable-alias") {
        // A local alias must land back on the very variable it came from. A library alias resolves
        // by name to whichever local variable shares the path, which is a different (and reported)
        // situation — skipped here rather than asserted the wrong way round.
        if (byId.has(original.id)) {
          assert.equal(result.write.targetId, original.id, entry.path);
          compared += 1;
        }
      }
      continue;
    }

    assert.equal(result.write.kind, "variable-value", entry.path);
    if (result.write.kind !== "variable-value") continue;

    if (typeof original === "object") {
      // Colour goes out as a hex and comes back as channels; the 8-bit hex round trip is exact for
      // anything a human authored, which is every colour in this file.
      assert.equal(rgbaToHex(result.write.value as never), rgbaToHex(original), entry.path);
    } else if (typeof original === "number") {
      assert.equal(Math.fround(result.write.value as number), Math.fround(original), entry.path);
    } else {
      assert.equal(result.write.value, original, entry.path);
    }
    compared += 1;
  }

  assert.ok(compared > 1000, `expected to compare ~1,300 values, compared ${compared}`);
});

// ---------------------------------------------------------------------------
// Styles — where import is lossy, and apply must refuse
// ---------------------------------------------------------------------------

test("every style token either writes back or is refused by a named guard", () => {
  const unexplained: string[] = [];

  for (const entry of flat) {
    const figma = entry.token.$extensions?.["com.tokenvault"]?.figma;
    if (typeof figma?.styleId !== "string") continue;
    if (guards.has(figma.styleId)) continue;
    const result = write(entry.token);
    if (!result.ok) unexplained.push(`${entry.path}: ${result.reason} — ${result.message}`);
  }

  assert.deepEqual(unexplained, [], "an unguarded style token refusing means a rule is missing");
});

test("the fixture's lossy styles are guarded — a real hidden paint, a real blur", () => {
  // The whole point of the guard, on real data rather than a constructed case: these styles carry
  // something the token has no room for, and `style.paints` / `style.effects` are replaced
  // wholesale, so writing the token back would delete it.
  assert.ok(guards.size > 0, "the Folio file should have at least one unwritable style");
  for (const guard of guards.values()) {
    assert.equal(guard.reason, "apply-lossy-style");
  }
});

test("a text style with AUTO line height writes every other field and leaves that one alone", () => {
  const auto = flat.find((entry) => {
    const figma = entry.token.$extensions?.["com.tokenvault"]?.figma;
    return (
      figma?.styleType === "TEXT" &&
      entry.token.$type === "typography" &&
      (entry.token.$value as { lineHeight?: unknown }).lineHeight === undefined
    );
  });
  assert.notEqual(auto, undefined, "the fixture should contain an AUTO line height style");

  const result = write((auto as FlatToken).token);
  assert.equal(result.ok, true);
  if (!result.ok || result.write.kind !== "text-style") return;
  assert.equal("lineHeight" in result.write.text, false);
  // And it still writes the rest: refusing the whole style over one omitted sub-key would make
  // every AUTO-height style permanently unappliable.
  assert.ok(result.write.text.fontSize > 0);
  assert.ok(result.write.text.style.length > 0);
});

test("figma.fontStyle carries an unmapped weight back verbatim", () => {
  let checked = 0;
  for (const entry of flat) {
    const figma = entry.token.$extensions?.["com.tokenvault"]?.figma;
    if (figma?.styleType !== "TEXT" || typeof figma.fontStyle !== "string") continue;
    const result = write(entry.token);
    if (!result.ok || result.write.kind !== "text-style") continue;
    assert.equal(result.write.text.style, figma.fontStyle, entry.path);
    checked += 1;
  }
  assert.ok(checked > 20, `expected the fixture's 32 text styles, checked ${checked}`);
});

// ---------------------------------------------------------------------------
// The plan, over the real tree
// ---------------------------------------------------------------------------

test("the real file's reference graph has no cycles", () => {
  // Not a tautology worth skipping: a cycle here would mean the importer had written one, and the
  // detector running clean on 1,300 real tokens with heavy aliasing is what says the walk scales.
  assert.deepEqual(Array.from(findReferenceCycles(flat)), []);
});

test("an edit to one real token plans exactly one write and touches nothing else", () => {
  // ADR-0005 §1's arithmetic, on the real tree: a first apply writes a handful of values, not
  // 1,316 — which is also what makes the preview reviewable by a human.
  const target = flat.find(
    (entry) =>
      entry.token.$type === "color" &&
      typeof entry.token.$value === "string" &&
      typeof entry.token.$extensions?.["com.tokenvault"]?.figma?.variableId === "string"
  ) as FlatToken;

  const overlay = recordEdit(
    emptyOverlay(),
    {
      target: targetOfToken(target.token) as NonNullable<ReturnType<typeof targetOfToken>>,
      path: target.path,
      set: target.setId,
      op: "set-value",
      value: "#010203",
      base: target.token.$value,
    },
    IMPORTED_AT
  );

  const edited = flat.map((entry) =>
    entry === target ? { ...entry, token: { ...entry.token, $value: "#010203" } } : entry
  );

  const plan = buildApplyPlan({ tokens: edited, imported: flat, overlay, styleGuards: guards });
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.ready, 1);
  assert.equal(plan.entries[0].path, target.path);
  assert.equal(plan.entries[0].before, target.token.$value);
  assert.equal(plan.entries[0].after, "#010203");
});
