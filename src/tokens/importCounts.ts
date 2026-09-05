// The Import tab's summary grid, banded — UX `onboarding-polish.md` §6.1.
//
// The nine boxes shipped as one flat row, whose last three were:
//
//     13 Flagged        3 Partial       132 Unconfirmed
//
// Three numbers, same weight, same colour. Two of them are import defects — *we couldn't represent
// this*, *we represented part of this* — and the third is a job. Rendered identically, all three
// read as *132 things went wrong*, and the largest number is the one that didn't.
//
// **No number changes here, ever** (§6.4). This module reorders and re-labels; it does not
// suppress, soften, defer or zero a single count. A chip that softens a true number once to be
// friendly is a chip nobody believes on the day the number matters.

import type { ImportResultCounts } from "./types";

export interface CountBox {
  label: string;
  value: number;
}

export interface CountBand {
  /** *Read from this file* answers "what did this thing just do", which nothing on screen does. */
  heading: string;
  boxes: CountBox[];
}

/**
 * Two headings, not two colours.
 *
 * Making the second band amber would say *132 problems* louder than the current layout says it by
 * accident. The heading is what tells the reader which band a number belongs to, and that is the
 * whole fix.
 */
export function countBands(counts: ImportResultCounts): CountBand[] {
  return [
    {
      heading: "Read from this file",
      boxes: [
        { label: "Collections", value: counts.collections },
        { label: "Modes", value: counts.modes },
        { label: "Variables", value: counts.variables },
        { label: "Styles", value: counts.styles ?? 0 },
        { label: "Tokens", value: counts.tokens },
        // Of the token total, so a file whose styles all mirrored Variables reads as 0 rather than
        // looking like the styles scan silently failed.
        { label: "from styles", value: counts.styleTokens ?? 0 },
      ],
    },
    {
      heading: "Needs a look",
      boxes: [
        { label: "Flagged", value: counts.flagged },
        { label: "Partial", value: counts.partialTokens ?? 0 },
        // "Unconfirmed" names a defect state of a token. "To confirm" names a job of the user's,
        // which is what it is — and it matches the section header below it.
        { label: "to confirm", value: counts.unconfirmedSubtypes },
      ],
    },
  ];
}
