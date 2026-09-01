// Regression test over the merged Variables + Styles import — ADR-0003.
//
// The Variables half is the real capture Phase 2 committed: `figma-snapshot.json` is the verbatim
// output of `src/figma/scan.ts` against https://www.figma.com/design/1ttG81lWKg74GUHq4aBnxl.
//
// The Styles half (`styles-snapshot.json`) is a live capture too: the verbatim output of
// `scanStyles` against the Folio Design System file, taken with the plugin's
// "Copy Figma scan (fixture input)" button. Between them the two halves exercise:
//
//   - a paint style name-matching a Variable, with no binding   → cross-set, Variables win (§5)
//   - gradient and multi-paint stacks                           → unmappable-value (§3)
//   - a two-shadow style, one entry inset                       → array / inset composites (§3)
//   - unsupported effects                                       → partial-token / unmappable (§3)
//   - AUTO line height                                          → partial-token (§3, §6)
//   - columns and grid layout grids                             → the `grid` divergence (§3)
//
// Two ADR-0003 cases are deliberately NOT covered here, and are covered by synthetic unit tests
// instead — see the note at the bottom of this file:
//
//   - `mirrors-variable` / redundant-style (§4), and the cross-source clash it competes with,
//     because the two halves come from two different Figma files (see below)
//   - `unmapped-font-style` (§6), pending a font with a non-standard style name
//
// To regenerate after an intentional schema change, or after capturing a real file with the
// plugin's "Copy Figma scan (fixture input)" button:
//   UPDATE_FIXTURE=1 npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildMergedImport } from "../src/tokens/merge";
import { stableStringify } from "../src/tokens/serialize";
import type {
  FileScan,
  FileSnapshot,
  Manifest,
  StylesSnapshot,
  Subtype,
  Token,
  TokenGroup,
} from "../src/tokens/types";
import { isToken } from "../src/tokens/paths";

// npm scripts run from the repo root.
const ROOT = join(process.cwd(), "test/fixtures/styles-import");
const VARIABLES_ROOT = join(process.cwd(), "test/fixtures/variables-import");
const IMPORTED_AT = "2026-09-01T00:00:00.000Z";
const UPDATE = process.env.UPDATE_FIXTURE === "1";

const variables = JSON.parse(
  readFileSync(join(VARIABLES_ROOT, "figma-snapshot.json"), "utf8")
) as FileSnapshot;
const styles = JSON.parse(readFileSync(join(ROOT, "styles-snapshot.json"), "utf8")) as StylesSnapshot;
const userSubtypes = JSON.parse(
  readFileSync(join(VARIABLES_ROOT, "user-subtypes.json"), "utf8")
) as Record<string, Subtype>;

const scan: FileScan = { variables, styles };

function run() {
  return buildMergedImport(scan, { userSubtypes, importedAt: IMPORTED_AT });
}

function tokenAt(tree: TokenGroup, path: string): Token | undefined {
  let node: TokenGroup | Token | undefined = tree;
  for (const segment of path.split(".")) {
    if (node === undefined || isToken(node)) return undefined;
    node = (node as TokenGroup)[segment];
  }
  return node !== undefined && isToken(node) ? node : undefined;
}

function file(path: string): TokenGroup {
  const found = run().files.filter((item) => item.path === path)[0];
  if (!found) throw new Error(`No generated file at ${path}`);
  return found.content as TokenGroup;
}

function reasons(): string[] {
  return run().report.entries.map((entry) => entry.reason);
}

test("the merged tree matches the committed fixture byte for byte", () => {
  const result = run();

  for (const output of result.files) {
    const serialized = stableStringify(output.content);
    const target = join(ROOT, output.path);

    if (UPDATE) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, serialized);
      continue;
    }

    assert.equal(
      serialized,
      readFileSync(target, "utf8"),
      `${output.path} differs from the committed fixture. If the schema change is intentional, regenerate with UPDATE_FIXTURE=1 npm test`
    );
  }
});

test("all four style kinds import from one scan", () => {
  const written = run()
    .files.map((output) => output.path)
    .filter((path) => path.startsWith("tokens/styles/"));

  assert.deepEqual(written, [
    "tokens/styles/effect.json",
    "tokens/styles/grid.json",
    "tokens/styles/paint.json",
    "tokens/styles/text.json",
  ]);
});

test("a text style's family, size, weight and line height stay one composite token", () => {
  // Issue #3's acceptance criterion: composite styles map to composite tokens, not to flattened
  // leaf tokens per property.
  const token = tokenAt(file("tokens/styles/text.json"), "Display.Display Large");
  assert.equal(token?.$type, "typography");
  assert.deepEqual(token?.$value, {
    fontFamily: "Fraunces",
    fontSize: { unit: "px", value: 52 },
    fontWeight: 600,
    letterSpacing: { unit: "em", value: 0 },
    lineHeight: { unit: "px", value: 64 },
  });
});

// Folio's one multi-effect style. Both entries carry the same geometry; what distinguishes them
// — and what the composite has to preserve in order — is `inset`.
test("an effect style's several shadows stay one ordered composite token", () => {
  const token = tokenAt(file("tokens/styles/effect.json"), "folio.effects.liquid-glass.test");
  assert.equal(token?.$type, "shadow");
  const shadows = token?.$value as Array<{
    blur: { value: number };
    inset: boolean;
    offsetY: { value: number };
    spread: { value: number };
  }>;
  assert.equal(shadows.length, 2);
  assert.deepEqual(shadows.map((shadow) => shadow.offsetY.value), [4, 4]);
  assert.deepEqual(shadows.map((shadow) => shadow.blur.value), [4, 4]);
  assert.deepEqual(shadows.map((shadow) => shadow.spread.value), [0, 0]);
  assert.deepEqual(shadows.map((shadow) => shadow.inset), [true, false]);
});

test("an inner shadow round-trips as an inset shadow", () => {
  const token = tokenAt(file("tokens/styles/effect.json"), "folio.effects.liquid-glass.test");
  const shadows = token?.$value as Array<{ inset: boolean }>;
  assert.ok(
    shadows.some((shadow) => shadow.inset === true),
    "expected an INNER_SHADOW entry to survive as inset: true"
  );
});

// `redundant-style` / `mirrors-variable` and `unmapped-font-style` are absent by construction —
// see the note at the bottom of this file. Both are covered synthetically.
test("the real file exercises the ADR-0003 report kinds it can reach", () => {
  const kinds = new Set(run().report.entries.map((entry) => entry.kind));
  for (const kind of ["collision", "unmappable-value", "partial-token"]) {
    assert.ok(kinds.has(kind as never), `expected a "${kind}" entry`);
  }

  const found = reasons();
  for (const reason of [
    "gradient-paint",
    "multi-paint",
    "unsupported-effect",
    "auto-line-height",
    "cross-set",
  ]) {
    assert.ok(found.includes(reason), `expected a "${reason}" entry, got: ${found.join(", ")}`);
  }
});

test("a cross-set clash names both contenders and writes only the winner", () => {
  const result = run();
  const clash = result.report.entries.filter((entry) => entry.reason === "cross-set")[0];

  assert.ok(clash, "expected at least one cross-set clash in the real data");
  assert.equal(clash.kind, "collision");
  assert.ok(clash.path);
  assert.equal(clash.participants?.filter((p) => p.outcome === "written").length, 1);
  assert.ok((clash.participants?.filter((p) => p.outcome === "skipped").length ?? 0) >= 1);
});

test("style tokens are mode-free and appear in every theme, in first position", () => {
  const manifest = run().manifest as Manifest;
  assert.equal(manifest.version, 2);
  assert.ok(manifest.styleSets && manifest.styleSets.length === 4);

  const styleSetIds = manifest.styleSets.map((set) => set.set);
  for (const theme of manifest.themes) {
    assert.deepEqual(theme.selectedTokenSets.slice(0, styleSetIds.length), styleSetIds);
  }
});

test("nothing degraded is silently degraded — every partial token names what it lost", () => {
  for (const entry of run().report.entries) {
    if (entry.kind !== "partial-token") continue;
    assert.ok(entry.path, `${entry.reason} has no path`);
    assert.ok(entry.set, `${entry.reason} has no set`);
    assert.ok(entry.message.length > 0);
  }
});

test("float32 storage noise does not leak into a style token value", () => {
  const json = run()
    .files.map((output) => stableStringify(output.content))
    .join("");
  assert.equal(/\d\.\d{12,}/.test(json), false, "a float32 artefact reached a $value");
});

test("the import is stable: the same scan twice produces the same bytes", () => {
  const first = run().files.map((output) => stableStringify(output.content)).join("");
  const second = run().files.map((output) => stableStringify(output.content)).join("");
  assert.equal(first, second);
});

// ---------------------------------------------------------------------------------------------
// Known gaps in this fixture, and where the logic is covered instead.
//
// 1. `mirrors-variable` (ADR-0003 §4) and the cross-SOURCE clash it competes with.
//    This fixture merges two halves captured from two DIFFERENT Figma files: the Variables half
//    is Phase 2's frozen capture (namespace `tv/*`), the Styles half is Folio Design System
//    (namespace `folio/*`). A paint style can only bind to a Variable in its own file, so no
//    Folio style can ever bind — or collide on path — with a `tv/*` Variable. The mirror rule is
//    structurally unreachable here, not merely unexercised. Recapturing the Variables half from
//    Folio would fix that, but ADR-0003 never required the two halves to be single-file coherent,
//    and Phase 2's committed capture is a regression baseline in its own right. So the mirror
//    rule stays covered by `test/merge.test.ts`, on scans built to be single-file:
//      - "a Variable beats a Style at the same path, and both are reported"
//      - "the Variable wins even when its name sorts after the style's"
//      - "a mirrored style is informational, not a collision"
//    The `cross-set` clashes this file DOES exercise are Variable-vs-Variable ones, which is a
//    real case, just not the cross-source one.
//
// 2. `unmapped-font-style` (ADR-0003 §6). The weight table recognises thin/hairline/extralight/
//    ultralight/light/regular/normal/book/roman/medium/semibold/demibold/demi/bold/extrabold/
//    ultrabold/black/heavy/extrablack/ultrablack, plus italic/oblique as slant. Triggering the
//    fallback needs a font whose style name sits outside that list — a variable-width family's
//    "Condensed" or "Expanded", say — and no such font was available in the captured library.
//    Covered synthetically by "an unrecognised font style keeps the raw string and is flagged"
//    in `test/styleValues.test.ts`. Worth re-checking against live data if such a font lands.
// ---------------------------------------------------------------------------------------------
