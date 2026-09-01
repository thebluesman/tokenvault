// Merging the Variables and Styles imports — ADR-0003 §1, §5, §7.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMergedImport } from "../src/tokens/merge";
import { stableStringify } from "../src/tokens/serialize";
import type { FileScan, Manifest, ReportEntry, TokenGroup } from "../src/tokens/types";
import {
  IMPORTED_AT,
  collection,
  columnsGrid,
  effectStyle,
  fileAt,
  gridStyle,
  noVariables,
  paintStyle,
  scan,
  shadow,
  snapshot,
  solid,
  styles,
  textStyle,
  tokenAt,
  variable,
} from "./helpers";

const BLUE = { r: 45 / 255, g: 127 / 255, b: 249 / 255 };

function build(input: FileScan) {
  return buildMergedImport(input, { importedAt: IMPORTED_AT });
}

function paths(result: { files: Array<{ path: string }> }): string[] {
  return result.files.map((file) => file.path);
}

function entriesOf(result: { report: { entries: ReportEntry[] } }, reason: string): ReportEntry[] {
  return result.report.entries.filter((entry) => entry.reason === reason);
}

/** One collection, one mode, one colour variable — the smallest Variables side that writes. */
function oneVariable(name = "brand/primary") {
  const core = collection("VariableCollectionId:1:1", "Core", [["1:0", "Value"]]);
  return snapshot([core], [variable("VariableID:1:1", name, core.id, "COLOR", { "1:0": BLUE })]);
}

// ---------------------------------------------------------------------------
// Layout (ADR-0003 §1)
// ---------------------------------------------------------------------------

test("each style kind writes its own file under tokens/styles/", () => {
  const result = build(
    scan(
      noVariables(),
      styles({
        paint: [paintStyle("S:1", "brand/primary", [solid(BLUE)])],
        text: [textStyle("S:2", "heading/lg")],
        effect: [effectStyle("S:3", "elevation/1", [shadow("DROP_SHADOW")])],
        grid: [gridStyle("S:4", "layout/desktop", [columnsGrid()])],
      })
    )
  );

  assert.deepEqual(paths(result), [
    "tokens/$import-report.json",
    "tokens/$manifest.json",
    "tokens/styles/effect.json",
    "tokens/styles/grid.json",
    "tokens/styles/paint.json",
    "tokens/styles/text.json",
  ]);
});

test("a kind with no importable style writes no file at all", () => {
  // Per-kind files exist so a re-import that only touched effects only diffs effect.json; an
  // empty file for a kind the designer never used would be noise in every diff.
  const result = build(scan(noVariables(), styles({ text: [textStyle("S:1", "body")] })));
  assert.deepEqual(
    paths(result).filter((path) => path.startsWith("tokens/styles/")),
    ["tokens/styles/text.json"]
  );
});

test("a style whose only value was unmappable does not conjure an empty set", () => {
  const result = build(
    scan(noVariables(), styles({ grid: [gridStyle("S:1", "layout/desktop", [])] }))
  );
  assert.equal(paths(result).some((path) => path.startsWith("tokens/styles/")), false);
  assert.equal(result.manifest.styleSets, undefined);
});

test("style tokens keep their full composite value in the written file", () => {
  const result = build(
    scan(noVariables(), styles({ effect: [effectStyle("S:1", "elevation/1", [shadow("DROP_SHADOW")])] }))
  );

  const token = tokenAt(fileAt(result.files, "tokens/styles/effect.json"), "elevation.1");
  assert.equal(token?.$type, "shadow");
  assert.deepEqual(token?.$value, {
    blur: { unit: "px", value: 8 },
    color: "#00000029",
    inset: false,
    offsetX: { unit: "px", value: 0 },
    offsetY: { unit: "px", value: 2 },
    spread: { unit: "px", value: 0 },
  });
});

// ---------------------------------------------------------------------------
// Manifest (ADR-0003 §1)
// ---------------------------------------------------------------------------

test("the manifest goes to version 2 and grows styleSets, leaving collections untouched", () => {
  const result = build(
    scan(oneVariable("tv/brand"), styles({ text: [textStyle("S:1", "heading/lg")] }))
  );
  const manifest = result.manifest as Manifest;

  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.styleSets, [
    { file: "styles/text.json", kind: "TEXT", name: "Text", set: "Styles/Text", slug: "text" },
  ]);
  // ADR-0003 §1: `collections` keeps its exact ADR-0002 shape.
  assert.deepEqual(manifest.collections[0].modes[0], {
    name: "Value",
    slug: "value",
    set: "Core/Value",
    $figmaModeId: "1:0",
    file: "core/value.json",
  });
});

test("style sets are appended to tokenSetOrder after every Variables set", () => {
  const result = build(
    scan(
      oneVariable(),
      styles({
        paint: [paintStyle("S:1", "a", [solid(BLUE)])],
        text: [textStyle("S:2", "b")],
      })
    )
  );
  assert.deepEqual(result.manifest.tokenSetOrder, ["Core/Value", "Styles/Paint", "Styles/Text"]);
});

test("style sets join every theme, in first position", () => {
  // Styles are mode-free, so they belong to every theme equally; first position means the
  // Variables side wins by last-wins ordering if a hand-authored override ever lands.
  const core = collection("VariableCollectionId:1:1", "Core", [["1:0", "Value"]]);
  const theme = collection("VariableCollectionId:2:1", "Theme", [
    ["2:0", "Light"],
    ["2:1", "Dark"],
  ]);
  const variables = snapshot(
    [core, theme],
    [
      variable("VariableID:1:1", "palette/blue", core.id, "COLOR", { "1:0": BLUE }),
      variable("VariableID:2:1", "bg/canvas", theme.id, "COLOR", { "2:0": BLUE, "2:1": BLUE }),
    ]
  );

  const result = build(
    scan(variables, styles({ text: [textStyle("S:1", "heading/lg")] }))
  );

  assert.equal(result.manifest.themes.length, 2);
  for (const themeEntry of result.manifest.themes) {
    assert.equal(themeEntry.selectedTokenSets[0], "Styles/Text");
  }
  assert.deepEqual(result.manifest.themes[0].selectedTokenSets, [
    "Styles/Text",
    "Core/Value",
    "Theme/Light",
  ]);
});

test("a file with no styles still gets a v2 manifest, without a styleSets key", () => {
  const result = build(scan(oneVariable()));
  assert.equal(result.manifest.version, 2);
  assert.equal("styleSets" in result.manifest, false);
});

// ---------------------------------------------------------------------------
// Cross-source collisions (ADR-0003 §5)
// ---------------------------------------------------------------------------

test("a Variable beats a Style at the same path, and both are reported", () => {
  const result = build(
    scan(
      oneVariable("brand/primary"),
      styles({ paint: [paintStyle("S:1", "brand/primary", [solid({ r: 1, g: 0, b: 0 })])] })
    )
  );

  const clash = entriesOf(result, "cross-set")[0];
  assert.equal(clash.kind, "collision");
  assert.equal(clash.winnerRule, "source-precedence");

  const written = clash.participants?.filter((p) => p.outcome === "written") ?? [];
  const skipped = clash.participants?.filter((p) => p.outcome === "skipped") ?? [];
  assert.equal(written.length, 1);
  assert.equal(written[0].variableName, "brand/primary");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].styleId, "S:1");

  // The loser is neither written nor renamed.
  assert.equal(paths(result).includes("tokens/styles/paint.json"), false);
  assert.equal(tokenAt(fileAt(result.files, "tokens/core/value.json"), "brand.primary")?.$value, "#2d7ff9");
});

test("the Variable wins even when its name sorts after the style's", () => {
  // Alphabetical order has no relationship to correctness, which is why §5 fixes the rule by
  // source instead of letting the comparator degrade to name order.
  const core = collection("VariableCollectionId:1:1", "Zzz", [["1:0", "Value"]]);
  const variables = snapshot(
    [core],
    [variable("VariableID:1:1", "brand/primary", core.id, "COLOR", { "1:0": BLUE })]
  );

  const result = build(
    scan(variables, styles({ paint: [paintStyle("S:1", "brand/primary", [solid(BLUE)])] }))
  );

  const clash = entriesOf(result, "cross-set")[0];
  assert.equal(clash.winnerRule, "source-precedence");
  assert.equal(clash.participants?.filter((p) => p.outcome === "written")[0].variableName, "brand/primary");
});

test("a token/group clash across sources is caught too", () => {
  // DTCG cannot represent a node that is both a token and a group, whichever side each came from.
  const result = build(
    scan(
      oneVariable("brand/primary"),
      styles({ paint: [paintStyle("S:1", "brand/primary/hover", [solid(BLUE)])] })
    )
  );

  const clash = entriesOf(result, "token-group")[0];
  assert.equal(clash.kind, "collision");
  assert.equal(clash.winnerRule, "source-precedence");
  assert.equal(paths(result).includes("tokens/styles/paint.json"), false);
});

test("two styles clashing with each other are decided by name order and both reported", () => {
  // Among two style tokens the comparator has no signal left, which is honest — there is none.
  const result = build(
    scan(
      noVariables(),
      styles({
        paint: [paintStyle("S:1", "Brand/Primary", [solid(BLUE)])],
        text: [textStyle("S:2", "brand/primary")],
      })
    )
  );

  const clash = entriesOf(result, "cross-set")[0];
  assert.equal(clash.winnerRule, "name-order");
  assert.match(clash.message, /styles across 2 style sets/);
  assert.equal(clash.participants?.length, 2);
});

test("two paint styles whose names differ only by case are a same-set clash", () => {
  const result = build(
    scan(
      noVariables(),
      styles({
        paint: [
          paintStyle("S:1", "brand/Primary", [solid(BLUE)]),
          paintStyle("S:2", "brand/primary", [solid(BLUE)]),
        ],
      })
    )
  );

  const clash = entriesOf(result, "same-set-case")[0];
  assert.match(clash.message, /2 styles in "Styles\/Paint"/);
  assert.equal(countTokens(fileAt(result.files, "tokens/styles/paint.json")), 1);
});

test("a style at a path no Variable uses is written untouched", () => {
  const result = build(
    scan(oneVariable("brand/primary"), styles({ text: [textStyle("S:1", "heading/lg")] }))
  );

  assert.deepEqual(entriesOf(result, "cross-set"), []);
  assert.notEqual(tokenAt(fileAt(result.files, "tokens/styles/text.json"), "heading.lg"), undefined);
});

test("a mirrored style is informational, not a collision", () => {
  // The common real-world case: a paint style and the Variable it is bound to, at the same path.
  // Reporting that as a collision would make the report useless on the first real file.
  const result = build(
    scan(
      oneVariable("brand/primary"),
      styles(
        {
          paint: [paintStyle("S:1", "brand/primary", [solid(BLUE, { boundVariableId: "VariableID:1:1" })])],
        }
      )
    )
  );

  assert.deepEqual(entriesOf(result, "cross-set"), []);
  const mirror = entriesOf(result, "mirrors-variable")[0];
  assert.equal(mirror.kind, "redundant-style");
  assert.equal(paths(result).includes("tokens/styles/paint.json"), false);
});

// ---------------------------------------------------------------------------
// The reserved `styles/` directory (ADR-0003 §1)
// ---------------------------------------------------------------------------

test("a collection that slugs to `styles` loses the directory to the style sets", () => {
  const clashing = collection("VariableCollectionId:9:1", "Styles", [["9:0", "Value"]]);
  const variables = snapshot(
    [clashing],
    [variable("VariableID:9:1", "brand/primary", clashing.id, "COLOR", { "9:0": BLUE })]
  );

  const result = build(scan(variables, styles({ text: [textStyle("S:1", "body")] })));

  const entry = entriesOf(result, "set-slug").filter((item) => item.path === "styles")[0];
  assert.equal(entry.winnerRule, "source-precedence");
  assert.equal(entry.participants?.[0].collectionName, "Styles");
  assert.equal(entry.participants?.[0].outcome, "skipped");

  // Neither the collection's file nor its set survives.
  assert.equal(paths(result).includes("tokens/styles/value.json"), false);
  assert.deepEqual(result.manifest.collections, []);
  assert.deepEqual(result.manifest.tokenSetOrder, ["Styles/Text"]);
});

test("the reserved directory is enforced even when the file has no styles", () => {
  // A directory whose ownership flipped depending on unrelated content would be worse than one
  // that is simply taken.
  const clashing = collection("VariableCollectionId:9:1", "styles!", [["9:0", "Value"]]);
  const variables = snapshot(
    [clashing],
    [variable("VariableID:9:1", "a", clashing.id, "COLOR", { "9:0": BLUE })]
  );

  const result = build(scan(variables));
  assert.equal(entriesOf(result, "set-slug").length, 1);
  assert.deepEqual(result.manifest.collections, []);
});

// ---------------------------------------------------------------------------
// Counts, report and determinism
// ---------------------------------------------------------------------------

test("counts separate style tokens from the total without double counting", () => {
  const result = build(
    scan(
      oneVariable(),
      styles({
        paint: [paintStyle("S:1", "surface/raised", [solid(BLUE)])],
        text: [
          textStyle("S:2", "body"),
          textStyle("S:3", "caption", { lineHeight: { unit: "AUTO" } }),
        ],
      })
    )
  );

  assert.equal(result.counts.variables, 1);
  assert.equal(result.counts.styles, 3);
  assert.equal(result.counts.styleTokens, 3);
  assert.equal(result.counts.styleSets, 2);
  assert.equal(result.counts.tokens, 4);
  assert.equal(result.counts.partialTokens, 1);
  assert.equal(result.report.counts.tokens, 4);
  assert.equal(result.report.counts.styles, 3);
});

test("the report keeps version 1 and carries both sources' entries", () => {
  const result = build(
    scan(
      oneVariable("brand/primary"),
      styles({
        paint: [
          paintStyle("S:1", "brand/primary", [solid(BLUE)]),
          paintStyle("S:2", "grad", [{ type: "GRADIENT_LINEAR", visible: true, opacity: 1 }]),
        ],
      })
    )
  );

  assert.equal(result.report.version, 1);
  const kinds = new Set(result.report.entries.map((entry) => entry.kind));
  assert.equal(kinds.has("collision"), true);
  assert.equal(kinds.has("unmappable-value"), true);
  // theme-composition is the Variables side's own entry, and it survives the merge.
  assert.equal(kinds.has("theme-composition"), true);
  assert.equal(result.report.counts.flagged, result.report.entries.length);
});

test("re-running the same scan produces byte-identical files", () => {
  // ADR-0002 §7's determinism guarantee, extended over the styles side.
  const input = scan(
    oneVariable(),
    styles({
      paint: [
        paintStyle("S:3", "c", [solid(BLUE)]),
        paintStyle("S:1", "a", [solid(BLUE)]),
      ],
      text: [textStyle("S:2", "b")],
      effect: [effectStyle("S:4", "d", [shadow("INNER_SHADOW")])],
      grid: [gridStyle("S:5", "e", [columnsGrid()])],
    })
  );

  const first = build(input).files.map((file) => stableStringify(file.content)).join("");
  const second = build(input).files.map((file) => stableStringify(file.content)).join("");
  assert.equal(first, second);
});

test("the output does not depend on the order Figma returned the styles", () => {
  const forwards = styles({
    paint: [paintStyle("S:1", "a", [solid(BLUE)]), paintStyle("S:2", "b", [solid(BLUE)])],
  });
  const backwards = styles({ paint: forwards.paint.slice().reverse() });

  const a = build(scan(oneVariable(), forwards));
  const b = build(scan(oneVariable(), backwards));

  assert.equal(
    stableStringify(fileAt(a.files, "tokens/styles/paint.json")),
    stableStringify(fileAt(b.files, "tokens/styles/paint.json"))
  );
});

test("Phase 2's Variables output is untouched by the merge, apart from the manifest version", () => {
  // ADR-0003 pins build.ts unchanged; this is that promise held at the output level.
  const variables = oneVariable("tv/brand/primary");
  const withStyles = build(scan(variables, styles({ text: [textStyle("S:1", "body")] })));
  const without = build(scan(variables));

  assert.equal(
    stableStringify(fileAt(withStyles.files, "tokens/core/value.json")),
    stableStringify(fileAt(without.files, "tokens/core/value.json"))
  );
});

function countTokens(tree: TokenGroup): number {
  let count = 0;
  const walk = (node: TokenGroup): void => {
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child === null || typeof child !== "object") continue;
      if ("$value" in child) count += 1;
      else walk(child as TokenGroup);
    }
  };
  walk(tree);
  return count;
}
