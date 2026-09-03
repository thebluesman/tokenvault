// Reference values and the inbound-reference index — UX local-editor §5.3, §7.
//
// Phase 4 neither resolves nor rewrites references (that is Phase 7, PRD §6.3). It needs exactly
// two things from them: to recognise one so the value editor can refuse to edit it, and to know
// who points at a token so a delete that would strand them can be blocked.
//
// The index is built once per import rather than scanned per delete: at 1,316 tokens a scan per
// `⋯` menu open is a visible stall, and the delete affordance has to know the count *before* it
// is clicked in order to render disabled (UX §7).

import type { Token, TokenValue } from "./types";
import { normalizePathKey } from "./paths";

/**
 * A DTCG alias: the whole value is `{dotted.path}`.
 *
 * Anchored deliberately. A value that merely *contains* braces — a font family, a description —
 * is not a reference, and Phase 7's math (`{a} * 2`) is not one either. Treating a partial match
 * as a reference here would make the value editor refuse to edit a literal string.
 */
const REFERENCE = /^\{([^{}]+)\}$/;

export function isReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE.test(value);
}

/** The dotted path inside `{…}`, or null when the value is not a reference. */
export function referenceTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = REFERENCE.exec(value);
  return match === null ? null : match[1].trim();
}

/**
 * Every path this token points at — from `$value` (walking composite sub-values) and from the
 * `boundVariables` provenance block.
 *
 * `boundVariables` counts: a text style bound to `{folio.typography.font-size.70}` really does
 * depend on it, and UX §7 names it explicitly as something the delete check must see.
 */
export function collectReferences(token: Token): string[] {
  const found = collectValueReferences(token.$value);

  const bound = token.$extensions?.["com.tokenvault"]?.figma?.boundVariables;
  if (bound) {
    for (const field of Object.keys(bound)) {
      const target = referenceTarget(bound[field]);
      // An unnameable binding is stored as the raw variable id, which is not a reference.
      if (target !== null) found.push(target);
    }
  }

  return found;
}

/**
 * Every path a `$value` points at, walking composite sub-values — and *only* `$value`.
 *
 * The half of `collectReferences` that is about the value the user authored, split out because the
 * Phase 8 export needs exactly that half: an unresolvable `boundVariables` entry is stale
 * provenance, not a value that would land wrong in the emitted CSS. One walker, two callers, so
 * the export and the delete check can never disagree about what counts as a reference.
 */
export function collectValueReferences(value: TokenValue | undefined): string[] {
  const found: string[] = [];
  collectFromValue(value, found);
  return found;
}

function collectFromValue(value: TokenValue | undefined, into: string[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    const target = referenceTarget(value);
    if (target !== null) into.push(target);
    return;
  }
  if (typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item as TokenValue, into);
    return;
  }

  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    collectFromValue(record[key] as TokenValue, into);
  }
}

/** One token that points at something, identified the way the merged browser identifies rows. */
export interface Referrer {
  path: string;
  setId: string;
}

/**
 * `normalizePathKey(target)` → the tokens referencing it.
 *
 * Case-normalized on both sides, matching how collision detection compares paths (ADR-0002 §5):
 * a reference that differs only in case still lands on the same token in Figma, so it still
 * blocks the delete.
 */
export type InboundIndex = Map<string, Referrer[]>;

export function buildInboundIndex(
  tokens: Array<{ path: string; setId: string; token: Token }>
): InboundIndex {
  const index: InboundIndex = new Map();

  for (const entry of tokens) {
    for (const target of collectReferences(entry.token)) {
      const key = normalizePathKey(target);
      const referrers = index.get(key);
      const referrer: Referrer = { path: entry.path, setId: entry.setId };
      if (referrers === undefined) index.set(key, [referrer]);
      else referrers.push(referrer);
    }
  }

  return index;
}

/**
 * Inbound referrers of `path`, excluding any token that is itself going away in the same
 * operation.
 *
 * The exclusion is what makes a group delete possible at all (UX §7): tokens inside the group
 * reference each other, and those references are not stranded by a delete that takes both ends.
 */
export function inboundReferrers(
  index: InboundIndex,
  path: string,
  excluded?: (referrer: Referrer) => boolean
): Referrer[] {
  const referrers = index.get(normalizePathKey(path)) ?? [];
  if (excluded === undefined) return referrers.slice();
  return referrers.filter((referrer) => !excluded(referrer));
}
