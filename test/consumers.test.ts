// The delete blast radius and its `[ Show them ]` — UX apply-and-drift §5.7, §10.
//
// §10 is firm that *the counts are the screen*, which makes a count that is merely close a bug
// rather than a rounding detail: the number is the whole basis on which someone decides to destroy
// something. Both functions here touch the `figma` global, so they are exercised against a stub
// document rather than left as the one part of the delete flow with no test at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { countConsumers, selectNodes } from "../src/figma/apply";

interface StubNode {
  id: string;
  type: string;
  parent: StubNode | null;
  children?: StubNode[];
  boundVariables?: Record<string, unknown>;
}

function node(id: string, boundVariables?: Record<string, unknown>): StubNode {
  return { id, type: "RECTANGLE", parent: null, boundVariables };
}

function page(id: string, children: StubNode[]): StubNode {
  const it: StubNode = { id, type: "PAGE", parent: null, children };
  for (const child of children) child.parent = it;
  return it;
}

function alias(id: string): unknown {
  return { type: "VARIABLE_ALIAS", id };
}

interface Stub {
  currentPage: StubNode;
  viewportCalls: number;
  pageChanges: string[];
}

/** Installs a stub document and returns the handles a test needs to assert against. */
function install(pages: StubNode[]): Stub {
  const byId = new Map<string, StubNode>();
  const index = (each: StubNode): void => {
    byId.set(each.id, each);
    for (const child of each.children ?? []) index(child);
  };
  for (const each of pages) index(each);

  const stub: Stub = { currentPage: pages[0], viewportCalls: 0, pageChanges: [] };
  (globalThis as unknown as { figma: unknown }).figma = {
    root: { children: pages },
    get currentPage() {
      return stub.currentPage;
    },
    setCurrentPageAsync: async (target: StubNode) => {
      stub.pageChanges.push(target.id);
      stub.currentPage = target;
    },
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    getStyleByIdAsync: async () => null,
    viewport: {
      scrollAndZoomIntoView: () => {
        stub.viewportCalls += 1;
      },
    },
  };
  return stub;
}

test("a layer bound to one Variable through two fields counts once", () => {
  // "Used by 14 layers", not "used 19 times". A node binding the same Variable through `fills` and
  // `strokes` is one layer that would lose one binding, and double-counting it inflates the only
  // number on a screen whose whole job is to be an honest blast radius.
  install([
    page("0:1", [
      node("1:1", { fills: [alias("VariableID:9:9")], strokes: alias("VariableID:9:9") }),
    ]),
  ]);

  return countConsumers([{ key: "k", variableId: "VariableID:9:9" }]).then((counts) => {
    assert.equal(counts[0].layers, 1);
    assert.deepEqual(counts[0].nodeIds, ["1:1"]);
  });
});

test("one field binding two doomed Variables counts for both of them", () => {
  // The other half of the same fix. Stopping at the first match within a field would drop the
  // second target's only consumer, which under-reports rather than over-reports — the worse of the
  // two directions on a delete screen.
  install([
    page("0:1", [node("1:1", { fills: [alias("VariableID:9:9"), alias("VariableID:8:8")] })]),
  ]);

  return countConsumers([
    { key: "a", variableId: "VariableID:9:9" },
    { key: "b", variableId: "VariableID:8:8" },
  ]).then((counts) => {
    assert.equal(counts.find((each) => each.key === "a")?.layers, 1);
    assert.equal(counts.find((each) => each.key === "b")?.layers, 1);
  });
});

test("consumers are counted across every page, not just the current one", () => {
  install([
    page("0:1", [node("1:1", { fills: [alias("VariableID:9:9")] })]),
    page("0:2", [node("2:1", { fills: [alias("VariableID:9:9")] })]),
  ]);

  return countConsumers([{ key: "k", variableId: "VariableID:9:9" }]).then((counts) => {
    assert.equal(counts[0].layers, 2);
  });
});

test("Show them lands on the page holding the most of them and reports the remainder", async () => {
  // Figma's selection is per-page and there is no multi-page selection API, so a consumer set
  // spread across pages cannot all be shown. Selecting one page's worth *silently* is the one
  // option that isn't available: it contradicts the "Used by N layers" count the user just read.
  const stub = install([
    page("0:1", [node("1:1"), node("1:2"), node("1:3")]),
    page("0:2", [node("2:1")]),
  ]);
  stub.currentPage = { id: "0:2", type: "PAGE", parent: null, children: [] };

  const result = await selectNodes(["2:1", "1:1", "1:2", "1:3"]);
  assert.deepEqual(result, { selected: 3, found: 4, pages: 2 });
  assert.deepEqual(stub.pageChanges, ["0:1"]);
});

test("a single page selects everything and reports no remainder", async () => {
  install([page("0:1", [node("1:1"), node("1:2")])]);
  const result = await selectNodes(["1:1", "1:2"]);
  assert.deepEqual(result, { selected: 2, found: 2, pages: 1 });
});

test("nodes that have gone are reported as unreachable rather than as an empty selection", async () => {
  install([page("0:1", [node("1:1")])]);
  const result = await selectNodes(["9:9"]);
  assert.deepEqual(result, { selected: 0, found: 0, pages: 0 });
});
