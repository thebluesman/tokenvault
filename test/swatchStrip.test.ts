// Colour swatches — UX `docs/ux/panel-size-and-swatches.md` §4, §5, issue #36.
//
// Two units, and they are deliberately one question asked twice: `swatchMark` decides what mark a
// colour value line gets, and `groupStrip` asks *the same function* for each dot in a collapsed
// group's strip. §5.4 exists to prevent the failure where those two disagree — expanding a group
// showing you six colours that are not the six dots you clicked.
//
// The 12px chip itself has shipped since Phase 4 and is not retested here. What is new is the three
// no-colour cases (§4.2), the reserved slot they need (§4.3, pinned structurally below), and the
// strip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { GroupNode, FlatToken, TreeNode } from "../src/tokens/view";
import type { Token } from "../src/tokens/types";
import { buildPathRows, buildTree, describeSets } from "../src/tokens/view";
import { buildResolveContext, resolveToken } from "../src/tokens/resolve";
import { normalizePathKey } from "../src/tokens/paths";
import { groupStrip, dotTitle, STRIP_CAP } from "../src/ui/strip";
import type { StripRow } from "../src/ui/strip";
import { swatchMark, isColorValue } from "../src/ui/swatch";
import { flat } from "./helpers";

function token(type: Token["$type"], value: unknown): Token {
  return { $type: type, $value: value as Token["$value"] };
}

const color = (value: string): Token => token("color", value);

/**
 * A tiny editor model: the flat tokens, the tree they build, and a resolve context over them.
 *
 * `stack` is the whole list unless a lens is named, which is how the tests separate "the active theme
 * resolves this path here" from "some set defines it somewhere" (§5.4).
 */
function model(tokens: FlatToken[], lensSets?: string[]) {
  const stackTokens =
    lensSets === undefined ? tokens : tokens.filter((each) => lensSets.indexOf(each.setId) !== -1);
  const context = buildResolveContext(stackTokens, tokens);
  const rows = buildPathRows(tokens, uniqueSets(tokens));
  const tree = buildTree(rows);

  const byKey = new Map<string, StripRow>();
  for (const row of rows) {
    byKey.set(row.key, { row: { key: row.key }, lines: row.lines.map((entry) => ({ entry })) });
  }

  return {
    tree,
    input: {
      lookup: (key: string) => byKey.get(key),
      stack: context.stack,
      resolve: (entry: FlatToken) => resolveToken(entry, context),
    },
    /** Drops a path from the filtered set, the way a set or type filter would (§5.4). */
    hide(path: string): void {
      byKey.delete(normalizePathKey(path));
    },
    resolutionOf(path: string, setId: string) {
      const entry = tokens.filter(
        (each) => normalizePathKey(each.path) === normalizePathKey(path) && each.setId === setId
      )[0];
      assert.ok(entry !== undefined, `${path} in ${setId} is not in the fixture`);
      return { token: entry.token, resolution: resolveToken(entry, context) };
    },
  };
}

function uniqueSets(tokens: FlatToken[]) {
  const ids: string[] = [];
  for (const entry of tokens) if (ids.indexOf(entry.setId) === -1) ids.push(entry.setId);
  return ids.map((id) => ({
    id,
    code: id,
    label: id,
    source: "variables" as const,
    file: `${id}.json`,
  }));
}

function group(tree: TreeNode[], path: string): GroupNode {
  const found = findGroup(tree, path);
  assert.ok(found !== null, `no group at ${path}`);
  return found;
}

function findGroup(nodes: TreeNode[], path: string): GroupNode | null {
  for (const node of nodes) {
    if (node.kind !== "group") continue;
    if (node.path === path) return node;
    const deeper = findGroup(node.children, path);
    if (deeper !== null) return deeper;
  }
  return null;
}

// ---------------------------------------------------------------------------
// §4.2 — the three no-colour cases
// ---------------------------------------------------------------------------

test("a literal and a resolved reference get the same mark", () => {
  // Issue #28's decision, reused rather than reopened: a resolved reference paints at full opacity
  // with a solid ring, indistinguishable from a literal.
  const state = model([
    flat("palette.red.50", "Light", color("#c33a2e")),
    flat("color.border", "Light", color("{palette.red.50}")),
  ]);

  const literal = state.resolutionOf("palette.red.50", "Light");
  const pointer = state.resolutionOf("color.border", "Light");
  assert.deepEqual(swatchMark(literal.token, literal.resolution), {
    kind: "color",
    color: "#c33a2e",
  });
  assert.deepEqual(swatchMark(pointer.token, pointer.resolution), {
    kind: "color",
    color: "#c33a2e",
  });
});

test("a cycle gets no mark at all — not even an outline", () => {
  // §7.1's rule reaches the swatch: never a zero, never the last good number, and never a mark that
  // claims a colour exists. The `⚑ cycle` on the value line is the whole signal.
  const state = model([
    flat("a", "Light", color("{b}")),
    flat("b", "Light", color("{a}")),
  ]);
  const one = state.resolutionOf("a", "Light");
  assert.equal(one.resolution.kind, "cycle");
  assert.deepEqual(swatchMark(one.token, one.resolution), { kind: "none" });
});

test("a dangling reference and a wrong-type reference share one mark", () => {
  // §4.2 — from the swatch's point of view these are the same fact: this colour token has no colour
  // to show. Two marks would ask the user to tell "points nowhere" from "points at a number" by
  // looking at a 12px square, which no square can carry.
  const state = model([
    flat("space.4", "Light", token("number", 16)),
    flat("font.family", "Light", token("string", "Urbanist")),
    flat("color.dangling", "Light", color("{nope.nope}")),
    flat("color.wrongType", "Light", color("{space.4}")),
    flat("color.wrongString", "Light", color("{font.family}")),
  ]);

  for (const path of ["color.dangling", "color.wrongType", "color.wrongString"]) {
    const line = state.resolutionOf(path, "Light");
    assert.deepEqual(
      swatchMark(line.token, line.resolution),
      { kind: "outlined" },
      `${path} should get the dashed outline`
    );
  }
});

test("a non-colour token gets no slot to reserve", () => {
  // §4.3 — non-colour lines are not in the same scanning column, and a permanent 12px indent on
  // every row in the tree to serve colour rows is the wrong trade at 400px.
  const state = model([flat("space.4", "Light", token("number", 16))]);
  const line = state.resolutionOf("space.4", "Light");
  assert.deepEqual(swatchMark(line.token, line.resolution), { kind: "none" });
});

test("only a real colour value paints", () => {
  assert.equal(isColorValue("#c33a2e"), true);
  assert.equal(isColorValue("#C33A2EFF"), true);
  assert.equal(isColorValue("#fff"), true, "a hand-edited repo file can carry shorthand");
  assert.equal(isColorValue("Urbanist"), false);
  assert.equal(isColorValue(16), false);
  assert.equal(isColorValue(undefined), false);
});

test("the cycle row reserves the swatch slot, and only on a colour row", () => {
  // Structural: the reserved slot is a rendering decision with no DOM in CI. What is pinned is that
  // the cycle branch reserves it and that both reservations are gated on the colour type (§4.3).
  const tokensTs = readFileSync(join(process.cwd(), "src/ui/tokens.ts"), "utf8");
  const cycleBranch = tokensTs.slice(
    tokensTs.indexOf('if (resolution.kind === "cycle") {'),
    tokensTs.indexOf('container.appendChild(el("span", "badge needs", "⚑ cycle"));')
  );
  assert.equal(
    cycleBranch.indexOf("reservedSwatchSlot()") !== -1,
    true,
    "the cycle row no longer reserves the 12px slot — its `—` will sit 12px left of its siblings"
  );
  assert.equal(
    cycleBranch.indexOf("isColor") !== -1,
    true,
    "the cycle row's reservation is no longer gated on the colour type"
  );
  assert.equal(
    /else if \(isColor\) \{\s*container\.appendChild\(reservedSwatchSlot\(\)\);/.test(tokensTs),
    true,
    "the no-mark case no longer reserves the slot for a colour row"
  );
});

// ---------------------------------------------------------------------------
// §5 — the collapsed-group strip
// ---------------------------------------------------------------------------

const RAMP = ["50", "100", "200", "300", "400", "500", "600", "700"];

function ramp(setId = "Light"): FlatToken[] {
  return RAMP.map((step, index) =>
    flat(`color.red.${step}`, setId, color(`#${index}${index}${index}${index}${index}${index}`))
  );
}

test("a leaf group of colours renders its dots in tree order", () => {
  const state = model(ramp());
  const node = group(state.tree, "color.red");
  const strip = groupStrip(node, state.input);
  assert.ok(strip !== null);

  // §5.4 — **the order the children appear when you expand**, which is the tree's own order and not
  // sorted by hue or lightness. Taken off the node rather than restated, because that is the point:
  // the strip previews the list, and a strip with its own ordering stops matching the list it
  // previews.
  const children = node.children
    .filter((child) => child.kind === "token")
    .map((child) => child.name);
  assert.deepEqual(strip.dots.map((dot) => dot.leaf), children.slice(0, STRIP_CAP));
  assert.equal(strip.dots.length, STRIP_CAP);
  assert.equal(strip.overflow, RAMP.length - STRIP_CAP, "the cap states the rest rather than hiding it");
  assert.equal(strip.dots[0].color.startsWith("#"), true);
});

test("the cap is fixed, and `+N` counts what it left out", () => {
  // §5.5 — fixed, never derived from the panel's width. A width-derived cap means two people looking
  // at the same group see different strips and one of them counts wrong.
  const state = model(ramp());
  const strip = groupStrip(group(state.tree, "color.red"), state.input);
  assert.ok(strip !== null);
  assert.equal(strip.dots.length + strip.overflow, RAMP.length);

  const short = model(ramp().slice(0, 3));
  const small = groupStrip(group(short.tree, "color.red"), short.input);
  assert.equal(small?.overflow, 0, "a group inside the cap has no footnote");
});

test("a group whose children are groups gets nothing", () => {
  // §5.2 — the rule that kills the naive "all colour descendants, capped": collapsed `folio` would
  // render six arbitrary swatches and `+281`, and six dots read as *"this group is these six
  // colours."*
  const state = model(ramp());
  assert.equal(groupStrip(group(state.tree, "color"), state.input), null);
});

test("a leaf group with no colour children gets nothing at all", () => {
  // Not a placeholder, not a dash, not an em-space (§5.2). Absence already means "no colours here",
  // and a placeholder on two-thirds of the tree is ink that never says anything.
  const state = model([
    flat("space.1", "Light", token("number", 4)),
    flat("space.2", "Light", token("number", 8)),
  ]);
  assert.equal(groupStrip(group(state.tree, "space"), state.input), null);
});

test("a mixed group shows its colours and nothing for the rest", () => {
  const state = model([
    flat("chip.bg", "Light", color("#ffffff")),
    flat("chip.radius", "Light", token("number", 4)),
    flat("chip.label", "Light", token("string", "Chip")),
    flat("chip.fg", "Light", color("#000000")),
  ]);
  const strip = groupStrip(group(state.tree, "chip"), state.input);
  assert.deepEqual(strip?.dots.map((dot) => dot.leaf), ["bg", "fg"]);
  assert.equal(strip?.overflow, 0, "the non-colour children are not a footnote — the count says how many");
});

test("a child with no colour contributes no dot", () => {
  // §5.4 — cycles, danglers and wrong-type references are skipped. At 8px a dashed outline is
  // illegible, and the group row's `⚑` already says something under here needs attention.
  const state = model([
    flat("color.mix.a", "Light", color("#111111")),
    flat("color.mix.b", "Light", color("{color.mix.c}")),
    flat("color.mix.c", "Light", color("{color.mix.b}")),
    flat("color.mix.d", "Light", color("{nowhere.at.all}")),
    flat("color.mix.e", "Light", color("#222222")),
  ]);
  const strip = groupStrip(group(state.tree, "color.mix"), state.input);
  assert.deepEqual(strip?.dots.map((dot) => dot.leaf), ["a", "e"]);
  assert.equal(strip?.overflow, 0, "dots fewer than the colour children is normal, not an overflow");
});

test("one dot per path, however many sets define it", () => {
  // §5.4 — otherwise a six-shade group in a two-theme file renders twelve dots and the strip stops
  // describing the group.
  const state = model([...ramp("Light"), ...ramp("Dark")]);
  const strip = groupStrip(group(state.tree, "color.red"), state.input);
  assert.equal(strip?.dots.length, STRIP_CAP);
  assert.equal(strip?.overflow, RAMP.length - STRIP_CAP);
});

test("the dot is the colour the active theme lens resolves", () => {
  // §5.4 — the same source of truth as the row-level swatch one line below, so expanding a group can
  // never show six colours that disagree with the six dots.
  const tokens = [
    flat("color.bg", "Light", color("#ffffff")),
    flat("color.bg", "Dark", color("#000000")),
  ];
  const light = model(tokens, ["Light"]);
  const dark = model(tokens, ["Dark"]);
  assert.equal(groupStrip(group(light.tree, "color"), light.input)?.dots[0].color, "#ffffff");
  assert.equal(groupStrip(group(dark.tree, "color"), dark.input)?.dots[0].color, "#000000");
});

test("a path the lens has nothing for falls back to the first set that resolves it", () => {
  // §5.4's fallback. `color.only-light` is not in the Dark stack, and the strip still previews it
  // rather than leaving a hole the expanded rows would then contradict.
  const tokens = [
    flat("color.shared", "Light", color("#ffffff")),
    flat("color.shared", "Dark", color("#000000")),
    flat("color.onlyLight", "Light", color("#c33a2e")),
  ];
  const dark = model(tokens, ["Dark"]);
  const strip = groupStrip(group(dark.tree, "color"), dark.input);
  assert.deepEqual(strip?.dots, [
    { leaf: "onlyLight", color: "#c33a2e" },
    { leaf: "shared", color: "#000000" },
  ]);
});

test("the strip recomputes under a filter, exactly as the count does", () => {
  // §5.4 — a group row showing six dots while its filtered contents hold two is the same lie as a
  // count of 287 over four visible rows, and the existing code already refuses that one.
  const state = model(ramp());
  state.hide("color.red.50");
  state.hide("color.red.100");
  const strip = groupStrip(group(state.tree, "color.red"), state.input);
  assert.deepEqual(strip?.dots.map((dot) => dot.leaf), ["200", "300", "400", "500", "600", "700"]);
  assert.equal(strip?.overflow, 0);
});

test("the dot's tooltip is its leaf name and resolved value", () => {
  // §6's second string, verbatim: leaf segment, em dash, resolved value in the value line's casing.
  assert.equal(dotTitle({ leaf: "500", color: "#C33A2E" }), "500 — #C33A2E");
});

test("the strip is computed at model-build time, not in paint()", () => {
  // §10 — `paint()` runs on every scroll frame over a virtualized list, so walking a group's children
  // there is the one way this becomes a performance bug. The dot list rides on the placement, next to
  // `filterGroup`, and invalidates with it.
  const tokensTs = readFileSync(join(process.cwd(), "src/ui/tokens.ts"), "utf8");
  const paintBody = tokensTs.slice(
    tokensTs.indexOf("function paint(force: boolean)"),
    tokensTs.indexOf("/** First index whose row bottom is past `offset`. */")
  );
  assert.equal(
    paintBody.indexOf("groupStrip") === -1 && paintBody.indexOf("stripFor") === -1,
    true,
    "the strip is being computed inside paint() — that is a walk per collapsed group per frame"
  );
  assert.equal(
    tokensTs.indexOf("const GROUP_HEIGHT = 24;") !== -1,
    true,
    "GROUP_HEIGHT changed — the strip fits inside the existing row, or the dots are too big (§10)"
  );
});
