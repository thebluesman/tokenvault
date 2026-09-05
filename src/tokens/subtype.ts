// Number/string subtype tagging — ADR-0002 §3, PRD §6.1.

import type {
  Subtype,
  SubtypeSelection,
  SubtypeSource,
  TokenGroup,
  Token,
  TokenType,
} from "./types";
import { isToken } from "./paths";
import { compareKeys } from "./serialize";

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
  tokenType: TokenType,
  scopes: string[],
  userSubtype: SubtypeSelection | undefined
): SubtypeTag {
  if (tokenType !== "number" && tokenType !== "string") {
    // Colours and booleans have no subtype dimension, and neither do the composite style types:
    // `typography`, `shadow` and `grid` are self-describing, so ADR-0003 §2 gives them no
    // subtype/subtypeSource keys and no confirm step.
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
 * Wired into the sync path as of issue #23: `src/code.ts` runs it over the repo tree every time one
 * arrives (connect-and-adopt, and after every pull) and feeds the result through
 * `adoptUserSubtypes`. `clientStorage` remains the per-device store the build reads from; the
 * committed files are what let a confirmation made on one machine reach another at all.
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

export interface SubtypeAdoption {
  /** The tags to hold locally after the repo has been read. */
  subtypes: Record<string, SubtypeSelection>;
  /** Variable ids taken from the repo — this device had no answer for them. */
  adopted: string[];
  /** Variable ids where this device's own answer differed and was kept. */
  kept: string[];
}

/**
 * Reconciles the repo's confirmed subtypes with this device's — issue #23.
 *
 * Confirmations are keyed by Figma variable id, and a variable id belongs to the *document*, not to
 * the machine that read it: two people opening the same file see `VariableID:1:4` as the same
 * variable. That is what makes a tag committed by one device meaningful to another, and it is why
 * ADR-0002 §3's last bullet can call the committed files the authority for `subtypeSource: "user"`.
 *
 * **A local answer is never overwritten.** Adoption fills gaps only: an id this device has already
 * answered keeps its answer and is reported in `kept`, on ADR-0004 §4's reasoning — the repo's
 * version is one pull away, and a local decision overwritten in place is simply gone. A `kept` id is
 * a real disagreement and will read as a file to push, which is the honest outcome: the two devices
 * genuinely say different things, and the push/pull pair is where that gets settled.
 *
 * Nothing here is a write of any kind. A subtype is build metadata — it reaches `$extensions` and
 * the panel's warnings and nothing else (`src/tokens/edit.ts`'s `subtypeWarning` is its only other
 * consumer), so it never becomes a Figma mutation and ADR-0006 §5's "a pull never writes to Figma"
 * is not in play. Pulled *values* still land as pending overlay entries, unchanged.
 */
export function adoptUserSubtypes(
  local: Record<string, SubtypeSelection>,
  remote: Record<string, SubtypeSelection>
): SubtypeAdoption {
  const subtypes: Record<string, SubtypeSelection> = {};
  for (const key of Object.keys(local)) subtypes[key] = local[key];

  const adopted: string[] = [];
  const kept: string[] = [];

  // Sorted so the two report lists are stable whatever order the repo files were read in — the
  // same reason every other list that crosses `postMessage` in this codebase is sorted.
  for (const variableId of Object.keys(remote).sort(compareKeys)) {
    const mine = local[variableId];
    if (mine === undefined) {
      subtypes[variableId] = remote[variableId];
      adopted.push(variableId);
      continue;
    }
    if (mine !== remote[variableId]) kept.push(variableId);
  }

  return { subtypes, adopted, kept };
}
