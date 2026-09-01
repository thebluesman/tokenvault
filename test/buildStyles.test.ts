// Styles → token candidates — ADR-0003 §2, §4, §6.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStyleTokens } from "../src/tokens/buildStyles";
import type { StyleBuildContext, StyleCandidate } from "../src/tokens/buildStyles";
import type { ReportEntry, StylesSnapshot } from "../src/tokens/types";
import {
  blur,
  columnsGrid,
  effectStyle,
  gridStyle,
  nonSolidPaint,
  paintStyle,
  shadow,
  solid,
  styles,
  textStyle,
} from "./helpers";

const BLUE = { r: 45 / 255, g: 127 / 255, b: 249 / 255 };

function context(overrides: Partial<StyleBuildContext> = {}): StyleBuildContext {
  return {
    variableNames: overrides.variableNames ?? new Map(),
    writtenVariablePaths: overrides.writtenVariablePaths ?? new Set(),
  };
}

function build(snapshot: StylesSnapshot, ctx: StyleBuildContext = context()) {
  return buildStyleTokens(snapshot, ctx);
}

function candidateAt(candidates: StyleCandidate[], path: string): StyleCandidate {
  const found = candidates.filter((candidate) => candidate.path === path)[0];
  if (!found) throw new Error(`No candidate at ${path}. Got: ${candidates.map((c) => c.path).join(", ")}`);
  return found;
}

function reasons(entries: ReportEntry[]): string[] {
  return entries.map((entry) => entry.reason);
}

// ---------------------------------------------------------------------------
// Naming and identity
// ---------------------------------------------------------------------------

test("slash-delimited style names nest verbatim, with no kind prefix", () => {
  // ADR-0003 §2: a paint style named `brand/primary` becomes `brand.primary`, exactly as the
  // equivalent Variable would. Prefixing by kind would mangle the round-trip identity.
  const result = build(
    styles({
      paint: [paintStyle("S:1", "brand/primary", [solid(BLUE)])],
      text: [textStyle("S:2", "heading/lg")],
    })
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.path).sort(),
    ["brand.primary", "heading.lg"]
  );
  assert.deepEqual(candidateAt(result.candidates, "brand.primary").segments, ["brand", "primary"]);
});

test("a style name that produces no path is reported, not written", () => {
  const result = build(styles({ paint: [paintStyle("S:1", "///", [solid(BLUE)])] }));
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(reasons(result.entries), ["empty-path"]);
});

test("each kind lands in its own set", () => {
  const result = build(
    styles({
      paint: [paintStyle("S:1", "a", [solid(BLUE)])],
      text: [textStyle("S:2", "b")],
      effect: [effectStyle("S:3", "c", [shadow("DROP_SHADOW")])],
      grid: [gridStyle("S:4", "d", [columnsGrid()])],
    })
  );

  assert.deepEqual(
    result.candidates.map((candidate) => `${candidate.setId} ${candidate.token.$type}`),
    ["Styles/Paint color", "Styles/Text typography", "Styles/Effect shadow", "Styles/Grid grid"]
  );
});

test("provenance carries the style id, key and type, and no subtype keys", () => {
  const result = build(styles({ text: [textStyle("S:9", "body", { fontStyle: "Semibold" })] }));
  const extension = candidateAt(result.candidates, "body").token.$extensions["com.tokenvault"];

  assert.deepEqual(extension.figma.styleId, "S:9");
  assert.deepEqual(extension.figma.styleKey, "key-S:9");
  assert.deepEqual(extension.figma.styleType, "TEXT");
  // Style types are self-describing, so there is no flag/tag step for Styles (ADR-0003 §2).
  assert.equal(extension.subtype, undefined);
  assert.equal(extension.subtypeSource, undefined);
  // `variableId` absent is what discriminates the Styles half of the provenance block.
  assert.equal(extension.figma.variableId, undefined);
});

test("the raw font style string is always kept, because a number cannot round-trip it", () => {
  // "Bold Italic" is not recoverable from 700, and Phase 5 has to hand it back to Figma verbatim.
  const result = build(styles({ text: [textStyle("S:1", "a", { fontStyle: "Bold Italic" })] }));
  const token = candidateAt(result.candidates, "a").token;
  assert.equal(token.$extensions["com.tokenvault"].figma.fontStyle, "Bold Italic");
  assert.equal((token.$value as { fontWeight: number }).fontWeight, 700);
});

test("a style description becomes $description, and an empty one is omitted", () => {
  const result = build(
    styles({
      paint: [
        paintStyle("S:1", "described", [solid(BLUE)], "The brand blue."),
        paintStyle("S:2", "bare", [solid(BLUE)]),
      ],
    })
  );

  assert.equal(candidateAt(result.candidates, "described").token.$description, "The brand blue.");
  assert.equal("$description" in candidateAt(result.candidates, "bare").token, false);
});

test("styles are converted in name order, not in the order Figma returned them", () => {
  // Figma's return order from getLocal*StylesAsync is undocumented, and the output must not
  // depend on it (ADR-0003 §7).
  const result = build(
    styles({
      paint: [
        paintStyle("S:3", "c", [solid(BLUE)]),
        paintStyle("S:1", "a", [solid(BLUE)]),
        paintStyle("S:2", "b", [solid(BLUE)]),
      ],
    })
  );
  assert.deepEqual(result.candidates.map((candidate) => candidate.path), ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// Bound variables and the mirror rule (ADR-0003 §4)
// ---------------------------------------------------------------------------

test("a paint bound to a Variable is written as an alias, not resolved to hex", () => {
  // Resolving it would destroy exactly the semantic layer the tool exists to preserve.
  const result = build(
    styles({ paint: [paintStyle("S:1", "surface/raised", [solid(BLUE, { boundVariableId: "V:1" })])] }),
    context({
      variableNames: new Map([["V:1", "tv/ref/palette/blue-500"]]),
      writtenVariablePaths: new Set(["tv.ref.palette.blue-500"]),
    })
  );

  assert.equal(candidateAt(result.candidates, "surface.raised").token.$value, "{tv.ref.palette.blue-500}");
});

test("a paint provably bound to a Variable at the same path is redundant, not duplicated", () => {
  const result = build(
    styles({ paint: [paintStyle("S:1", "brand/primary", [solid(BLUE, { boundVariableId: "V:1" })])] }),
    context({
      variableNames: new Map([["V:1", "brand/primary"]]),
      writtenVariablePaths: new Set(["brand.primary"]),
    })
  );

  assert.equal(result.candidates.length, 0);
  const entry = result.entries[0];
  assert.equal(entry.kind, "redundant-style");
  assert.equal(entry.reason, "mirrors-variable");
  assert.equal(entry.path, "brand.primary");
});

test("the mirror rule fires only on a proven binding, never on a name match", () => {
  // Two things that merely share a name are exactly the case a designer needs to see, so this
  // stays a candidate and goes on to be reported as a real collision by the merge pass.
  const result = build(
    styles({ paint: [paintStyle("S:1", "brand/primary", [solid(BLUE)])] }),
    context({ writtenVariablePaths: new Set(["brand.primary"]) })
  );

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(reasons(result.entries), []);
});

test("a binding to a Variable that was never written is kept but flagged as dangling", () => {
  const result = build(
    styles({ paint: [paintStyle("S:1", "surface", [solid(BLUE, { boundVariableId: "V:1" })])] }),
    context({ variableNames: new Map([["V:1", "palette/blue"]]) })
  );

  assert.equal(candidateAt(result.candidates, "surface").token.$value, "{palette.blue}");
  const entry = result.entries[0];
  assert.equal(entry.kind, "dangling-reference");
  assert.equal(entry.reason, "alias-target-skipped");
});

test("a mirror at the same path is not suppressed when the Variable itself was not written", () => {
  // Suppressing it there would leave the token defined by nothing at all.
  const result = build(
    styles({ paint: [paintStyle("S:1", "brand/primary", [solid(BLUE, { boundVariableId: "V:1" })])] }),
    context({ variableNames: new Map([["V:1", "brand/primary"]]) })
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.entries[0].kind, "dangling-reference");
});

test("an unnameable binding writes the literal and reports the lost link", () => {
  const result = build(
    styles({ paint: [paintStyle("S:1", "surface", [solid(BLUE, { boundVariableId: "V:gone" })])] })
  );

  assert.equal(candidateAt(result.candidates, "surface").token.$value, "#2d7ff9");
  const entry = result.entries[0];
  assert.equal(entry.kind, "partial-token");
  assert.equal(entry.reason, "unresolved-binding");
});

test("text style bindings are recorded as references under the figma block", () => {
  const result = build(
    styles({ text: [textStyle("S:1", "body", { boundVariables: { fontSize: "V:1" } })] }),
    context({ variableNames: new Map([["V:1", "size/body"]]) })
  );

  assert.deepEqual(
    candidateAt(result.candidates, "body").token.$extensions["com.tokenvault"].figma.boundVariables,
    { fontSize: "{size.body}" }
  );
});

// ---------------------------------------------------------------------------
// Fail-loud reporting (ADR-0003 §6)
// ---------------------------------------------------------------------------

test("unmappable values are reported with the ADR's reasons and produce no token", () => {
  const result = build(
    styles({
      paint: [
        paintStyle("S:1", "grad", [nonSolidPaint("GRADIENT_LINEAR")]),
        paintStyle("S:2", "img", [nonSolidPaint("IMAGE")]),
        paintStyle("S:3", "stack", [solid(BLUE), solid(BLUE)]),
        paintStyle("S:4", "none", []),
      ],
      effect: [effectStyle("S:5", "blurry", [blur("LAYER_BLUR")])],
      grid: [gridStyle("S:6", "nogrid", [])],
    })
  );

  assert.equal(result.candidates.length, 0);
  assert.deepEqual(
    reasons(result.entries).sort(),
    ["empty-grid", "empty-paint", "gradient-paint", "image-paint", "multi-paint", "unsupported-effect"]
  );
  for (const entry of result.entries) {
    assert.equal(entry.kind, "unmappable-value");
    assert.equal(entry.participants?.[0].outcome, "skipped");
  }
});

test("a partial token is written, and names the sub-keys that were not", () => {
  const result = build(
    styles({
      text: [textStyle("S:1", "body", { lineHeight: { unit: "AUTO" } })],
      effect: [effectStyle("S:2", "mixed", [shadow("DROP_SHADOW"), blur("BACKGROUND_BLUR")])],
    })
  );

  assert.equal(result.candidates.length, 2);
  assert.equal(result.counts.partialTokens, 2);

  const auto = result.entries.filter((entry) => entry.reason === "auto-line-height")[0];
  assert.equal(auto.kind, "partial-token");
  assert.deepEqual(auto.omitted, ["lineHeight"]);
  assert.equal(auto.set, "Styles/Text");
  // The token exists, so the participant is "written" — this is degraded, not lost.
  assert.equal(auto.participants?.[0].outcome, "written");

  const effect = result.entries.filter((entry) => entry.reason === "unsupported-effect")[0];
  assert.equal(effect.kind, "partial-token");
  assert.deepEqual(effect.omitted, ["BACKGROUND_BLUR"]);
});

test("style participants carry style identity with the variable fields left empty", () => {
  // The precedent Amendment 1 §E set for collection participants (ADR-0003 §5).
  const result = build(styles({ paint: [paintStyle("S:1", "grad", [nonSolidPaint("IMAGE")])] }));
  const participant = result.entries[0].participants?.[0];

  assert.equal(participant?.styleId, "S:1");
  assert.equal(participant?.styleName, "grad");
  assert.equal(participant?.variableId, "");
  assert.equal(participant?.variableName, "");
});

test("counts tally every style read, not just the ones that produced a token", () => {
  const result = build(
    styles({
      paint: [paintStyle("S:1", "ok", [solid(BLUE)]), paintStyle("S:2", "bad", [])],
      text: [textStyle("S:3", "body")],
    })
  );

  assert.equal(result.counts.styles, 3);
  assert.equal(result.candidates.length, 2);
});
