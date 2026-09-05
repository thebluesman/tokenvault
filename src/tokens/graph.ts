// The reference graph and circular-reference detection — ADR-0007 §3.
//
// **One implementation, three checkpoints.** The editor (scoped, speculative), the build/merge
// pass (whole graph) and `plan.ts` (whole graph, before apply) all come through here. A second
// cycle check that could disagree with the first about what a cycle is would be worse than no
// check, so `plan.ts`'s Phase 5 walk was replaced by this one rather than left beside it.
//
// Two decisions about *shape* that the ADR's one-line summary ("`path → paths it points at`")
// leaves room to get wrong:
//
//   1. **Nodes are token instances, not paths.** Two sets can hold the same normalised path — a
//      `cross-set` collision, which ADR-0002 §5 resolves by picking a winner rather than by making
//      the loser vanish. Keying nodes by path merges those tokens into one node, unions their
//      outgoing edges, and lets a cycle belonging to the loser refuse the winner's perfectly
//      ordinary write. `plan.ts` documented this before Phase 7 and it still holds; the ADR's
//      wording is about the *edge* direction, not about identity.
//   2. **Edge targets resolve through an injected index.** *Which* token a `{path}` lands on is a
//      theme question (ADR-0002 §2), so the caller supplies the resolution: the theme's set stack
//      last-wins for the editor and the build, the whole tree first-wins for `plan.ts`. The
//      traversal is identical either way, which is the property that matters.
//
// Edges come from both value shapes: a reference's target (`references.ts`) and every operand of
// an expression (`expr.ts`). That widening — from alias edges to alias + expression edges — is
// ADR-0007 §3's amendment to ADR-0005 §11.

import type { Token } from "./types";
import type { FlatToken } from "./view";
import { collectReferences } from "./references";
import { referencesInExpression } from "./expr";
import { valueShape } from "./expr";
import { memberShape, nonLiteralMembers } from "./members";
import { normalizePathKey } from "./paths";

// ---------------------------------------------------------------------------
// Node identity
// ---------------------------------------------------------------------------

/**
 * One token instance's identity in the graph. A set cannot hold two tokens at one path.
 *
 * NUL as the joiner, not `:` or a space: Figma ids carry colons and variable names carry spaces,
 * and a separator that appears inside the parts is not a separator. Same choice, same reason, as
 * `overlay.ts`'s `targetKey`.
 */
export function graphNodeKey(setId: string, path: string): string {
  return `${setId}\u0000${normalizePathKey(path)}`;
}

/** Exported so a caller can ask about one edge without re-deriving the key's shape. */
export function graphEdgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

export interface GraphNode {
  key: string;
  path: string;
  setId: string;
  token: Token;
}

export interface ReferenceGraph {
  /** `nodeKey` → the node keys it points at, in source order, duplicates kept. */
  edges: Map<string, string[]>;
  nodes: Map<string, GraphNode>;
  /** `normalizePathKey(path)` → the node a reference to that path lands on. */
  index: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Every path this token points at, over **both** value shapes.
 *
 * A reference contributes its target and a composite contributes its `boundVariables` — both
 * already `collectReferences`'s job. An expression contributes each of its operands, which
 * `collectReferences` cannot see because `isReference` is anchored and refuses to match it (§1).
 *
 * An expression that doesn't parse contributes nothing: those are not dependencies the user has
 * successfully expressed, and inventing edges from a half-typed string would let a typo
 * manufacture a cycle.
 */
export function outgoingPaths(token: Token): string[] {
  if (valueShape(token) !== "expression") {
    // A composite's members are ordinary value fields (UX §14.1), so a member's expression is a
    // dependency exactly as a whole token's is. Its references are invisible to `collectReferences`
    // for the same reason a whole-token expression's are — `isReference` is anchored — so they are
    // collected here. Member *references* need no special case: the `$value` walk already finds them,
    // and finding them twice is what a second collector would achieve.
    return collectReferences(token).concat(memberExpressionPaths(token));
  }

  // `collectReferences` already returns exactly the `boundVariables` half here: it walks `$value`
  // through `isReference`, which is anchored and refuses an expression string outright (§1). So the
  // two halves compose by concatenation rather than needing the value half subtracted.
  return referencesInExpression(token.$value as string).concat(collectReferences(token));
}

/** Every operand of every member expression — the sub-key half of ADR-0007 §3's edge set (§14.9). */
function memberExpressionPaths(token: Token): string[] {
  const paths: string[] = [];
  for (const slot of nonLiteralMembers(token)) {
    if (memberShape(slot.accepts, slot.value) !== "expression") continue;
    paths.push(...referencesInExpression(slot.value as string));
  }
  return paths;
}

export interface GraphOptions {
  /**
   * Which token a path resolves to, when several sets define it.
   *
   * `"first"` matches `plan.ts`'s alias index and the collision pass's winner (ADR-0002 §5).
   * `"last"` is the theme stack's rule — `selectedTokenSets` order, last-wins (ADR-0002 §1) — and
   * is what the caller wants after filtering `tokens` down to the active theme's sets.
   */
  resolution?: "first" | "last";
}

/**
 * The forward graph over a set of token instances.
 *
 * `tokens` is already the scope: pass the whole tree for `plan.ts`, or the active theme's set stack
 * (in order) for the editor and the build. Nothing here knows what a theme is.
 */
export function buildReferenceGraph(
  tokens: FlatToken[],
  options: GraphOptions = {}
): ReferenceGraph {
  const last = options.resolution === "last";
  const nodes = new Map<string, GraphNode>();
  const index = new Map<string, string>();

  for (const entry of tokens) {
    const key = graphNodeKey(entry.setId, entry.path);
    if (!nodes.has(key)) {
      nodes.set(key, { key, path: entry.path, setId: entry.setId, token: entry.token });
    }
    const pathKey = normalizePathKey(entry.path);
    if (last || !index.has(pathKey)) index.set(pathKey, key);
  }

  const edges = new Map<string, string[]>();
  for (const entry of tokens) {
    const from = graphNodeKey(entry.setId, entry.path);
    const targets = edges.get(from) ?? [];
    for (const reference of outgoingPaths(entry.token)) {
      // A path that names no token in scope is a dangling reference, not a cycle. It has no node
      // here and is reported by its own kind (`dangling-reference` / `unresolved-in-theme`).
      const target = index.get(normalizePathKey(reference));
      if (target !== undefined) targets.push(target);
    }
    edges.set(from, targets);
  }

  return { edges, nodes, index };
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * One loop, as a path.
 *
 * `nodes` is the loop in traversal order and the closing edge is implicit — the last node points
 * back at the first. A boolean would not be enough: UX §7.2's block renders
 * `space.a → space.b → space.c → space.a`, and the whole design decision in ADR-0007 §3 is that
 * *the error state is the cycle, not the token*.
 */
export interface Cycle {
  nodes: string[];
}

export interface CycleIndex {
  cycles: Cycle[];
  /** Every node sitting on any cycle. */
  nodes: Set<string>;
  /** Every edge that lies on a cycle, keyed by `graphEdgeKey`. */
  edges: Set<string>;
}

export function emptyCycleIndex(): CycleIndex {
  return { cycles: [], nodes: new Set(), edges: new Set() };
}

/**
 * Every cycle in the graph, by three-colour depth-first search.
 *
 * Iterative rather than recursive: a deep but perfectly legal alias chain in a real file would
 * trade a reported cycle for a stack overflow, which is the one outcome worse than not reporting.
 *
 * A self-reference is a cycle of length one and needs no special case — the back edge from a node
 * to itself lands on the same branch as any other.
 */
export function findCycles(graph: ReferenceGraph): CycleIndex {
  const cycles: Cycle[] = [];
  const onCycle = new Set<string>();
  const cycleEdges = new Set<string>();
  /** Distinct loops, keyed by their canonical rotation, so one loop is not reported twice. */
  const seen = new Set<string>();
  /** 0 unvisited, 1 on the current path, 2 finished. */
  const state = new Map<string, number>();

  for (const start of graph.edges.keys()) {
    if ((state.get(start) ?? 0) !== 0) continue;

    const path: string[] = [start];
    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    state.set(start, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = graph.edges.get(frame.node) ?? [];

      if (frame.next >= targets.length) {
        state.set(frame.node, 2);
        stack.pop();
        path.pop();
        continue;
      }

      const target = targets[frame.next];
      frame.next += 1;
      const seenState = state.get(target) ?? 0;

      if (seenState === 1) {
        // Back edge. Everything from `target` to the top of the current path is on the loop, and
        // so is every edge along it — including the back edge itself, which closes it.
        const from = path.lastIndexOf(target);
        if (from === -1) continue;
        const loop = path.slice(from);
        const canonical = canonicalKey(loop);
        if (!seen.has(canonical)) {
          seen.add(canonical);
          cycles.push({ nodes: loop });
        }
        for (let i = 0; i < loop.length; i += 1) {
          onCycle.add(loop[i]);
          cycleEdges.add(graphEdgeKey(loop[i], loop[(i + 1) % loop.length]));
        }
        continue;
      }
      if (seenState === 2) continue;

      state.set(target, 1);
      path.push(target);
      stack.push({ node: target, next: 0 });
    }
  }

  return { cycles, nodes: onCycle, edges: cycleEdges };
}

/** A loop's identity, independent of which node the walk happened to enter it at. */
function canonicalKey(loop: string[]): string {
  let best = 0;
  for (let i = 1; i < loop.length; i += 1) {
    if (loop[i] < loop[best]) best = i;
  }
  return loop
    .slice(best)
    .concat(loop.slice(0, best))
    .join("\u0000");
}

// ---------------------------------------------------------------------------
// The editor's scoped check — ADR-0007 §3
// ---------------------------------------------------------------------------

/**
 * The loop a candidate edge would close, or `null`.
 *
 * Scoped to what the *target* can reach, not to the whole graph: adding `from → to` closes a loop
 * exactly when `to` already reaches `from`, so the walk starts at `to` and stops the moment it
 * arrives. At 1,316 tokens that is what makes the picker's third group (UX §4.2) affordable per
 * keystroke, and it is the same traversal as `findCycles` rather than a second opinion about what
 * a cycle is.
 *
 * `from === to` is a self-reference and is caught by the same code — a cycle of length one.
 *
 * The returned loop is rendered by UX §7.2's block, starting at `from`, so the closing edge is the
 * one the user just typed.
 */
export function cycleFromEdge(
  graph: ReferenceGraph,
  from: string,
  to: string
): Cycle | null {
  if (from === to) return { nodes: [from] };

  /** `node` → the node we arrived from, so the loop can be reconstructed without a second pass. */
  const cameFrom = new Map<string, string>();
  const stack = [to];
  const seen = new Set<string>([to]);

  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === from) {
      // Walk the parents back to `to`, then prepend `from`: `from → to → … → from`.
      const back: string[] = [];
      let cursor: string | undefined = node;
      while (cursor !== undefined && cursor !== to) {
        back.push(cursor);
        cursor = cameFrom.get(cursor);
      }
      const loop = [to].concat(back.reverse());
      // `loop` currently runs `to → … → from`; the block wants it starting at the edge's source.
      return { nodes: [loop[loop.length - 1]].concat(loop.slice(0, loop.length - 1)) };
    }
    for (const next of graph.edges.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, node);
      stack.push(next);
    }
  }

  return null;
}

/**
 * The same question, phrased the way the value field asks it: *would this token, given this value,
 * close a loop?*
 *
 * `paths` is what the candidate value points at — one target for a reference, every operand for an
 * expression. Returns the first loop found, because the field can only render one block and any
 * one of them refuses the edit.
 */
export function cycleFromCandidate(
  graph: ReferenceGraph,
  fromNode: string,
  paths: string[]
): Cycle | null {
  for (const path of paths) {
    const target = graph.index.get(normalizePathKey(path));
    if (target === undefined) continue;
    const cycle = cycleFromEdge(graph, fromNode, target);
    if (cycle !== null) return cycle;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering a cycle
// ---------------------------------------------------------------------------

/** One row of UX §7.2's block: `folio.space.a → folio.space.b`, with the sets they live in. */
export interface CycleStep {
  from: { path: string; setId: string };
  to: { path: string; setId: string };
  /** True on the edge that closes the loop — the `↵` marker. */
  closing: boolean;
}

/**
 * The loop one token instance sits on — the lookup behind `[ Show the loop ]` (UX §7.3c).
 *
 * **Keyed by node, never by path.** Node identity is per instance (`graphNodeKey`), so a path held
 * by `Theme/Light` and `Theme/Dark` is two nodes that can sit on two different loops, or on one and
 * none — and cycles are theme-scoped (UX §7.4), which is what routinely produces that pair. A
 * path-only lookup would show one set's loop against the other set's row, confidently and wrongly.
 *
 * The `nodes` set answers the common case (no cycle) without walking any loop's members.
 */
export function cycleContaining(index: CycleIndex, node: string): Cycle | undefined {
  if (!index.nodes.has(node)) return undefined;
  for (const cycle of index.cycles) {
    if (cycle.nodes.indexOf(node) !== -1) return cycle;
  }
  return undefined;
}

/**
 * A cycle as the block renders it.
 *
 * Nodes that are no longer in the graph are dropped rather than rendered as their raw key: a key
 * is `setId\0path` and showing one would leak an internal separator into the panel.
 */
export function describeCycle(graph: ReferenceGraph, cycle: Cycle): CycleStep[] {
  const steps: CycleStep[] = [];
  for (let i = 0; i < cycle.nodes.length; i += 1) {
    const from = graph.nodes.get(cycle.nodes[i]);
    const to = graph.nodes.get(cycle.nodes[(i + 1) % cycle.nodes.length]);
    if (from === undefined || to === undefined) continue;
    steps.push({
      from: { path: from.path, setId: from.setId },
      to: { path: to.path, setId: to.setId },
      closing: i === cycle.nodes.length - 1,
    });
  }
  return steps;
}

/** `folio.space.a → folio.space.b → folio.space.c → folio.space.a`, for a one-line message. */
export function cycleSummary(graph: ReferenceGraph, cycle: Cycle): string {
  const paths = cycle.nodes
    .map((key) => graph.nodes.get(key)?.path)
    .filter((path): path is string => path !== undefined);
  if (paths.length === 0) return "";
  return paths.concat([paths[0]]).join(" → ");
}
