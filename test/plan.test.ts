// The apply plan — ADR-0005 §1, §5, §10, §11.
//
// The plan is where every refusal rule is decided, so this file is mostly about what the plan
// *won't* do: overwrite a conflicted target, remove anything, alias across a cycle or into a
// library, or write a style whose shape it can't rebuild.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { EditOverlay, OverlayEntry } from "../src/tokens/overlay";
import type { ApplyEntry } from "../src/tokens/plan";
import {
  buildApplyPlan,
  buildDeletePlan,
  cycleEdgeKey,
  cycleNodeKey,
  findReferenceCycles,
} from "../src/tokens/plan";
import { buildInboundIndex } from "../src/tokens/references";
import { flat, styleToken, varToken } from "./helpers";

const NOW = "2026-09-02T10:00:00.000Z";

function entry(parts: Partial<OverlayEntry> & Pick<OverlayEntry, "target" | "op">): OverlayEntry {
  return { path: "a.b", set: "Theme/Light", at: NOW, ...parts };
}

function overlay(entries: OverlayEntry[]): EditOverlay {
  return { version: 1, entries };
}

function byPath(plan: { entries: ApplyEntry[] }, path: string): ApplyEntry {
  const found = plan.entries.find((each) => each.path === path);
  assert.notEqual(found, undefined, `no plan entry for ${path}`);
  return found as ApplyEntry;
}

/** One edited token: the imported tree, the effective tree, and the overlay entry that links them. */
function scenario(options: {
  type?: Parameters<typeof varToken>[0];
  imported: unknown;
  edited: unknown;
  figma?: Record<string, unknown>;
  conflict?: boolean;
  orphaned?: boolean;
}) {
  const type = options.type ?? "color";
  const target = { variableId: "VariableID:1:1", modeId: "1:0" };
  const importedToken = varToken(type, options.imported, options.figma);
  const editedToken = varToken(type, options.edited, options.figma);
  return {
    imported: [flat("a.b", "Theme/Light", importedToken)],
    tokens: [flat("a.b", "Theme/Light", editedToken)],
    overlay: overlay([
      entry({
        target,
        op: "set-value",
        value: options.edited as never,
        base: options.imported as never,
        conflict: options.conflict === true ? { figma: "#111111", at: NOW } : undefined,
        orphaned: options.orphaned,
      }),
    ]),
  };
}

// ---------------------------------------------------------------------------
// §1 — the unit of apply is an overlay entry
// ---------------------------------------------------------------------------

test("the plan covers the overlay, not the tree", () => {
  // A whole-tree apply would write Figma's own values back over themselves for every token but the
  // edited handful — thousands of no-op writes that churn version history for no observable effect.
  const edited = varToken("color", "#c33a2e");
  const untouched = varToken("color", "#0d99ff", { variableId: "VariableID:2:2" });
  const plan = buildApplyPlan({
    tokens: [flat("a.b", "Theme/Light", edited), flat("c.d", "Theme/Light", untouched)],
    imported: [flat("a.b", "Theme/Light", varToken("color", "#b4342a")), flat("c.d", "Theme/Light", untouched)],
    overlay: overlay([
      entry({
        target: { variableId: "VariableID:1:1", modeId: "1:0" },
        op: "set-value",
        value: "#c33a2e",
        base: "#b4342a",
      }),
    ]),
  });

  assert.equal(plan.entries.length, 1);
  assert.equal(plan.ready, 1);
  assert.equal(byPath(plan, "a.b").before, "#b4342a");
  assert.equal(byPath(plan, "a.b").after, "#c33a2e");
});

test("an edit that lands back on Figma's own value is already-matches, never a write", () => {
  const plan = buildApplyPlan(scenario({ imported: "#c33a2e", edited: "#c33a2e" }));
  assert.equal(byPath(plan, "a.b").status, "already-matches");
  assert.equal(plan.ready, 0);
});

test("includeMatches lists in-sync tokens so a set apply's count is honest (UX §5.3)", () => {
  const clean = varToken("color", "#0d99ff", { variableId: "VariableID:2:2" });
  const plan = buildApplyPlan(
    {
      tokens: [flat("c.d", "Theme/Light", clean)],
      imported: [flat("c.d", "Theme/Light", clean)],
      overlay: overlay([]),
    },
    { includeMatches: true }
  );
  assert.equal(plan.matches, 1);
  assert.equal(plan.ready, 0);
  // And without it — the header chip's scope *is* the overlay, so a matches section would always
  // be empty there.
  const chip = buildApplyPlan({
    tokens: [flat("c.d", "Theme/Light", clean)],
    imported: [flat("c.d", "Theme/Light", clean)],
    overlay: overlay([]),
  });
  assert.equal(chip.entries.length, 0);
});

test("a scope narrows the plan to the chosen sets", () => {
  const light = { variableId: "VariableID:1:1", modeId: "1:0" };
  const dark = { variableId: "VariableID:1:1", modeId: "2:0" };
  const plan = buildApplyPlan(
    {
      tokens: [
        flat("a.b", "Theme/Light", varToken("color", "#c33a2e", light)),
        flat("a.b", "Theme/Dark", varToken("color", "#f0a19a", dark)),
      ],
      imported: [
        flat("a.b", "Theme/Light", varToken("color", "#b4342a", light)),
        flat("a.b", "Theme/Dark", varToken("color", "#e09090", dark)),
      ],
      overlay: overlay([
        entry({ target: light, op: "set-value", value: "#c33a2e", base: "#b4342a" }),
        entry({ target: dark, set: "Theme/Dark", op: "set-value", value: "#f0a19a", base: "#e09090" }),
      ]),
    },
    { sets: new Set(["Theme/Dark"]) }
  );
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].set, "Theme/Dark");
});

// ---------------------------------------------------------------------------
// §10 — conflicts block, and §5 — deletes are never in an apply
// ---------------------------------------------------------------------------

test("a conflicted target is skipped, not overwritten", () => {
  // Writing anyway would destroy a change a designer made in Figma, using a value the user
  // authored before that change existed and has not looked at since. Local-wins is safe for the
  // tree and destructive at the write boundary — the two genuinely warrant different defaults.
  const plan = buildApplyPlan(scenario({ imported: "#b4342a", edited: "#c33a2e", conflict: true }));
  assert.equal(byPath(plan, "a.b").status, "skipped");
  assert.equal(byPath(plan, "a.b").reason, "apply-conflicted");
  assert.equal(plan.ready, 0);
});

test("an orphaned edit is skipped and says the target is gone", () => {
  const plan = buildApplyPlan(scenario({ imported: "#b4342a", edited: "#c33a2e", orphaned: true }));
  assert.equal(byPath(plan, "a.b").reason, "apply-orphaned");
});

test("a pending tombstone is surfaced but never appliable", () => {
  // ADR-0005 §5: a normal apply can never remove anything from the file, whatever is sitting in
  // the overlay. UX §5.2's pre-checked rows are exactly why a delete row here would be unsafe.
  const token = varToken("color", "#c33a2e");
  const plan = buildApplyPlan({
    tokens: [flat("a.b", "Theme/Light", token)],
    imported: [flat("a.b", "Theme/Light", token)],
    overlay: overlay([entry({ target: { variableId: "VariableID:1:1", modeId: "1:0" }, op: "delete" })]),
  });
  assert.equal(plan.ready, 0);
  assert.equal(byPath(plan, "a.b").reason, "apply-delete-separate");
  assert.equal(
    plan.entries.every((each) => each.write === undefined),
    true
  );
});

// ---------------------------------------------------------------------------
// §11 — alias resolution and its four guards
// ---------------------------------------------------------------------------

function aliasScenario(reference: string, targets: Array<[string, ReturnType<typeof varToken>]>) {
  const source = varToken("color", reference);
  const imported = varToken("color", "#b4342a");
  const tokens = [flat("a.b", "Theme/Light", source), ...targets.map(([path, token]) => flat(path, "Theme/Light", token))];
  return {
    tokens,
    imported: [flat("a.b", "Theme/Light", imported), ...targets.map(([path, token]) => flat(path, "Theme/Light", token))],
    overlay: overlay([
      entry({
        target: { variableId: "VariableID:1:1", modeId: "1:0" },
        op: "set-value",
        value: reference,
        base: "#b4342a",
      }),
    ]),
  };
}

test("a reference applies as a native alias to the target's variable id", () => {
  const plan = buildApplyPlan(
    aliasScenario("{ref.red}", [["ref.red", varToken("color", "#c33a2e", { variableId: "VariableID:9:9" })]])
  );
  const applied = byPath(plan, "a.b");
  assert.equal(applied.status, "ready");
  assert.deepEqual(applied.write, {
    kind: "variable-alias",
    variableId: "VariableID:1:1",
    modeId: "1:0",
    targetId: "VariableID:9:9",
  });
  // The dialog renders the pointer as the primary value with the literal muted beneath (UX §5.6).
  assert.deepEqual(applied.alias, { path: "ref.red", resolved: "#c33a2e" });
});

test("an unresolvable alias target is refused by name", () => {
  const plan = buildApplyPlan(aliasScenario("{ref.gone}", []));
  assert.equal(byPath(plan, "a.b").reason, "alias-target-unknown");
});

test("a non-local target is refused up front, never by attempting the write", () => {
  // ADR-0005 §11: a runtime error surfacing mid-plan is the failure mode the whole section exists
  // to avoid — it lands after other entries have been written and arrives as Figma's own string.
  // Checked before "unknown", because a library variable is both, and only one cause is actionable.
  const plan = buildApplyPlan({
    ...aliasScenario("{lib.red}", []),
    nonLocalPaths: new Set(["lib.red"]),
  });
  assert.equal(byPath(plan, "a.b").reason, "alias-target-non-local");
});

test("a type mismatch is refused before the write, as Figma requires matching resolvedTypes", () => {
  const plan = buildApplyPlan(
    aliasScenario("{ref.size}", [["ref.size", varToken("number", 16, { variableId: "VariableID:9:9" })]])
  );
  assert.equal(byPath(plan, "a.b").reason, "alias-type-mismatch");
});

test("an alias pointing at a style-derived token is refused — there's nothing to alias to", () => {
  const plan = buildApplyPlan(
    aliasScenario("{styles.brand}", [["styles.brand", styleToken("color", "#c33a2e")]])
  );
  assert.equal(byPath(plan, "a.b").reason, "alias-target-not-variable");
});

test("cycles are found up front, so Figma never rejects one mid-plan", () => {
  // Also PRD §6.3's circular-reference detection, arriving early and as a side effect (ADR §11).
  const cycles = findReferenceCycles([
    flat("a", "S", varToken("color", "{b}")),
    flat("b", "S", varToken("color", "{c}")),
    flat("c", "S", varToken("color", "{a}")),
    flat("d", "S", varToken("color", "{a}")),
  ]);
  assert.deepEqual(
    Array.from(cycles.nodes).sort(),
    [cycleNodeKey("S", "a"), cycleNodeKey("S", "b"), cycleNodeKey("S", "c")].sort()
  );
  // `d` points *into* the cycle without being on it, so it is not itself circular.
  assert.equal(cycles.nodes.has(cycleNodeKey("S", "d")), false);
  // And the edge out of `d` is not a cycle edge, so its own write is never refused for one.
  assert.equal(cycles.edges.has(cycleEdgeKey(cycleNodeKey("S", "d"), cycleNodeKey("S", "a"))), false);
});

test("a self-reference is a cycle of one", () => {
  const cycles = findReferenceCycles([flat("a", "S", varToken("color", "{a}"))]);
  assert.deepEqual(Array.from(cycles.nodes), [cycleNodeKey("S", "a")]);
  assert.equal(cycles.edges.has(cycleEdgeKey(cycleNodeKey("S", "a"), cycleNodeKey("S", "a"))), true);
});

test("a long alias chain is not a cycle and costs nothing", () => {
  // Multi-hop chains cost nothing at apply time: each link is written independently and Figma
  // resolves the chain at render time, so depth never enters the plugin's model (ADR §11).
  const chain = Array.from({ length: 500 }, (_, i) =>
    flat(`n${i}`, "S", varToken("color", i === 499 ? "#000000" : `{n${i + 1}}`))
  );
  assert.equal(findReferenceCycles(chain).nodes.size, 0);
});

test("a cycle in one set does not refuse a colliding path in another", () => {
  // The regression: cycle nodes used to be keyed by normalised path alone, so two sets whose
  // tokens normalise to the same dotted path shared one graph node and had their outgoing
  // references unioned. `Theme/Dark`'s self-reference then put `Theme/Light`'s perfectly ordinary
  // pointer on a cycle, and its write was refused as circular. Paths are what a reference *names*;
  // the set is what says which token it lands on.
  const light = { variableId: "VariableID:1:1", modeId: "1:0" };
  const target = varToken("color", "#c33a2e", { variableId: "VariableID:9:9" });
  const plan = buildApplyPlan({
    tokens: [
      flat("a.b", "Theme/Light", varToken("color", "{ref.red}", light)),
      flat("a.b", "Theme/Dark", varToken("color", "{a.b}", { variableId: "VariableID:2:2" })),
      flat("ref.red", "Theme/Light", target),
    ],
    imported: [
      flat("a.b", "Theme/Light", varToken("color", "#b4342a", light)),
      flat("a.b", "Theme/Dark", varToken("color", "{a.b}", { variableId: "VariableID:2:2" })),
      flat("ref.red", "Theme/Light", target),
    ],
    overlay: overlay([
      entry({ target: light, op: "set-value", value: "{ref.red}", base: "#b4342a" }),
    ]),
  });

  const applied = byPath(plan, "a.b");
  assert.equal(applied.status, "ready");
  assert.equal(applied.reason, undefined);
  assert.equal(applied.write?.kind, "variable-alias");
});

test("only the edge that closes a loop is refused, not every pointer the token holds", () => {
  // A token can carry several references — a shadow's colour and its offset both. Refusing by node
  // rather than by edge would blame the innocent ones too.
  const cycles = findReferenceCycles([
    flat("a", "S", varToken("color", "{b}")),
    flat("b", "S", varToken("color", "{a}")),
    flat("leaf", "S", varToken("color", "#000000")),
  ]);
  assert.equal(cycles.edges.has(cycleEdgeKey(cycleNodeKey("S", "a"), cycleNodeKey("S", "b"))), true);
  assert.equal(cycles.edges.has(cycleEdgeKey(cycleNodeKey("S", "a"), cycleNodeKey("S", "leaf"))), false);
});

test("a token on a cycle is refused with the cycle reason", () => {
  const a = varToken("color", "{b}", { variableId: "VariableID:1:1" });
  const b = varToken("color", "{a}", { variableId: "VariableID:2:2" });
  const plan = buildApplyPlan({
    tokens: [flat("a", "S", a), flat("b", "S", b)],
    imported: [flat("a", "S", varToken("color", "#000000")), flat("b", "S", b)],
    overlay: overlay([
      entry({
        target: { variableId: "VariableID:1:1", modeId: "1:0" },
        path: "a",
        set: "S",
        op: "set-value",
        value: "{b}",
        base: "#000000",
      }),
    ]),
  });
  assert.equal(byPath(plan, "a").reason, "alias-cycle");
});

// ---------------------------------------------------------------------------
// Style guards and descriptions
// ---------------------------------------------------------------------------

test("an apply built on unestablished guards is refused outright", () => {
  // The regression: `styleGuards` and `nonLocalPaths` are derived from the live Figma read, so a
  // tree restored from the import cache used to arrive with both **empty**. Empty passes every
  // lookup made against it — `styleGuards.get(id)` is `undefined`, `nonLocalPaths.has(path)` is
  // false — so the lossy style write ADR-0005 §3 exists to refuse would have gone straight through.
  // Unknown is not "nothing is guarded", and it has to be caught above every branch that can
  // produce a `write`.
  const plan = buildApplyPlan({
    ...scenario({ imported: "#b4342a", edited: "#c33a2e" }),
    styleGuards: new Map(),
    nonLocalPaths: new Set(),
    guardsKnown: false,
  });
  assert.equal(plan.ready, 0);
  assert.equal(byPath(plan, "a.b").status, "skipped");
  assert.equal(byPath(plan, "a.b").reason, "apply-guards-unknown");
  assert.equal(
    plan.entries.every((each) => each.write === undefined),
    true
  );
});

test("guards established by a scan let the same apply through", () => {
  const plan = buildApplyPlan({
    ...scenario({ imported: "#b4342a", edited: "#c33a2e" }),
    styleGuards: new Map(),
    nonLocalPaths: new Set(),
    guardsKnown: true,
  });
  assert.equal(plan.ready, 1);
});

test("a guarded style is refused before its whole-array write can lose anything", () => {
  const before = styleToken("color", "#b4342a");
  const after = styleToken("color", "#c33a2e");
  const plan = buildApplyPlan({
    tokens: [flat("brand", "Styles/Paint", after)],
    imported: [flat("brand", "Styles/Paint", before)],
    overlay: overlay([
      entry({ target: { styleId: "S:abc" }, path: "brand", set: "Styles/Paint", op: "set-value", value: "#c33a2e", base: "#b4342a" }),
    ]),
    styleGuards: new Map([["S:abc", { ok: false, reason: "apply-lossy-style", message: "would delete a paint" }]]),
  });
  assert.equal(byPath(plan, "brand").reason, "apply-lossy-style");
});

test("a description edit plans its own write alongside the value edit on the same target", () => {
  const target = { variableId: "VariableID:1:1", modeId: "1:0" };
  const imported = varToken("color", "#b4342a");
  const edited = { ...varToken("color", "#c33a2e"), $description: "Accent border" };
  const plan = buildApplyPlan({
    tokens: [flat("a.b", "Theme/Light", edited)],
    imported: [flat("a.b", "Theme/Light", imported)],
    overlay: overlay([
      entry({ target, op: "set-value", value: "#c33a2e", base: "#b4342a" }),
      entry({ target, op: "set-description", value: "Accent border", base: "" }),
    ]),
  });
  assert.equal(plan.ready, 2);
  const description = plan.entries.find((each) => each.op === "set-description") as ApplyEntry;
  assert.equal(description.write?.kind, "variable-description");
  assert.equal(description.before, undefined);
  assert.equal(description.after, "Accent border");
});

// ---------------------------------------------------------------------------
// Deletion — ADR-0005 §5
// ---------------------------------------------------------------------------

test("a delete is blocked while anything outside the deletion points at it", () => {
  const target = varToken("color", "#c33a2e");
  const referrer = varToken("color", "{a.b}", { variableId: "VariableID:2:2" });
  const inbound = buildInboundIndex([
    { path: "a.b", setId: "Theme/Light", token: target },
    { path: "c.d", setId: "Theme/Light", token: referrer },
  ]);
  const plan = buildDeletePlan([{ path: "a.b", setId: "Theme/Light", token: target }], inbound);
  assert.equal(plan.blocked, 1);
  assert.equal(plan.ready, 0);
  assert.equal(plan.entries[0].reason, "delete-referenced");
  assert.deepEqual(plan.referrers, [{ path: "c.d", setId: "Theme/Light" }]);
});

test("references from inside the same deletion don't block it", () => {
  // The exclusion is what makes a group delete possible at all: tokens inside the group reference
  // each other, and those references are not stranded by a delete that takes both ends.
  const inner = varToken("color", "#c33a2e");
  const outer = varToken("color", "{g.inner}", { variableId: "VariableID:2:2" });
  const inbound = buildInboundIndex([
    { path: "g.inner", setId: "S", token: inner },
    { path: "g.outer", setId: "S", token: outer },
  ]);
  const plan = buildDeletePlan(
    [
      { path: "g.inner", setId: "S", token: inner },
      { path: "g.outer", setId: "S", token: outer },
    ],
    inbound
  );
  assert.equal(plan.ready, 2);
  assert.equal(plan.blocked, 0);
});

test("an unreferenced target plans a remove op for its own provenance half", () => {
  const inbound = buildInboundIndex([]);
  const variable = buildDeletePlan([{ path: "a.b", setId: "S", token: varToken("color", "#000000") }], inbound);
  assert.equal(variable.entries[0].write?.kind, "variable-remove");
  const style = buildDeletePlan([{ path: "brand", setId: "S", token: styleToken("color", "#000000") }], inbound);
  assert.equal(style.entries[0].write?.kind, "style-remove");
});

// ---------------------------------------------------------------------------
// Expressions at apply — ADR-0007 §4, the one place Tokenvault flattens
// ---------------------------------------------------------------------------

test("an expression flattens to a number, and the row carries the number that lands", () => {
  // Figma has no representation for arithmetic, so flattening is not a choice; the choice is
  // whether to make it visible, and the row's `expression` field is how the dialog does that
  // ("a user cannot flatten without seeing the number that lands").
  const target = { variableId: "VariableID:1:1", modeId: "1:0" };
  const plan = buildApplyPlan({
    imported: [
      flat("space.button", "Theme/Light", varToken("number", 16)),
      flat("core.4", "Theme/Light", varToken("number", 16, { variableId: "VariableID:2:2" })),
    ],
    tokens: [
      flat("space.button", "Theme/Light", varToken("number", "{core.4} * 2")),
      flat("core.4", "Theme/Light", varToken("number", 16, { variableId: "VariableID:2:2" })),
    ],
    overlay: overlay([
      entry({
        target,
        path: "space.button",
        op: "set-value",
        value: "{core.4} * 2" as never,
        base: 16 as never,
      }),
    ]),
  });

  const row = byPath(plan, "space.button");
  assert.equal(row.status, "ready");
  assert.deepEqual(row.expression, { source: "{core.4} * 2", resolved: 32 });
  assert.deepEqual(row.write, {
    kind: "variable-value",
    variableId: "VariableID:1:1",
    modeId: "1:0",
    value: 32,
  });
});

test("an expression that cannot be evaluated is refused, never written as its string", () => {
  const target = { variableId: "VariableID:1:1", modeId: "1:0" };
  const plan = buildApplyPlan({
    imported: [flat("space.button", "Theme/Light", varToken("number", 16))],
    tokens: [flat("space.button", "Theme/Light", varToken("number", "{missing} * 2"))],
    overlay: overlay([
      entry({
        target,
        path: "space.button",
        op: "set-value",
        value: "{missing} * 2" as never,
        base: 16 as never,
      }),
    ]),
  });

  const row = byPath(plan, "space.button");
  assert.equal(row.status, "skipped");
  assert.equal(row.reason, "expression-error");
  assert.equal(row.expression?.resolved, undefined);
});

test("the cycle check is widened to expression edges — ADR-0005 §11's rule, ADR-0007 §3's scope", () => {
  // Before Phase 7 this loop was invisible to the plan: neither edge is an alias, so
  // `collectReferences` saw nothing and the write would have been attempted.
  const cycles = findReferenceCycles([
    flat("a", "S", varToken("number", "{b} * 2")),
    flat("b", "S", varToken("number", "{a} + 1")),
  ]);
  assert.equal(cycles.cycles.length, 1);
  assert.equal(cycles.nodes.has(cycleNodeKey("S", "a")), true);
  assert.equal(cycles.edges.has(cycleEdgeKey(cycleNodeKey("S", "a"), cycleNodeKey("S", "b"))), true);
});

test("a token on an expression cycle is refused at apply, with no fallback value", () => {
  const target = { variableId: "VariableID:1:1", modeId: "1:0" };
  const plan = buildApplyPlan({
    imported: [
      flat("a", "S", varToken("number", 1)),
      flat("b", "S", varToken("number", 2, { variableId: "VariableID:2:2" })),
    ],
    tokens: [
      flat("a", "S", varToken("number", "{b} * 2")),
      flat("b", "S", varToken("number", "{a} + 1", { variableId: "VariableID:2:2" })),
    ],
    overlay: overlay([
      entry({ target, path: "a", set: "S", op: "set-value", value: "{b} * 2" as never, base: 1 as never }),
    ]),
  });

  const row = byPath(plan, "a");
  assert.equal(row.status, "skipped");
  assert.equal(row.expression?.resolved, undefined);
});

// ---------------------------------------------------------------------------
// ADR-0007 §3 — one resolution strategy per plan, not two
// ---------------------------------------------------------------------------

test("a plan's expressions resolve first-wins, the same as its alias index", () => {
  // Two sets define `base`. ADR-0002 §5 picks the first as the collision winner, `plan.ts`'s alias
  // index follows it, and the cycle graph is built `resolution: "first"` to match. Expression
  // evaluation used to fall back to a last-wins context, so `{base} * 2` came out 20 while
  // `{base}` aliased the variable holding 4 — one apply, one path, two answers, no error.
  const first = varToken("number", 4, { variableId: "VariableID:1:1" });
  const second = varToken("number", 10, { variableId: "VariableID:2:2" });
  const importedDerived = varToken("number", 1, { variableId: "VariableID:3:3" });
  const editedDerived = varToken("number", "{base} * 2", { variableId: "VariableID:3:3" });

  const plan = buildApplyPlan({
    tokens: [
      flat("base", "First", first),
      flat("base", "Second", second),
      flat("derived", "First", editedDerived),
    ],
    imported: [
      flat("base", "First", first),
      flat("base", "Second", second),
      flat("derived", "First", importedDerived),
    ],
    overlay: overlay([
      entry({
        target: { variableId: "VariableID:3:3", modeId: "1:0" },
        path: "derived",
        set: "First",
        op: "set-value",
        value: "{base} * 2",
        base: 1,
      }),
    ]),
  });

  const row = byPath(plan, "derived");
  assert.equal(row.status, "ready");
  assert.equal(row.expression?.source, "{base} * 2");
  assert.equal(row.expression?.resolved, 8);
});

test("a plan's alias and its expression land on the same collided token", () => {
  // The property the strategies existing separately could break, stated directly: the variable an
  // alias row points at is the same token the expression row's number came from.
  const first = varToken("number", 4, { variableId: "VariableID:1:1" });
  const second = varToken("number", 10, { variableId: "VariableID:2:2" });
  const pointer = varToken("number", "{base}", { variableId: "VariableID:4:4" });
  const derived = varToken("number", "{base} * 2", { variableId: "VariableID:3:3" });

  const tokens = [
    flat("base", "First", first),
    flat("base", "Second", second),
    flat("pointer", "First", pointer),
    flat("derived", "First", derived),
  ];
  const plan = buildApplyPlan({
    tokens,
    imported: [
      flat("base", "First", first),
      flat("base", "Second", second),
      flat("pointer", "First", varToken("number", 0, { variableId: "VariableID:4:4" })),
      flat("derived", "First", varToken("number", 0, { variableId: "VariableID:3:3" })),
    ],
    overlay: overlay([
      entry({
        target: { variableId: "VariableID:4:4", modeId: "1:0" },
        path: "pointer",
        set: "First",
        op: "set-value",
        value: "{base}",
        base: 0,
      }),
      entry({
        target: { variableId: "VariableID:3:3", modeId: "1:0" },
        path: "derived",
        set: "First",
        op: "set-value",
        value: "{base} * 2",
        base: 0,
      }),
    ]),
  });

  const aliasRow = byPath(plan, "pointer");
  assert.equal(aliasRow.status, "ready");
  // The alias resolves to `First.base` — the first-wins winner, value 4.
  assert.equal(aliasRow.alias?.resolved, 4);
  // And the expression is `4 * 2`, not `10 * 2`.
  assert.equal(byPath(plan, "derived").expression?.resolved, 8);
});
