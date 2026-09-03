// The one diff row — UX apply-and-drift §10, UX git-sync §14.
//
//   > Reuse Phase 5's row component for the commit diff, the compare view, and the apply dialog.
//   > Phase 5 §10 built it as `{ target, before, after, state }` for exactly this. **If Phase 6
//   > introduces a second diff row, something went wrong.**
//
// Phase 5 built the row inside `applyDialog.ts` because that was the only surface that had one.
// Phase 6 has three — the apply dialog, the Review & push screen and the Compare screen — so it
// moves here unchanged rather than being reimplemented next door. Moving the commit surface out of
// a modal changed its container, not its rows (UX §7.2).
//
// Nothing in here knows about apply plans, git, or the overlay. It takes two values and a state.

import type { TokenValue } from "../tokens/types";
import { el, swatch } from "./dom";
import { truncateReference } from "../tokens/preview";
import { describeValue } from "../tokens/format";

export interface DiffRowData {
  path: string;
  /** Shown on hover, never inline: the row is already at its width budget. */
  set?: string;
  before?: TokenValue;
  after?: TokenValue;
  /**
   * A reference row shows the **pointer**, not a colour, on the "after" side (UX apply §5.6).
   * `↗` on the primary line tells the user what lands on the canvas without letting them mistake
   * a pointer for a colour.
   */
  alias?: { path: string; resolved?: TokenValue };
  /**
   * A math expression, with the number it flattens to — ADR-0007 §4, UX §6.3.
   *
   * Apply is the one evaluation point that flattens, so the number that lands is on screen **before
   * the button is pressed**: *"a user cannot flatten without seeing the number that lands"*. The row
   * is checked by default like any other — an expression is not a degraded apply and does not get
   * §5.6's unchecked-flattening-fallback treatment, which exists for the different case where a
   * pointer the user wanted *couldn't* be preserved.
   *
   * This is Phase 5's row with a third line, not a new row kind. If Phase 7 introduces a second
   * diff row, something went wrong.
   */
  expression?: { source: string; resolved?: number };
  state: "ready" | "blocked" | "added" | "removed";
  /** Why a blocked row is blocked. Never hidden until after the write.  */
  why?: string;
}

/** The `old → new` pair. Exported on its own for callers that supply their own row chrome. */
export function diffLine(data: DiffRowData): HTMLElement {
  const wrap = el("div");
  const line = el("div", "diff");

  if (data.state === "added") line.appendChild(el("span", undefined, "—"));
  else appendValue(line, data.before, false);

  line.appendChild(el("span", undefined, "→"));

  if (data.state === "removed") {
    line.appendChild(el("span", "to", "removed"));
    wrap.appendChild(line);
    return wrap;
  }

  if (data.alias !== undefined) {
    const pointer = el("span", "to", `↗ {${truncateReference(data.alias.path)}}`);
    pointer.title = `{${data.alias.path}}`;
    line.appendChild(pointer);
    wrap.appendChild(line);
    if (data.alias.resolved !== undefined) {
      const resolved = el("div", "resolved");
      resolved.appendChild(document.createTextNode("resolves to "));
      appendValue(resolved, data.alias.resolved, false);
      wrap.appendChild(resolved);
    }
    return wrap;
  }

  if (data.expression !== undefined) {
    const formula = el("span", "to", data.expression.source);
    formula.title = data.expression.source;
    line.appendChild(formula);
    wrap.appendChild(line);
    if (data.expression.resolved !== undefined) {
      wrap.appendChild(
        el("div", "resolved", `= ${String(data.expression.resolved)} · applied as a number`)
      );
    }
    return wrap;
  }

  appendValue(line, data.after, true);
  wrap.appendChild(line);
  return wrap;
}

/** The whole row: a path, the diff line, and the blocked treatment when it can't go. */
export function diffRow(
  data: DiffRowData,
  options: { checkbox?: HTMLInputElement } = {}
): HTMLElement {
  const row = el("div", data.state === "blocked" ? "plan-row blocked" : "plan-row");
  if (options.checkbox !== undefined) row.appendChild(options.checkbox);
  else if (data.state === "blocked") row.appendChild(el("span", "dot", "⚠"));

  const grow = el("div", "grow");
  const path = el("div", "path", data.path);
  path.title = data.set === undefined ? data.path : `${data.path} · ${data.set}`;
  grow.appendChild(path);

  if (data.state === "blocked") grow.appendChild(el("div", "why", data.why ?? "Can't be applied."));
  else grow.appendChild(diffLine(data));

  row.appendChild(grow);
  return row;
}

export function appendValue(into: HTMLElement, value: TokenValue | undefined, isAfter: boolean): void {
  const text = describe(value);
  if (typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
    const wrapper = el("span", "swatch-wrap");
    wrapper.appendChild(swatch(value, false));
    const fill = el("span", "swatch-fill");
    fill.style.background = value;
    wrapper.appendChild(fill);
    into.appendChild(wrapper);
  }
  into.appendChild(el("span", isAfter ? "to" : undefined, text));
}

/** 46 characters is what one side of the `old → new` diff line holds at 460px. */
export function describe(value: TokenValue | undefined): string {
  return describeValue(value, { unset: "unset", limit: 46 });
}
