// The apply dialog — UX apply-and-drift §5.2, ADR-0005 §6.
//
// **This module is an invariant, not a convenience.** UX §5.2, spelled out for the engineer:
//
//   > there is no code path that writes to Figma without this dialog having been shown and
//   > confirmed — not the single-token `⋯ → Apply`, not `Re-apply token` on a drift row, not a
//   > bulk re-apply from the Changes list. Every one of them routes through here.
//
// `openApplyDialog` is therefore the only caller of the `apply` message in the whole UI, and the
// assertion at the bottom of this file is UX §10's *"assert it if that's cheap"* taken literally.
// A future fast path amends the doc first.
//
// The weight budget follows from the same rule: the dialog is unconditional, so the user sees it on
// every single apply, forever, and every control in it is paid for a thousand times over. Hence a
// `✕` rather than a back arrow, a two-line header, no tabs, no search, and three free ways out.

import type { ApplyEntry, ApplyPlan } from "../tokens/plan";
import type { PlannedWrite } from "../figma/apply";
import type { Cycle } from "../tokens/graph";
import { button, clear, el } from "./dom";
import { getModel, send } from "./state";
import { diffRow } from "./diffRow";
import { cycleBlock } from "./valueField";
import { normalizePathKey } from "../tokens/paths";

const modalEl = document.getElementById("modal") as HTMLElement;

let onEscape: ((event: KeyboardEvent) => void) | null = null;

export function isModalOpen(): boolean {
  return !modalEl.classList.contains("hidden");
}

export function closeModal(): void {
  modalEl.classList.add("hidden");
  clear(modalEl);
  if (onEscape !== null) {
    document.removeEventListener("keydown", onEscape);
    onEscape = null;
  }
}

/**
 * A modal card over a dimmed panel, dismissible three ways — `Cancel`, `Esc`, backdrop tap.
 *
 * All three do the same nothing. There is no "are you sure you want to cancel", no
 * confirmation-on-a-confirmation, and dismissing discards the row selection rather than
 * remembering it: a dialog the user backed out of should not ambush them with stale checkboxes
 * next time.
 */
export function openModal(build: (close: () => void) => HTMLElement): void {
  closeModal();
  const card = build(closeModal);
  card.addEventListener("mousedown", (event) => event.stopPropagation());
  modalEl.appendChild(card);
  modalEl.classList.remove("hidden");
  modalEl.addEventListener("mousedown", closeModal);

  onEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", onEscape);
}

// ---------------------------------------------------------------------------

export interface ApplyRequest {
  plan: ApplyPlan;
  /** `Apply to Figma`, or a scoped variant like `Apply folio.color.border`. */
  title: string;
  /** What happens when there is genuinely nothing to do — UX §5.3's toast. */
  nothingToDo: string;
  onNothingToDo: (message: string) => void;
}

/**
 * Opens the dialog for a plan, or reports that the scope is already clean.
 *
 * The "already clean" branch is UX §5.3's: if everything matches, the dialog doesn't open at all
 * and a toast says so. Opening a dialog whose only button is disabled would make the user dismiss
 * a screen to learn nothing happened.
 */
export function openApplyDialog(request: ApplyRequest): void {
  const { plan } = request;

  // The invariant this module already enforces, used for a second thing: every apply passes through
  // here, so this is the one place that can refuse an apply built on guards that were never
  // established. A tree restored from an old import cache carries an *empty* style-guard map and
  // an empty non-local path set, and empty passes every check made against it — so the write that
  // ADR-0005 §3 refuses would go through instead. The plan refuses each row too; this stops the
  // user opening a dialog whose every row is blocked, and says what to do about it.
  if (!getModel().guardsKnown) {
    request.onNothingToDo(
      "Rescan the file before applying — this tree came from the cache, so Tokenvault can't tell what a write would overwrite."
    );
    return;
  }

  if (plan.ready === 0 && plan.skipped === 0) {
    request.onNothingToDo(request.nothingToDo);
    return;
  }

  const checked = new Set(
    plan.entries.filter((entry) => entry.status === "ready").map((entry) => entry.key + entry.op)
  );

  openModal((close) => {
    const card = el("div", "modal-card");

    const head = el("div", "modal-head");
    const heading = el("div", "grow");
    heading.appendChild(el("div", "title", request.title));
    heading.appendChild(el("div", "sub", summarise(plan)));
    head.appendChild(heading);
    const dismiss = el("button", "modal-close", "✕");
    dismiss.title = "Cancel";
    dismiss.addEventListener("click", close);
    head.appendChild(dismiss);
    card.appendChild(head);

    const body = el("div", "modal-body");
    const foot = el("div", "modal-foot");
    const confirm = button("Apply", "primary");

    const recount = (): void => {
      confirm.textContent = checked.size === 0 ? "Apply" : `Apply ${checked.size} change${checked.size === 1 ? "" : "s"}`;
      confirm.disabled = checked.size === 0;
    };

    renderPlan(body, plan, checked, recount);
    card.appendChild(body);

    // The undo reality, stated once, in the place the decision is made — never in a toast, which
    // is the wrong place to teach a mechanic and would repeat forever (UX §5.5).
    //
    // The copy is the *sharpened* form UX §5.5 authorised conditionally: "If plugin writes do land
    // as one undo step, the copy can be sharpened to 'Undo it with ⌘Z in Figma'." Verified — see
    // `beginUndoStep` in src/figma/apply.ts. `figma.commitUndo()` on both sides of the batch makes
    // this apply its own single undo entry with nothing else in it.
    foot.appendChild(el("div", "note", "Undo it with ⌘Z in Figma — the plugin has no undo for this."));

    const actions = el("div", "actions");
    const cancel = button("Cancel");
    cancel.addEventListener("click", close);
    actions.appendChild(cancel);
    actions.appendChild(el("span", "grow"));

    confirm.addEventListener("click", () => {
      const writes: PlannedWrite[] = [];
      for (const entry of plan.entries) {
        if (entry.status !== "ready" || entry.write === undefined) continue;
        if (!checked.has(entry.key + entry.op)) continue;
        writes.push({ key: entry.key + entry.op, targetKey: entry.key, write: entry.write });
      }
      close();
      // The single exit. Every apply in the product is this line.
      send({ type: "apply", writes });
    });
    actions.appendChild(confirm);
    foot.appendChild(actions);
    card.appendChild(foot);

    recount();
    return card;
  });
}

function summarise(plan: ApplyPlan): string {
  const parts: string[] = [];
  parts.push(`${plan.ready} change${plan.ready === 1 ? "" : "s"}`);
  if (plan.matches > 0) parts.push(`${plan.matches} already match Figma`);
  if (plan.skipped > 0) parts.push(`${plan.skipped} can't be applied`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Grouped by Figma target, not by token path.
 *
 * The user is about to modify collections and styles, and that is the unit of consequence. It also
 * makes "oh, this touches the Base collection too" visible, which a path-sorted list hides.
 */
function renderPlan(
  body: HTMLElement,
  plan: ApplyPlan,
  checked: Set<string>,
  recount: () => void
): void {
  const ready = plan.entries.filter((entry) => entry.status === "ready");
  const bySet = new Map<string, ApplyEntry[]>();
  for (const entry of ready) {
    const list = bySet.get(entry.set);
    if (list === undefined) bySet.set(entry.set, [entry]);
    else list.push(entry);
  }

  for (const [set, entries] of bySet) {
    body.appendChild(el("div", "plan-group", set));
    for (const entry of entries) body.appendChild(readyRow(entry, checked, recount));
  }

  // UX §5.3 wants in-sync rows visible so the count is honest about a scope that is mostly fine —
  // but at 289 tokens per set, one row each would bury the four that matter. Collapsed to a single
  // green line, which says the same thing in the same glance and costs one row instead of 289.
  if (plan.matches > 0) {
    const line = el("div", "ok-line");
    line.appendChild(el("span", "dot", "●"));
    line.appendChild(
      el("span", undefined, `${plan.matches} token${plan.matches === 1 ? "" : "s"} already match Figma`)
    );
    body.appendChild(line);
  }

  // Blocked rows are listed but not checkable, with the reason inline. Never hide a failure until
  // after the write.
  const blocked = plan.entries.filter((entry) => entry.status === "skipped");
  if (blocked.length > 0) {
    body.appendChild(
      el("div", "plan-group", `⚠ ${blocked.length} can't be applied`)
    );
    for (const entry of blocked) body.appendChild(blockedRow(entry));
  }
}

/**
 * One ready row — the shared `{ path, before, after, state }` component from `diffRow.ts`.
 *
 * Per-row checkboxes, all checked. Not a nag — the escape hatch for "apply six of these, I'm not
 * sure about the seventh".
 */
function readyRow(entry: ApplyEntry, checked: Set<string>, recount: () => void): HTMLElement {
  const id = entry.key + entry.op;
  const box = el("input") as HTMLInputElement;
  box.type = "checkbox";
  box.checked = checked.has(id);
  box.addEventListener("change", () => {
    if (box.checked) checked.add(id);
    else checked.delete(id);
    recount();
  });

  return diffRow(
    {
      path: entry.path,
      set: entry.set,
      before: entry.before,
      after: entry.after,
      alias: entry.alias,
      expression: entry.expression,
      state: "ready",
    },
    { checkbox: box }
  );
}

/** The two skip reasons that mean *this token is on a loop* — `plan.ts`'s slugs. */
const CYCLE_REASONS = ["alias-cycle", "expression-cycle"];

function blockedRow(entry: ApplyEntry): HTMLElement {
  const row = diffRow({
    path: entry.path,
    set: entry.set,
    state: "blocked",
    why: entry.message ?? entry.reason ?? "Can't be applied.",
  });

  // UX references-math-themes §7.3c: a cycle row gets `[ Show the loop ]`, *"opening the block
  // rather than repeating it inside a list row"*. The third of the block's three callers, and the
  // one that was missing — a row that says "points into a circular reference" without showing which
  // loop leaves the user hunting through 1,316 tokens for it.
  if (entry.reason === undefined || CYCLE_REASONS.indexOf(entry.reason) === -1) return row;
  const cycle = cycleFor(entry.path);
  if (cycle === undefined) return row;

  const wrap = el("div");
  wrap.appendChild(row);

  const show = button("Show the loop", "toast-action");
  show.style.color = "var(--accent)";
  show.style.marginLeft = "22px";
  let open = false;
  let block: HTMLElement | null = null;
  show.addEventListener("click", () => {
    open = !open;
    show.textContent = open ? "Hide the loop" : "Show the loop";
    if (open) {
      block = cycleBlock(cycle, getModel().resolve, {});
      wrap.appendChild(block);
    } else if (block !== null) {
      block.remove();
      block = null;
    }
  });
  wrap.appendChild(show);
  return wrap;
}

/**
 * The loop this path sits on, if any.
 *
 * Looked up by path rather than by node key: the dialog groups by Figma target and carries the set's
 * *display* label, not its id, and the block is identical for every member of a loop anyway — which
 * is §7.2's point, not a shortcut.
 */
function cycleFor(path: string): Cycle | undefined {
  const context = getModel().resolve;
  const needle = normalizePathKey(path);
  for (const cycle of context.cycles.cycles) {
    for (const node of cycle.nodes) {
      if (normalizePathKey(context.graph.nodes.get(node)?.path ?? "") === needle) return cycle;
    }
  }
  return undefined;
}
