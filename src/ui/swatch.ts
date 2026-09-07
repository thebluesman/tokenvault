// What mark a colour token gets — UX `panel-size-and-swatches.md` §4.2, §5.4.
//
// One function, asked by two surfaces: the 16px circular chip on a value line and the 8px square dot
// in a collapsed group's strip. The two look different on purpose (`local-editor.md` §4.5, amended
// 2026-09-07) but must never disagree about *colour*, which is §5.4's whole point — if the strip
// worked out its own colours, expanding a group could show six colours that disagree with the six
// dots you clicked to see them. Both callers ask this; neither decides for itself.
//
// The three no-colour cases (§4.2) collapse to two answers here, because from the swatch's point of
// view a cycle, a dangling reference and a reference that lands on a number are all *"this colour
// token has no colour to show."* The `⚑ cycle` / `⚠` flag beside it is what says which; a 16px
// chip cannot carry that distinction and is not asked to.

import type { Token } from "../tokens/types";
import type { Resolution } from "../tokens/resolve";
import { previewOf } from "../tokens/preview";
import { el } from "./dom";

export type SwatchMark =
  /** Paint this colour. A literal and a resolved reference are indistinguishable here (issue #28). */
  | { kind: "color"; color: string }
  /** The dashed outline: a colour token whose pointer resolves nowhere, or to a non-colour (§4.2). */
  | { kind: "outlined" }
  /**
   * No mark at all.
   *
   * Two different situations, and the caller tells them apart by the token's `$type` rather than by
   * asking again: a cycle on a **colour** token still reserves the chip-wide slot so its `—` lines up
   * with its siblings' hex (§4.3), while a non-colour token has no slot to reserve.
   */
  | { kind: "none" };

/**
 * The two hex forms a token value is ever written in, plus the shorthands a hand-edited repo file
 * can legitimately carry.
 *
 * Stricter than "is this a string" and looser than `values.ts`'s `hexToRgba`, on purpose. It exists
 * to answer §4.2's wrong-type case: a colour token pointing at a `string` token resolves to
 * `"Urbanist"`, and painting that as a colour renders an invisible chip that claims a colour is
 * there. This is the check that turns it into the dashed outline the design asks for.
 */
const COLOR_VALUE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isColorValue(value: unknown): boolean {
  return typeof value === "string" && COLOR_VALUE.test(value.trim());
}

/**
 * The mark for one colour value line, under the active theme's resolution.
 *
 * `resolution` is the same `Resolution` the value line's text and badges come from, so the mark and
 * the words beside it can never describe different states.
 */
export function swatchMark(token: Token, resolution: Resolution): SwatchMark {
  if (token.$type !== "color") return { kind: "none" };

  // §7.1's rule reaches down here: a token on a loop has no value, so it has no colour, and any
  // mark in the slot would be a claim about a colour that does not exist. Not even an outline —
  // the outline means "this points at nothing", which is a different and wrong statement.
  if (resolution.kind === "cycle") return { kind: "none" };

  const preview = previewOf(token);

  // A literal. Trusted as authored — this is the path that has shipped since Phase 4 and the value
  // is the token's own `$value`, not something we resolved on its behalf.
  if (preview.swatch !== undefined) return { kind: "color", color: preview.swatch };

  if (preview.reference !== undefined) {
    // `previewOf` is pure over the token, so a pointer never carries a `swatch` — the colour it
    // lands on exists only on the resolution.
    if (isColorValue(resolution.value)) return { kind: "color", color: String(resolution.value) };
    // Dangling (points at a path in no set) and wrong-type (resolves, but to a non-colour) share
    // this one mark, per §4.2.
    return { kind: "outlined" };
  }

  return { kind: "none" };
}

/**
 * The mark, as nodes — one function, so the tree row and the card's value shell cannot diverge.
 *
 * `edit-view-redesign.md` §4.3 and §12 are explicit about this: the swatch inside `.value-shell` is
 * *this* call and these classes, not a parallel treatment. Two implementations of a colour chip is
 * the failure `panel-size-and-swatches.md` §5.4 exists to prevent, reappearing one surface over.
 *
 * `{ kind: "none" }` renders the reserved slot rather than nothing — a cycle draws no mark, and its
 * `—` still has to land in the same column as its siblings' hex (§4.3). Callers on a non-colour row
 * simply don't ask.
 */
export function swatchNode(mark: SwatchMark): HTMLElement {
  if (mark.kind === "color") {
    const wrap = el("span", "swatch-wrap");
    wrap.appendChild(el("span", "swatch"));
    const fill = el("span", "swatch-fill");
    fill.style.background = mark.color;
    wrap.appendChild(fill);
    return wrap;
  }
  if (mark.kind === "outlined") {
    const wrap = el("span", "swatch-wrap");
    wrap.appendChild(el("span", "swatch outlined"));
    return wrap;
  }
  // Nothing to paint, which is why `.reserved` adds no properties of its own — the class exists so
  // the markup says what the empty box is for.
  return el("span", "swatch-wrap reserved");
}
