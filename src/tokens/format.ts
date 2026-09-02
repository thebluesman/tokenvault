// One value-to-string function, for every surface that has to show a token value inline.
//
// It lives in `src/tokens/` rather than `src/ui/` because `drift.ts` is one of its callers: drift
// messages are built plugin-side, in a pure module that the UI layer must not be able to reach
// into. Keeping the formatter beside the value types is what lets all five call sites share it
// without inverting that dependency.
//
// The five call sites it replaces had drifted apart in three ways — the placeholder for an absent
// value, whether an empty string rendered as anything at all, and where a long object got cut. The
// first two are genuine differences (a report sentence reads "it was unset", a table cell reads
// "—"), so they stay as options; the third was arbitrary, and is now the caller's stated budget for
// the line it is writing into.

import { stableStringify } from "./serialize";

export interface DescribeOptions {
  /** What an absent value renders as. Prose says "unset"; a table column says "—". */
  unset?: string;
  /** Maximum characters for a serialized object, ellipsis included. Absent means no truncation. */
  limit?: number;
}

/**
 * A token value as one line of text.
 *
 * The empty-string branch is not cosmetic: a string token set to `""` would otherwise render as
 * nothing at all, so a row reading `#b4342a → ` would be indistinguishable from a broken render.
 */
export function describeValue(value: unknown, options: DescribeOptions = {}): string {
  if (value === undefined) return options.unset ?? "—";
  if (value === "") return "empty";
  if (typeof value === "object" && value !== null) {
    const json = stableStringify(value as never).trim().replace(/\s+/g, " ");
    const limit = options.limit;
    return limit !== undefined && json.length > limit ? `${json.slice(0, limit - 1)}…` : json;
  }
  return String(value);
}
