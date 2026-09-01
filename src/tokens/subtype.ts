// Number/string subtype tagging — ADR-0002 §3, PRD §6.1.

import type { Subtype, SubtypeSelection, SubtypeSource, TokenGroup, Token } from "./types";
import { isToken } from "./paths";

export const NUMBER_SUBTYPES: Subtype[] = [
  "spacing",
  "sizing",
  "radius",
  "opacity",
  "duration",
  "unitless",
];

export const STRING_SUBTYPES: Subtype[] = ["easing"];

/** ADR §3: the importer's guess when no scope tells us anything. */
export const DEFAULT_NUMBER_SUBTYPE: Subtype = "spacing";

/** The sentinel the confirm/override step sends to mean "deliberately no subtype". */
export const UNTAGGED = "untagged" as const;

/**
 * `VariableScope` → subtype, in priority order.
 *
 * Order matters: a variable can carry several scopes, and `OPACITY` is the one PRD §6.1 names
 * explicitly, so it wins. Everything below it is the "maps where unambiguous" set from ADR §3.
 * Colour, text and effect scopes are deliberately absent — they say nothing about a *number's*
 * unit, so they fall through to the default and get surfaced for confirmation.
 */
const SCOPE_PRIORITY: Array<{ scope: string; subtype: Subtype }> = [
  { scope: "OPACITY", subtype: "opacity" },
  { scope: "CORNER_RADIUS", subtype: "radius" },
  { scope: "WIDTH_HEIGHT", subtype: "sizing" },
  { scope: "GAP", subtype: "spacing" },
];

export interface SubtypeTag {
  subtype?: Subtype;
  subtypeSource?: SubtypeSource;
}

/**
 * Resolves the subtype tag for one variable.
 *
 * Precedence: an explicit user tag always wins (ADR §3 — user tags are preserved across
 * re-imports and never recomputed), then scope auto-detection, then the default guess.
 *
 * Duration and easing are never auto-detected: Figma has no `VariableScope` for either, so
 * they can only ever arrive as `subtypeSource: "user"` (PRD §6.1, commits e7098cf/eb32ea9).
 */
export function resolveSubtype(
  tokenType: "color" | "number" | "boolean" | "string",
  scopes: string[],
  userSubtype: SubtypeSelection | undefined
): SubtypeTag {
  if (tokenType !== "number" && tokenType !== "string") {
    // Colours and booleans have no subtype dimension.
    return {};
  }

  // An explicit "no subtype" is a human decision, not the absence of one. ADR §3: "Absent
  // means untagged" — so the subtype is omitted, but the source records who omitted it, which
  // is what stops the next import from re-guessing `spacing`.
  if (userSubtype === UNTAGGED) return { subtypeSource: "user" };

  const allowed = tokenType === "number" ? NUMBER_SUBTYPES : STRING_SUBTYPES;
  if (userSubtype !== undefined && allowed.indexOf(userSubtype) !== -1) {
    return { subtype: userSubtype, subtypeSource: "user" };
  }

  if (tokenType === "string") {
    // Nothing auto-detects `easing`, so an unconfirmed string is simply untagged.
    return {};
  }

  for (const candidate of SCOPE_PRIORITY) {
    if (scopes.indexOf(candidate.scope) !== -1) {
      return { subtype: candidate.subtype, subtypeSource: "auto" };
    }
  }
  return { subtype: DEFAULT_NUMBER_SUBTYPE, subtypeSource: "default" };
}

/**
 * Reads `subtypeSource: "user"` tags back out of a previously generated token tree, keyed by
 * Figma variable id (ADR §3, last bullet).
 *
 * Phase 2 has no git working copy to read from — that lands in Phase 6 — so the plugin also
 * mirrors user tags into `clientStorage`. This function is what Phase 6 will point at the real
 * `tokens/` tree, and it is the authority when both are available: the committed files are the
 * source of truth, `clientStorage` is only a local cache.
 */
export function extractUserSubtypes(tree: TokenGroup): Record<string, SubtypeSelection> {
  const result: Record<string, SubtypeSelection> = {};

  const walk = (node: TokenGroup): void => {
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child === null || typeof child !== "object") continue;
      if (isToken(child)) {
        collect(child, result);
      } else {
        walk(child);
      }
    }
  };

  walk(tree);
  return result;
}

function collect(token: Token, into: Record<string, SubtypeSelection>): void {
  const extension = token.$extensions?.["com.tokenvault"];
  if (!extension) return;
  if (extension.subtypeSource !== "user") return;
  const variableId = extension.figma?.variableId;
  if (typeof variableId !== "string" || variableId.length === 0) return;
  // `subtypeSource: "user"` with no subtype is the recorded "deliberately untagged" decision.
  into[variableId] = extension.subtype ?? UNTAGGED;
}

/** Merges user subtypes from several previously generated token files. Later files win. */
export function extractUserSubtypesFromFiles(trees: TokenGroup[]): Record<string, SubtypeSelection> {
  const merged: Record<string, SubtypeSelection> = {};
  for (const tree of trees) {
    const found = extractUserSubtypes(tree);
    for (const key of Object.keys(found)) {
      merged[key] = found[key];
    }
  }
  return merged;
}
