// Regression test over the merged Variables + Styles import — ADR-0003.
//
// Both halves are one coherent capture of a single Figma file: the Folio Design System, taken
// with the plugin's "Copy Figma scan (fixture input)" button and split into the two snapshots
// `scan.ts` and `scanStyles.ts` respectively produce.
//
//   - `variables-snapshot.json` — 5 collections, 1157 variables
//   - `styles-snapshot.json`    — 8 paint, 32 text, 8 effect, 1 grid
//
// Single-file coherence is the point. A style can only bind to a Variable in its own file, so the
// two rules that decide what happens when a style and a Variable describe the same thing — the
// mirror rule (§4) and the cross-SOURCE clash (§5) — are only reachable from a scan whose halves
// came from one file. Both fire here on real data:
//
//   - `folio/ref/palette/neutral/white` — a paint bound to the Variable of the same name
//                                                                → redundant-style / mirrors-variable
//   - `folio/ref/palette/neutral/black` — an unbound paint contesting the Variable of that name
//                                                                → collision / cross-set, Variable wins
//
// and alongside them:
//
//   - gradient and multi-paint stacks                            → unmappable-value (§3)
//   - a two-shadow style, one entry inset                        → array / inset composites (§3)
//   - unsupported effects                                        → partial-token / unmappable (§3)
//   - AUTO line height                                           → partial-token (§3, §6)
//   - columns and grid layout grids                              → the `grid` divergence (§3)
//
// One ADR-0003 case is still not reachable from this file — `unmapped-font-style` (§6). See the
// note at the bottom.
//
// To regenerate after an intentional schema change, or after recapturing the file with the
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
const IMPORTED_AT = "2026-09-01T00:00:00.000Z";
const UPDATE = process.env.UPDATE_FIXTURE === "1";

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const variables = JSON.parse(read("variables-snapshot.json")) as FileSnapshot;
const styles = JSON.parse(read("styles-snapshot.json")) as StylesSnapshot;
const userSubtypes = JSON.parse(read("user-subtypes.json")) as Record<string, Subtype>;

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

test("both halves of the scan come from the same Figma file", () => {
  // The guard on everything below: a style's `boundVariableId` is only meaningful against
  // Variables from its own file. If someone repoints one snapshot at another capture, the mirror
  // and cross-source assertions would silently stop testing what they claim to.
  assert.equal(variables.fileName, "Folio Design System");

  const boundToWhite = styles.paint
    .filter((style) => style.name === "folio/ref/palette/neutral/white")
    .flatMap((style) => style.paints)
    .map((paint) => paint.boundVariableId);
  assert.deepEqual(boundToWhite, ["VariableID:2:3"]);

  const white = variables.variables.filter((variable) => variable.id === "VariableID:2:3")[0];
  assert.equal(white?.name, "folio/ref/palette/neutral/white");
});

// ---------------------------------------------------------------------------------------------
// The two single-file rules — ADR-0003 §4 and §5
// ---------------------------------------------------------------------------------------------

test("a paint bound to the Variable it shares a path with is reported, not written twice", () => {
  // ADR-0003 §4. The style carries no information the Variable does not already carry, so it is
  // dropped as redundant rather than contested — this is informational, not a collision.
  const result = run();
  const mirror = result.report.entries.filter((entry) => entry.reason === "mirrors-variable")[0];

  assert.ok(mirror, "expected the bound white paint to trip the mirror rule");
  assert.equal(mirror.kind, "redundant-style");
  assert.equal(mirror.path, "folio.ref.palette.neutral.white");
  assert.equal(mirror.set, "Styles/Paint");
  assert.deepEqual(
    mirror.participants?.map((participant) => [participant.styleName, participant.outcome]),
    [["folio/ref/palette/neutral/white", "skipped"]]
  );

  // The Variable's token is the one on disk, and it is a Variable token — not a style token that
  // happened to land at the same path.
  const token = tokenAt(file("tokens/base/mode-1.json"), "folio.ref.palette.neutral.white");
  assert.equal(token?.$type, "color");
  assert.ok(token?.$extensions["com.tokenvault"].figma.variableId);
});

test("an unbound paint that name-matches a Variable loses to it, and both are named", () => {
  // ADR-0003 §5. `black` is the counterpart to `white`: same shape of clash, but with no binding,
  // so it is a genuine contest rather than a redundancy — and source precedence decides it.
  const result = run();
  const clash = result.report.entries.filter((entry) => entry.reason === "cross-set")[0];

  assert.ok(clash, "expected the unbound black paint to contest the Variable of that name");
  assert.equal(clash.kind, "collision");
  assert.equal(clash.path, "folio.ref.palette.neutral.black");
  assert.equal(clash.winnerRule, "source-precedence");

  const written = clash.participants?.filter((participant) => participant.outcome === "written");
  const skipped = clash.participants?.filter((participant) => participant.outcome === "skipped");

  assert.equal(written?.length, 1);
  assert.equal(written?.[0].variableId, "VariableID:2:4");
  assert.equal(written?.[0].variableName, "folio/ref/palette/neutral/black");
  assert.equal(written?.[0].collectionName, "Base");

  assert.equal(skipped?.length, 1);
  assert.equal(skipped?.[0].styleName, "folio/ref/palette/neutral/black");

  // The surviving token is the Variable's, and the style's version reached no file at all.
  const token = tokenAt(file("tokens/base/mode-1.json"), "folio.ref.palette.neutral.black");
  assert.equal(token?.$extensions["com.tokenvault"].figma.variableId, "VariableID:2:4");

  const paintWritten = run().files.some((output) => output.path === "tokens/styles/paint.json");
  assert.equal(paintWritten, false, "the style version must not have been written anywhere");
});

// ---------------------------------------------------------------------------------------------

test("every style in the scan is either written or explains itself in the report", () => {
  // Stronger than counting output files: nothing may be dropped silently. Paint is the case that
  // matters most here — all eight of Folio's paint styles are eliminated, so `paint.json` is not
  // written at all, and the only thing standing between that and a silent regression is this.
  const result = run();
  const reported = new Set(
    result.report.entries.flatMap((entry) =>
      (entry.participants ?? []).map((participant) => participant.styleId).filter(Boolean)
    )
  );

  const written = new Set<string>();
  for (const output of result.files) {
    if (!output.path.startsWith("tokens/styles/")) continue;
    walk(output.content as TokenGroup, (token) => {
      const id = token.$extensions["com.tokenvault"].figma.styleId;
      if (id) written.add(id);
    });
  }

  const all = [...styles.paint, ...styles.text, ...styles.effect, ...styles.grid];
  assert.equal(all.length, 49, "the capture's style count changed — re-check this accounting");

  for (const style of all) {
    assert.ok(
      written.has(style.id) || reported.has(style.id),
      `"${style.name}" was neither written nor reported`
    );
  }

  // All eight paint styles specifically, since that whole set vanishes from the output.
  for (const paint of styles.paint) {
    assert.ok(reported.has(paint.id), `paint "${paint.name}" vanished without a report entry`);
  }
});

test("the style sets written are exactly the kinds that survived", () => {
  const written = run()
    .files.map((output) => output.path)
    .filter((path) => path.startsWith("tokens/styles/"));

  // No `paint.json`: Folio's eight paint styles are two gradients, four multi-paint stacks, one
  // mirror of a Variable and one loss to a Variable — every one of them legitimately eliminated.
  // A set with no surviving members is not written (merge.ts `buildStyleFiles`).
  assert.deepEqual(written, [
    "tokens/styles/effect.json",
    "tokens/styles/grid.json",
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

test("the real file exercises the ADR-0003 report kinds it can reach", () => {
  const kinds = new Set(run().report.entries.map((entry) => entry.kind));
  for (const kind of ["collision", "unmappable-value", "partial-token", "redundant-style"]) {
    assert.ok(kinds.has(kind as never), `expected a "${kind}" entry`);
  }

  const found = reasons();
  for (const reason of [
    "gradient-paint",
    "multi-paint",
    "unsupported-effect",
    "auto-line-height",
    "cross-set",
    "mirrors-variable",
  ]) {
    assert.ok(found.includes(reason), `expected a "${reason}" entry, got: ${found.join(", ")}`);
  }
});

test("style tokens are mode-free and appear in every theme, in first position", () => {
  const manifest = run().manifest as Manifest;
  assert.equal(manifest.version, 2);
  assert.ok(manifest.styleSets && manifest.styleSets.length === 3);

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

function walk(node: TokenGroup, visit: (token: Token) => void): void {
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (child === null || typeof child !== "object") continue;
    if (isToken(child)) visit(child);
    else walk(child as TokenGroup, visit);
  }
}

// ---------------------------------------------------------------------------------------------
// Known gap in this fixture, and where the logic is covered instead.
//
// `unmapped-font-style` (ADR-0003 §6). The weight table recognises thin/hairline/extralight/
// ultralight/light/regular/normal/book/roman/medium/semibold/demibold/demi/bold/extrabold/
// ultrabold/black/heavy/extrablack/ultrablack, plus italic/oblique as slant. Triggering the
// fallback needs a font whose style name sits outside that list — a variable-width family's
// "Condensed" or "Expanded", say — and no such font is used in this file. Covered synthetically
// by "an unrecognised font style keeps the raw string and is flagged" in
// `test/styleValues.test.ts`. Worth re-checking against live data if such a font lands.
//
// (The mirror rule and the cross-source clash used to be listed here too, when this fixture
// merged Folio's styles with Phase 2's Variables capture from a different file. Both are now
// reachable from real data and asserted above; `test/merge.test.ts` keeps the synthetic cases
// that pin the surrounding edges — the tie-break when a Variable's name sorts after the style's,
// and a mirrored style whose Variable was itself never written.)
// ---------------------------------------------------------------------------------------------
