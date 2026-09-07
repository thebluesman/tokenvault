// The collapsed-group swatch strip — UX `panel-size-and-swatches.md` §5.
//
// A collapsed group of colours used to read as a name and a number — `▸ red-warm  10` — which says
// how many things are in there and nothing about what they are. This computes the dots that answer
// the second question.
//
// **Computed at model-build time, never at paint time** (§10). `paint()` runs on every scroll frame
// over a virtualized list; walking a group's children per collapsed group per frame is the one way
// this feature becomes a performance bug. The dot list is a function of (group, set filter, type
// filter, theme lens) — the same inputs `filterGroup` keys off — so it is built beside it and
// invalidated with it.

import type { GroupNode } from "../tokens/view";
import type { FlatToken } from "../tokens/view";
import type { Resolution } from "../tokens/resolve";
import { normalizePathKey } from "../tokens/paths";
import { swatchMark } from "./swatch";

/** Six, then `+N` — §5.5, settled in §9.3. Fixed, never derived from the panel's width. */
export const STRIP_CAP = 6;

export interface StripDot {
  /** The leaf segment, for the native `title`: `500 — #C33A2E` (§5.6). */
  leaf: string;
  /** The resolved colour, in the casing the value line shows. */
  color: string;
}

export interface GroupStripModel {
  dots: StripDot[];
  /** How many colour children the cap left out. `0` renders nothing (§5.5). */
  overflow: number;
}

/**
 * The shape `groupStrip` needs from a filtered row.
 *
 * Structural rather than an import of `Row`, so the strip can be tested without standing up a whole
 * editor model — a real `Row` satisfies it as it is.
 */
export interface StripRow {
  row: { key: string };
  lines: Array<{ entry: FlatToken }>;
}

export interface StripInput {
  /** The filtered rows, by `normalizePathKey`'d path — `visibleRows()` keyed the way the tree keys it. */
  lookup(key: string): StripRow | undefined;
  /**
   * `normalizePathKey(path)` → the token the **active theme's** set stack resolves that path to
   * (`ResolveContext.stack`).
   *
   * This is what makes the dot the lens's answer rather than the first set's (§5.4). When the lens's
   * set is filtered out — or the lens has nothing for this path — the fallback is the first
   * contributing set in `tokenSetOrder`, which is the order `lines` is already in.
   */
  stack: Map<string, FlatToken>;
  resolve(entry: FlatToken): Resolution;
  cap?: number;
}

/**
 * The strip for one group, or `null` when the group gets none.
 *
 * §5.2's rule, and it does two jobs with one line: **a strip's dots are the group's own direct
 * colour children.** A group whose colours live in sub-groups gets nothing, which is what stops
 * collapsed `folio` rendering six arbitrary swatches and `+281` — six dots read as *"this group is
 * these six colours"*, and for `folio` that is honest, useless and actively misleading.
 *
 * The caller decides *whether to ask*: an expanded group is never asked (its children are showing
 * their own swatches one line below), and neither is anything while searching, because the tree
 * flattens and group rows disappear entirely (§5.2, `local-editor.md` §4.6).
 */
export function groupStrip(node: GroupNode, input: StripInput): GroupStripModel | null {
  const cap = input.cap ?? STRIP_CAP;
  const dots: StripDot[] = [];
  let colorChildren = 0;

  // Tree order — the order the children appear when you expand (§5.4). Not sorted by hue or
  // lightness: the strip previews the list, and a sorted strip stops matching the list it previews.
  for (const child of node.children) {
    if (child.kind !== "token") continue;
    const row = input.lookup(normalizePathKey(child.path));
    if (row === undefined) continue;

    // One dot per **path**, not per value line (§5.4): a path defined in both `Light` and `Dark` is
    // one dot, or a six-shade group in a two-theme file would render twelve.
    const color = colorFor(row, input);
    if (color === null) continue;
    colorChildren += 1;
    if (dots.length < cap) dots.push({ leaf: child.name, color });
  }

  if (colorChildren === 0) return null;
  return { dots, overflow: colorChildren - dots.length };
}

/**
 * The one colour a path contributes, through the active theme lens.
 *
 * A child that resolves to no colour — a cycle, a dangling reference, a wrong-type reference —
 * contributes nothing and is simply skipped (§5.4). At 8px a dashed outline is illegible, and the
 * group row's `⚑` already says something under here needs attention. Dots can therefore be fewer
 * than the colour children, which is the same "dots ≤ count" situation as §5.2's mixed group.
 */
function colorFor(row: StripRow, input: StripInput): string | null {
  const lens = input.stack.get(row.row.key);
  if (lens !== undefined) {
    const line = row.lines.filter((each) => each.entry.setId === lens.setId)[0];
    if (line !== undefined) {
      const mark = swatchMark(line.entry.token, input.resolve(line.entry));
      if (mark.kind === "color") return mark.color;
    }
  }

  for (const line of row.lines) {
    const mark = swatchMark(line.entry.token, input.resolve(line.entry));
    if (mark.kind === "color") return mark.color;
  }
  return null;
}

/** `500 — #C33A2E` — leaf segment, em dash, resolved value (§6). */
export function dotTitle(dot: StripDot): string {
  return `${dot.leaf} — ${dot.color}`;
}
