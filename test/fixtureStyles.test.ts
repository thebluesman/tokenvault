// Regression test over the merged Variables + Styles import — ADR-0003.
//
// The Variables half is the real capture Phase 2 committed: `figma-snapshot.json` is the verbatim
// output of `src/figma/scan.ts` against https://www.figma.com/design/1ttG81lWKg74GUHq4aBnxl.
//
// The Styles half (`styles-snapshot.json`) is hand-authored in the exact shape `scanStyles`
// emits, and is a placeholder for a live capture — see the note at the bottom of this file.
// It is built to exercise the cases ADR-0003 actually decides rather than to look plausible:
//
//   - a paint style bound to the Variable at its own path       → redundant-style (§4)
//   - a paint style name-matching a Variable, with no binding   → cross-set, Variables win (§5)
//   - a paint and a text style at the same path                 → style-vs-style, name order (§5)
//   - gradient, image-over-solid stack                          → unmappable-value (§3)
//   - a two-shadow style, and an inner shadow                   → array / inset composites (§3)
//   - shadow + blur, blur only, invisible-only                  → partial-token / unmappable (§3)
//   - AUTO line height, an unmapped font style string           → partial-token (§3, §6)
//   - a text style binding a Variable to paragraphSpacing       → figma.boundVariables (§3)
//   - columns and grid layout grids                             → the `grid` divergence (§3)
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
  const token = tokenAt(file("tokens/styles/text.json"), "heading.xl");
  assert.equal(token?.$type, "typography");
  assert.deepEqual(token?.$value, {
    fontFamily: "Inter",
    fontSize: { unit: "px", value: 32 },
    fontWeight: 600,
    letterSpacing: { unit: "em", value: -0.015 },
    lineHeight: 1.2,
  });
});

test("an effect style's several shadows stay one ordered composite token", () => {
  const token = tokenAt(file("tokens/styles/effect.json"), "elevation.raised");
  assert.equal(token?.$type, "shadow");
  const shadows = token?.$value as Array<{ offsetY: { value: number }; spread: { value: number } }>;
  assert.equal(shadows.length, 2);
  assert.deepEqual(shadows.map((shadow) => shadow.offsetY.value), [1, 4]);
  assert.equal(shadows[1].spread.value, -2);
});

test("an inner shadow round-trips as an inset shadow", () => {
  const token = tokenAt(file("tokens/styles/effect.json"), "elevation.inset");
  assert.equal((token?.$value as { inset: boolean }).inset, true);
});

test("the real-shaped file exercises every ADR-0003 report kind", () => {
  const kinds = new Set(run().report.entries.map((entry) => entry.kind));
  for (const kind of ["collision", "unmappable-value", "partial-token", "redundant-style"]) {
    assert.ok(kinds.has(kind as never), `expected a "${kind}" entry`);
  }

  const found = reasons();
  for (const reason of [
    "mirrors-variable",
    "gradient-paint",
    "multi-paint",
    "unsupported-effect",
    "auto-line-height",
    "unmapped-font-style",
    "cross-set",
  ]) {
    assert.ok(found.includes(reason), `expected a "${reason}" entry, got: ${found.join(", ")}`);
  }
});

test("the Variable wins the cross-source clash, and the style is not written", () => {
  const result = run();
  const clash = result.report.entries.filter(
    (entry) => entry.reason === "cross-set" && entry.path === "tv.color.text.accent"
  )[0];

  assert.ok(clash, "expected the paint style to contest the Variable's path");
  assert.equal(clash.winnerRule, "source-precedence");
  assert.equal(clash.participants?.filter((p) => p.outcome === "written")[0].variableName, "tv/color/text/accent");
  assert.equal(clash.participants?.filter((p) => p.outcome === "skipped")[0].styleId, "S:p2");
  assert.equal(tokenAt(file("tokens/styles/paint.json"), "tv.color.text.accent"), undefined);
});

test("the provable mirror is reported as redundant rather than as a collision", () => {
  const result = run();
  const mirror = result.report.entries.filter((entry) => entry.reason === "mirrors-variable")[0];

  assert.equal(mirror.kind, "redundant-style");
  assert.equal(mirror.path, "tv.ref.palette.blue-500");
  // And it is NOT also reported as a clash — that is the whole point of §4.
  assert.equal(
    result.report.entries.some(
      (entry) => entry.reason === "cross-set" && entry.path === "tv.ref.palette.blue-500"
    ),
    false
  );
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
