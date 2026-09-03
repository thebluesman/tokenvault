// The reference graph and cycle detection — ADR-0007 §3.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReferenceGraph,
  cycleFromCandidate,
  cycleFromEdge,
  cycleSummary,
  describeCycle,
  findCycles,
  graphEdgeKey,
  graphNodeKey,
  outgoingPaths,
} from "../src/tokens/graph";
import { flat, varToken } from "./helpers";

const n = graphNodeKey;

function graph(entries: Array<[string, string, unknown]>, resolution: "first" | "last" = "first") {
  return buildReferenceGraph(
    entries.map(([path, set, value]) => flat(path, set, varToken("number", value))),
    { resolution }
  );
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

test("edges come from references and from expression operands alike", () => {
  // ADR-0007 §3's widening of ADR-0005 §11: alias edges *and* expression edges, one graph.
  assert.deepEqual(outgoingPaths(varToken("number", "{a}")), ["a"]);
  assert.deepEqual(outgoingPaths(varToken("number", "({a} + {b}) * 2")), ["a", "b"]);
  assert.deepEqual(outgoingPaths(varToken("number", 8)), []);
});

test("a boundVariables edge survives on an expression-valued token", () => {
  const token = varToken("number", "{a} * 2", {
    boundVariables: { fontSize: "{folio.size.70}" },
  });
  assert.deepEqual(outgoingPaths(token), ["a", "folio.size.70"]);
});

test("an unparseable expression contributes no edges at all", () => {
  assert.deepEqual(outgoingPaths(varToken("number", "{a} * ")), []);
});

test("a reference to a path outside the scope is dangling, not an edge", () => {
  const g = graph([["a", "S", "{nowhere}"]]);
  assert.deepEqual(g.edges.get(n("S", "a")), []);
  assert.equal(findCycles(g).cycles.length, 0);
});

// ---------------------------------------------------------------------------
// Node identity and resolution order
// ---------------------------------------------------------------------------

test("nodes are token instances, so one set's cycle never refuses another set's token", () => {
  // A `cross-set` collision (ADR-0002 §5) picks a winner rather than making the loser vanish.
  // Keying by path would union the two tokens' edges and blame the winner for the loser's loop.
  const g = graph([
    ["a", "Light", "{b}"],
    ["b", "Light", "{a}"],
    ["b", "Dark", "{a}"],
  ]);
  const cycles = findCycles(g);
  assert.equal(cycles.nodes.has(n("Light", "a")), true);
  assert.equal(cycles.nodes.has(n("Light", "b")), true);
  // `Dark/b` shares a path with `Light/b` and points into the loop, but is not *on* it. Keying
  // nodes by path would merge the two and refuse `Dark/b`'s perfectly ordinary write.
  assert.equal(cycles.nodes.has(n("Dark", "b")), false);
});

test("first-wins is the plan's resolution; last-wins is the theme stack's", () => {
  const first = graph(
    [
      ["target", "Base", 1],
      ["target", "Theme", 2],
      ["src", "Base", "{target}"],
    ],
    "first"
  );
  assert.deepEqual(first.edges.get(n("Base", "src")), [n("Base", "target")]);

  const last = graph(
    [
      ["target", "Base", 1],
      ["target", "Theme", 2],
      ["src", "Base", "{target}"],
    ],
    "last"
  );
  assert.deepEqual(last.edges.get(n("Base", "src")), [n("Theme", "target")]);
});

// ---------------------------------------------------------------------------
// Finding cycles
// ---------------------------------------------------------------------------

test("a cycle is returned as the loop, not as a boolean", () => {
  const g = graph([
    ["a", "S", "{b}"],
    ["b", "S", "{c}"],
    ["c", "S", "{a}"],
  ]);
  const cycles = findCycles(g);
  assert.equal(cycles.cycles.length, 1);
  assert.deepEqual(cycles.cycles[0].nodes.slice().sort(), [n("S", "a"), n("S", "b"), n("S", "c")].sort());
  assert.equal(cycleSummary(g, cycles.cycles[0]).split(" → ").length, 4);
});

test("every token on the loop is in the error state, not just the one that closed it", () => {
  const g = graph([
    ["a", "S", "{b}"],
    ["b", "S", "{c}"],
    ["c", "S", "{a}"],
    ["d", "S", "{a}"],
  ]);
  const cycles = findCycles(g);
  assert.equal(cycles.nodes.has(n("S", "a")), true);
  assert.equal(cycles.nodes.has(n("S", "b")), true);
  assert.equal(cycles.nodes.has(n("S", "c")), true);
  // `d` points *into* the loop but is not on it — it has a real, if unresolvable, value.
  assert.equal(cycles.nodes.has(n("S", "d")), false);
  assert.equal(cycles.edges.has(graphEdgeKey(n("S", "d"), n("S", "a"))), false);
});

test("a self-reference is a cycle of length one, treated identically", () => {
  const g = graph([["a", "S", "{a}"]]);
  const cycles = findCycles(g);
  assert.deepEqual(cycles.cycles, [{ nodes: [n("S", "a")] }]);
  assert.equal(cycles.edges.has(graphEdgeKey(n("S", "a"), n("S", "a"))), true);
});

test("a cycle formed only by expression edges is found — the Phase 7 widening", () => {
  const g = graph([
    ["a", "S", "{b} * 2"],
    ["b", "S", "{a} + 1"],
  ]);
  assert.equal(findCycles(g).cycles.length, 1);
});

test("a long chain is not a cycle, however deep", () => {
  const entries: Array<[string, string, unknown]> = [];
  for (let i = 0; i < 200; i += 1) entries.push([`t${i}`, "S", `{t${i + 1}}`]);
  entries.push(["t200", "S", 1]);
  assert.equal(findCycles(graph(entries)).cycles.length, 0);
});

test("one loop is reported once however many nodes the walk enters it from", () => {
  const g = graph([
    ["a", "S", "{b}"],
    ["b", "S", "{a}"],
    ["x", "S", "{a}"],
    ["y", "S", "{b}"],
  ]);
  assert.equal(findCycles(g).cycles.length, 1);
});

test("two independent loops are two problems", () => {
  const g = graph([
    ["a", "S", "{b}"],
    ["b", "S", "{a}"],
    ["c", "S", "{d}"],
    ["d", "S", "{c}"],
  ]);
  assert.equal(findCycles(g).cycles.length, 2);
});

// ---------------------------------------------------------------------------
// The editor's scoped check
// ---------------------------------------------------------------------------

test("a candidate edge that closes a loop is refused before anything is written", () => {
  const g = graph([
    ["a", "S", "{b}"],
    ["b", "S", 8],
    ["c", "S", 4],
  ]);
  // Editing `b` to point at `a` closes `a → b → a`.
  const cycle = cycleFromCandidate(g, n("S", "b"), ["a"]);
  assert.notEqual(cycle, null);
  assert.deepEqual((cycle as { nodes: string[] }).nodes, [n("S", "b"), n("S", "a")]);

  // Editing `b` to point at `c` does not.
  assert.equal(cycleFromCandidate(g, n("S", "b"), ["c"]), null);
});

test("the scoped check agrees with the whole-graph one about what a cycle is", () => {
  const g = graph([
    ["a", "S", "{b}"],
    ["b", "S", "{c}"],
    ["c", "S", 1],
  ]);
  // Speculatively closing it, then actually closing it, must agree.
  assert.notEqual(cycleFromEdge(g, n("S", "c"), n("S", "a")), null);
  const closed = graph([
    ["a", "S", "{b}"],
    ["b", "S", "{c}"],
    ["c", "S", "{a}"],
  ]);
  assert.equal(findCycles(closed).cycles.length, 1);
});

test("a self-edge is caught by the scoped check too", () => {
  const g = graph([["a", "S", 1]]);
  assert.deepEqual(cycleFromEdge(g, n("S", "a"), n("S", "a")), { nodes: [n("S", "a")] });
});

test("a candidate naming a path outside the graph is not a cycle", () => {
  const g = graph([["a", "S", 1]]);
  assert.equal(cycleFromCandidate(g, n("S", "a"), ["nowhere"]), null);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("the block's rows run round the loop with the closing edge marked", () => {
  const g = graph([
    ["space.a", "S", "{space.b}"],
    ["space.b", "S", "{space.c}"],
    ["space.c", "S", "{space.a}"],
  ]);
  const cycle = findCycles(g).cycles[0];
  const steps = describeCycle(g, cycle);
  assert.equal(steps.length, 3);
  assert.equal(steps.filter((step) => step.closing).length, 1);
  assert.equal(steps[steps.length - 1].closing, true);
  // The last row closes back onto the first row's source — that is what makes three lines read as
  // a loop rather than a chain (UX §7.2).
  assert.equal(steps[steps.length - 1].to.path, steps[0].from.path);
});
