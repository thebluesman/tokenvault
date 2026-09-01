// Token path and slug handling — ADR-0002 §1.

import type { TokenGroup, Token } from "./types";

/**
 * Splits a `/`-delimited Figma variable name into DTCG group segments, verbatim.
 *
 * Segments are never slugged, cased, or prefixed with the collection — the token path is the
 * round-trip identity (ADR §1). Empty segments (from a leading, trailing, or doubled `/`) are
 * dropped, since they cannot be represented as a JSON key path.
 */
export function splitVariableName(name: string): string[] {
  return name
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The dotted reference form of a variable name: `a/b/c` → `a.b.c`. */
export function toDottedPath(name: string): string {
  return splitVariableName(name).join(".");
}

/** Lowercased, non-alphanumerics collapsed to `-`, trimmed. Used for file/directory names only. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

/** Case-normalized path key, used for collision detection (ADR §5). */
export function normalizePathKey(path: string): string {
  return path.toLowerCase();
}

/** True when `prefix` is a strict segment-wise prefix of `path` (`a.b` of `a.b.c`, not of `a.bc`). */
export function isStrictPathPrefix(prefix: string, path: string): boolean {
  return path.length > prefix.length && path.startsWith(prefix + ".");
}

/**
 * Writes a token at a segment path into a nested group tree.
 *
 * Returns false without mutating when the path is blocked — either an ancestor segment is
 * already a token leaf, or the target node already exists. Callers treat that as a collision;
 * the collision detector should have caught it first, so a false here is a safety net.
 */
export function setTokenAtPath(root: TokenGroup, segments: string[], token: Token): boolean {
  if (segments.length === 0) return false;

  let node: TokenGroup = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const existing = node[segment];
    if (existing === undefined) {
      const created: TokenGroup = {};
      node[segment] = created;
      node = created;
    } else if (isToken(existing)) {
      return false;
    } else {
      node = existing;
    }
  }

  const leaf = segments[segments.length - 1];
  if (node[leaf] !== undefined) return false;
  node[leaf] = token;
  return true;
}

/** A DTCG node is a token when it carries `$value`; otherwise it is a group. */
export function isToken(node: TokenGroup | Token): node is Token {
  return typeof node === "object" && node !== null && "$value" in node;
}
