// The merged browser's view model — UX local-editor §4, §11.
//
// Shyam's 2026-09-01 call (UX §10.2) is that the Tokens tab browses every set at once. That makes
// the view model a **path-keyed merge, not a set's tree**: `Theme/Light` and `Theme/Dark` hold the
// same 289 dotted paths, and rendering per-set trees side by side would list each of them twice,
// adjacent, differing only in a swatch.
//
// So everything below is keyed by `normalizePathKey`'d dotted path, with each contributing set
// hanging off the row as a value line, ordered by `manifest.tokenSetOrder`. Edits, flags and
// deletes stay keyed by `{path, setId}` — the merged row is a display construct and nothing
// downstream is allowed to mistake it for an identity (UX §11).

import type { Manifest, Token, TokenFileOutput, TokenGroup } from "./types";
import { compareKeys } from "./serialize";
import { isToken, normalizePathKey } from "./paths";

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export interface SetInfo {
  /** `"Theme/Light"` for a Variables mode, `"Styles/Text"` for a style set. The stable identity. */
  id: string;
  /** The short label the tree shows on a value line (§4.2). */
  code: string;
  /** The full set name, shown on hover — always unambiguous even when the code is not. */
  label: string;
  /**
   * Style sets are rendered as the derived things they are (ADR-0003 §1) — the user never
   * authored a set called "Text", so the UI mutes and italicises it.
   */
  source: "variables" | "styles";
  /** Repo-relative file this set was written to. */
  file: string;
}

/** Figma's default single mode. Naming a set after it says nothing, so the collection name wins. */
const DEFAULT_MODE_NAME = /^mode \d+$/i;

/**
 * Short set codes derived from the manifest (§4.2).
 *
 * Rule, in order: a style set is its kind name; a single-mode or `Mode N` collection is its
 * collection name; anything else is its mode name — unless two sets would then collide, in which
 * case both fall back to the full `Collection/Mode` id. The fallback matters more than the
 * shortening: a code that names two different sets is worse than a long one.
 */
export function describeSets(manifest: Manifest): SetInfo[] {
  const byId = new Map<string, SetInfo>();

  for (const collection of manifest.collections) {
    const single = collection.modes.length === 1;
    for (const mode of collection.modes) {
      const generic = single || DEFAULT_MODE_NAME.test(mode.name);
      byId.set(mode.set, {
        id: mode.set,
        code: generic ? collection.name : mode.name,
        label: `${collection.name} / ${mode.name}`,
        source: "variables",
        file: mode.file,
      });
    }
  }

  for (const styleSet of manifest.styleSets ?? []) {
    byId.set(styleSet.set, {
      id: styleSet.set,
      code: styleSet.name,
      label: `${styleSet.name} styles`,
      source: "styles",
      file: styleSet.file,
    });
  }

  const sets = manifest.tokenSetOrder
    .map((id) => byId.get(id))
    .filter((info): info is SetInfo => info !== undefined);

  const counts = new Map<string, number>();
  for (const info of sets) counts.set(info.code, (counts.get(info.code) ?? 0) + 1);
  for (const info of sets) {
    if ((counts.get(info.code) ?? 0) > 1) info.code = info.id;
  }

  return sets;
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** One token, at one path, in one set. The unit everything in the editor is keyed by. */
export interface FlatToken {
  path: string;
  segments: string[];
  setId: string;
  token: Token;
}

/** The token files by repo-relative path, with the two `$`-prefixed metadata files dropped. */
export function treeIndex(files: TokenFileOutput[]): Map<string, TokenGroup> {
  const trees = new Map<string, TokenGroup>();
  for (const file of files) {
    if (file.path.startsWith("tokens/$")) continue;
    trees.set(file.path, file.content as TokenGroup);
  }
  return trees;
}

/**
 * Every token the import wrote, flattened, in `tokenSetOrder` then path order.
 *
 * Read back out of the generated files rather than recomputed from the snapshot, for the same
 * reason `merge.ts` does: what the editor browses should be what was actually written, not what
 * we believe would have been.
 */
export function flattenImport(trees: Map<string, TokenGroup>, manifest: Manifest): FlatToken[] {
  const flat: FlatToken[] = [];
  for (const info of describeSets(manifest)) {
    const tree = trees.get(`tokens/${info.file}`);
    if (tree === undefined) continue;
    walkTokens(tree, [], (token, segments) => {
      flat.push({ path: segments.join("."), segments: segments.slice(), setId: info.id, token });
    });
  }
  return flat;
}

function walkTokens(
  node: TokenGroup,
  segments: string[],
  visit: (token: Token, segments: string[]) => void
): void {
  for (const key of Object.keys(node).sort(compareKeys)) {
    const child = node[key];
    if (child === null || typeof child !== "object") continue;
    const next = segments.concat([key]);
    if (isToken(child)) visit(child, next);
    else walkTokens(child, next, visit);
  }
}

// ---------------------------------------------------------------------------
// Path rows
// ---------------------------------------------------------------------------

/** One row of the merged tree: a path, and every set that defines it (§4.2). */
export interface PathRow {
  /** Display form, taken from the first set that defined it. */
  path: string;
  /** Case-normalized matching key — two sets spelling a path differently are still one row. */
  key: string;
  segments: string[];
  /** In `tokenSetOrder`, always, so `Light` precedes `Dark` on every row in the tree (§4.2). */
  lines: FlatToken[];
}

export function buildPathRows(flat: FlatToken[], sets: SetInfo[]): PathRow[] {
  const order = new Map<string, number>();
  sets.forEach((info, index) => order.set(info.id, index));

  const rows = new Map<string, PathRow>();
  for (const entry of flat) {
    const key = normalizePathKey(entry.path);
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, { path: entry.path, key, segments: entry.segments, lines: [entry] });
    } else {
      existing.lines.push(entry);
    }
  }

  const result = Array.from(rows.values());
  for (const row of result) {
    row.lines.sort(
      (a, b) => (order.get(a.setId) ?? 0) - (order.get(b.setId) ?? 0) || compareKeys(a.setId, b.setId)
    );
  }
  return result;
}

/** True when the sets defining this path disagree on `$type` (§4.2 — a visual signal, not a flag). */
export function hasMixedTypes(row: PathRow): boolean {
  for (let i = 1; i < row.lines.length; i += 1) {
    if (row.lines[i].token.$type !== row.lines[0].token.$type) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface GroupNode {
  kind: "group";
  name: string;
  /** Dotted path of the group itself, e.g. `folio.color.border`. */
  path: string;
  children: TreeNode[];
  /** Descendant **paths**, not tokens — the count the group row shows (§4.4). */
  pathCount: number;
}

export interface TokenNode {
  kind: "token";
  name: string;
  path: string;
  row: PathRow;
}

export type TreeNode = GroupNode | TokenNode;

/**
 * The nested disclosure tree, following DTCG group nesting exactly.
 *
 * Groups merge by name across sets the same way paths do: `folio.color.border` is one group row
 * even when four sets contribute tokens under it (§4.4).
 */
export function buildTree(rows: PathRow[]): TreeNode[] {
  interface Building {
    children: Map<string, Building>;
    row?: PathRow;
  }

  const root: Building = { children: new Map() };

  for (const row of rows) {
    let node = root;
    for (const segment of row.segments) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.row = row;
  }

  const convert = (node: Building, prefix: string[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const name of Array.from(node.children.keys()).sort(compareKeys)) {
      const child = node.children.get(name) as Building;
      const segments = prefix.concat([name]);
      const path = segments.join(".");
      // A path that is both a token and a group cannot survive import — collision detection
      // rejects it upstream (ADR-0002 §5, `token-group`). If one ever did, both nodes are
      // emitted rather than either being silently swallowed by the other.
      if (child.row !== undefined) out.push({ kind: "token", name, path, row: child.row });
      if (child.children.size > 0) {
        const children = convert(child, segments);
        out.push({ kind: "group", name, path, children, pathCount: countPaths(children) });
      }
    }
    return out;
  };

  return convert(root, []);
}

function countPaths(nodes: TreeNode[]): number {
  let total = 0;
  for (const node of nodes) total += node.kind === "token" ? 1 : node.pathCount;
  return total;
}
