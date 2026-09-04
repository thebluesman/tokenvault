// "Delete in Figma…" — UX apply-and-drift §5.7, ADR-0005 §5.
//
// The first and only Tokenvault operation that can destroy something a person made, and the
// contrast with the apply dialog is the point. Apply is a modal you dismiss with a stray tap on the
// backdrop, because apply is frequent and recoverable. **Delete replaces the screen, has no
// backdrop to tap away, and makes you read a blast radius, because it is neither.**
//
// Three guards, from ADR-0005 §5:
//
//   1. Refused outright while other tokens reference the target. Phase 4 already blocks the *local*
//      delete for that reason, and Phase 5 does not get to be more permissive about a strictly more
//      destructive version of the same action.
//   2. Never bundled into an apply. Separate menu item, separate message, separate screen, separate
//      button colour — see the note in `plan.ts` about why UX §5.2's pre-checked rows make a
//      delete row unsafe by construction.
//   3. Destructive treatment, which is this file.
//
// The counts are not decoration: UX §10 says *don't open the screen with placeholder counts — the
// counts are the screen*. So the panel opens in a counting state and fills in when the plugin
// answers, rather than rendering a number it does not have yet.

import type { ConsumerCount } from "../figma/apply";
import type { DeletePlan } from "../tokens/plan";
import type { Line } from "./state";
import { buildDeletePlan } from "../tokens/plan";
import { getModel, send } from "./state";
import { button, el } from "./dom";
import { describeValue } from "../tokens/format";

const panelEl = document.getElementById("panel") as HTMLElement;

interface Pending {
  plan: DeletePlan;
  counts: Map<string, ConsumerCount>;
  counting: boolean;
  alsoRemoveTokens: boolean;
  navigate: (path: string) => void;
  onClose: () => void;
  /** Between the confirming tap and the plugin's report — UX apply-and-drift §7, Phase 9. */
  submitting: boolean;
  /** Figma's refusal, when the delete came back failed. The screen stays open to show it. */
  failure: string | null;
}

let pending: Pending | null = null;

export function isDeletePanelOpen(): boolean {
  return pending !== null;
}

/**
 * The plugin's answer to a `delete-in-figma` — UX apply-and-drift §7.
 *
 * Success closes the screen, which is what the confirming tap was always going to do. A failure
 * keeps it open and puts Figma's own refusal in an `.entry` on it, because the user is standing in
 * front of a destructive action that did not happen and needs to know that before anything else.
 * Returns whether the confirmation consumed the report, so `main.ts` can leave its toast alone.
 */
export function reportDeleteResult(failed: number, reason: string): boolean {
  if (pending === null || !pending.submitting) return false;
  pending.submitting = false;
  if (failed === 0) {
    closeDeletePanel();
    return true;
  }
  pending.failure = reason;
  render();
  return true;
}

/** The plugin's answer to `count-consumers`, which is what the screen was waiting for. */
export function setConsumerCounts(counts: ConsumerCount[]): void {
  if (pending === null) return;
  pending.counting = false;
  for (const count of counts) pending.counts.set(count.key, count);
  render();
}

export function closeDeletePanel(): void {
  const onClose = pending?.onClose;
  pending = null;
  panelEl.classList.add("hidden");
  panelEl.textContent = "";
  if (onClose !== undefined) onClose();
}

/**
 * Opens the confirmation for a set of value lines.
 *
 * Offered on a value line, a path (all its Variables) and a group row; the confirmation aggregates,
 * with referrer counts taken from **outside** the group — the same "references within the group
 * don't block" rule as Phase 4's local delete.
 */
export function openDeleteInFigma(
  lines: Line[],
  options: { navigate: (path: string) => void; onClose: () => void }
): void {
  const model = getModel();
  const plan = buildDeletePlan(
    lines.map((line) => ({ path: line.entry.path, setId: line.entry.setId, token: line.entry.token })),
    model.inbound
  );

  pending = {
    plan,
    counts: new Map(),
    // Only worth asking for when something could actually be deleted. A blocked confirmation has
    // no primary button, so a layer count on it would be a number with nothing to decide.
    counting: plan.ready > 0,
    alsoRemoveTokens: true,
    navigate: options.navigate,
    onClose: options.onClose,
    submitting: false,
    failure: null,
  };

  if (plan.ready > 0) {
    send({
      type: "count-consumers",
      targets: plan.entries
        .filter((entry) => entry.status === "ready")
        .map((entry) => ({
          key: entry.key,
          variableId: entry.target.variableId,
          styleId: entry.target.styleId,
        })),
    });
  }

  render();
}

// ---------------------------------------------------------------------------

function noun(plan: DeletePlan): string {
  const styles = plan.entries.filter((entry) => entry.target.styleId !== undefined).length;
  if (styles === plan.entries.length) return plan.entries.length === 1 ? "Style" : "Styles";
  if (styles === 0) return plan.entries.length === 1 ? "Variable" : "Variables";
  return "items";
}

function render(): void {
  if (pending === null) return;
  const { plan } = pending;

  panelEl.textContent = "";
  panelEl.classList.remove("hidden");

  const head = el("div", "panel-head");
  const back = button("←");
  back.title = "Back";
  back.addEventListener("click", closeDeletePanel);
  head.appendChild(back);
  head.appendChild(el("div", "title", "Delete in Figma"));
  panelEl.appendChild(head);

  const body = el("div", "panel-body");
  const blocked = plan.ready === 0;

  // The failure sits at the top of the screen it belongs to, above the rows it did not delete
  // (UX apply-and-drift §7). Figma's own words, for the same reason the scan notice keeps them.
  if (pending.failure !== null) {
    const box = el("div", "entry");
    box.appendChild(el("span", "kind", "couldn't delete"));
    box.appendChild(
      el(
        "div",
        undefined,
        `Couldn't delete — ${plan.ready === 1 ? `the ${noun(plan)} is` : "they are"} still in the file. ${pending.failure}`
      )
    );
    body.appendChild(box);
  }

  body.appendChild(
    el(
      "h3",
      undefined,
      blocked
        ? `Can't delete ${plan.entries.length === 1 ? "this" : `these ${plan.entries.length}`} yet.`
        : `Delete ${plan.ready === 1 ? `this ${noun(plan)}` : `${plan.ready} ${noun(plan)}`} from the file?`
    )
  );

  for (const entry of plan.entries.slice(0, 12)) {
    const row = el("div", "row");
    const name = el("div", "name", entry.path);
    name.title = entry.path;
    row.appendChild(name);
    row.appendChild(el("span", "badge", entry.set));
    if (entry.status === "blocked") row.appendChild(el("span", "badge needs", "blocked"));
    body.appendChild(row);
  }
  if (plan.entries.length > 12) {
    body.appendChild(el("p", "empty", `… and ${plan.entries.length - 12} more`));
  }

  if (blocked) {
    renderBlocked(body);
  } else {
    renderBlastRadius(body);
  }

  panelEl.appendChild(body);
}

/**
 * The blocked form: the referrer list in full, no primary button, `[ Close ]` alone.
 *
 * Never truncated, and never accompanied by a "delete anyway". Removing an alias target cascades
 * into every referrer, which is the same blast-radius argument ADR-0002 Amendment 1 §F used to pick
 * collision winners — and Phase 5 still cannot rewrite a reference to repoint it.
 */
function renderBlocked(body: HTMLElement): void {
  const { plan, navigate } = pending as Pending;
  const model = getModel();
  const codes = new Map(model.sets.map((info) => [info.id, info.code] as const));

  const box = el("div", "entry");
  box.appendChild(el("span", "kind", `${plan.referrers.length} token${plan.referrers.length === 1 ? "" : "s"} point at this`));
  box.appendChild(
    el(
      "div",
      undefined,
      plan.referrers.length > 0
        ? "Delete or re-point them first. Removing this would leave every one of them pointing at nothing."
        : (plan.entries[0]?.message ?? "This can't be deleted from Figma.")
    )
  );
  body.appendChild(box);

  for (const referrer of plan.referrers) {
    const row = el("div", "row");
    const name = el("div", "name", referrer.path);
    name.style.cursor = "pointer";
    name.addEventListener("click", () => {
      closeDeletePanel();
      navigate(referrer.path);
    });
    row.appendChild(name);
    row.appendChild(el("span", "badge", codes.get(referrer.setId) ?? referrer.setId));
    body.appendChild(row);
  }

  const close = button("Close");
  close.addEventListener("click", closeDeletePanel);
  const actions = el("div", "toolbar");
  actions.appendChild(close);
  body.appendChild(actions);
}

function renderBlastRadius(body: HTMLElement): void {
  const state = pending as Pending;
  const { plan } = state;

  // The blast radius comes **before** the button, never after: two counts, both of them things the
  // user cannot see from the token tree.
  const layers = el("div", "entry");
  if (state.counting) {
    layers.appendChild(el("span", "kind", "Counting layers…"));
    layers.appendChild(el("div", undefined, "Checking how many layers are bound to this."));
  } else {
    let total = 0;
    const nodeIds: string[] = [];
    for (const count of state.counts.values()) {
      total += count.layers;
      for (const id of count.nodeIds) nodeIds.push(id);
    }
    layers.appendChild(el("span", "kind", `Used by ${total} layer${total === 1 ? "" : "s"}`));
    layers.appendChild(
      el(
        "div",
        undefined,
        total === 0
          ? "No layers are bound to it."
          : // A warning, not a block: layers keeping their value and losing their binding is a real
            // consequence, but it is the user's call and it is exactly what deleting means.
            "Those layers keep their current value but stop following it."
      )
    );
    if (nodeIds.length > 0) {
      const show = button("Show them");
      show.addEventListener("click", () => send({ type: "select-nodes", nodeIds }));
      const actions = el("div", "toolbar");
      actions.appendChild(show);
      layers.appendChild(actions);
    }
  }
  body.appendChild(layers);

  // Stated before the button, and at greater length than anywhere else in the product: this is the
  // one write whose damage a second apply cannot repair.
  body.appendChild(
    el(
      "p",
      undefined,
      "This can't be undone from the plugin. Figma's own undo (⌘Z) is the only way back, and it has to be the very next thing you do."
    )
  );

  const also = el("label");
  also.style.display = "flex";
  also.style.alignItems = "center";
  also.style.gap = "6px";
  const box = el("input") as HTMLInputElement;
  box.type = "checkbox";
  box.checked = state.alsoRemoveTokens;
  box.addEventListener("change", () => {
    state.alsoRemoveTokens = box.checked;
  });
  also.appendChild(box);
  also.appendChild(el("span", undefined, "Also remove the token from the local tree"));
  also.title =
    "Leaving this on is what stops a Figma deletion from leaving an orphaned local edit behind.";
  body.appendChild(also);

  const actions = el("div", "toolbar");
  actions.style.marginTop = "10px";
  // `[ Cancel ]` stays a plain text button — no competing fill, so the destructive button is the
  // only thing with weight on this screen and can't be hit by muscle memory aiming at a primary.
  const cancel = button("Cancel");
  cancel.addEventListener("click", closeDeletePanel);
  actions.appendChild(cancel);

  // Named for the object, not the verb alone, so the button says what's about to be gone even if
  // the user reads nothing else.
  const confirm = button(
    state.submitting
      ? "Deleting…"
      : plan.ready === 1
        ? `Delete ${noun(plan)}`
        : `Delete ${plan.ready} ${noun(plan)}`,
    "danger"
  );
  // Disabled while the write is in flight: a second tap would issue a second delete of things the
  // first one may already have removed, and this is the one screen where that is not recoverable.
  confirm.disabled = state.counting || state.submitting;
  confirm.addEventListener("click", () => {
    const writes = plan.entries
      .filter((entry) => entry.status === "ready" && entry.write !== undefined)
      .map((entry) => ({
        key: entry.key,
        targetKey: entry.key,
        write: entry.write as NonNullable<typeof entry.write>,
      }));
    const clearOverlayFor = state.alsoRemoveTokens
      ? plan.entries.filter((entry) => entry.status === "ready").map((entry) => entry.target)
      : [];
    // **The screen stays open until the plugin answers** — UX apply-and-drift §7: *"Delete in Figma
    // failed → `.entry` block on the confirmation, which stays open"*. It used to close here and
    // report a failure in a toast, which is the treatment for a success whose result isn't on
    // screen; for a failed destructive action it is the wrong level, and it also threw away the
    // blast radius the user would immediately want to look at again.
    state.submitting = true;
    state.failure = null;
    render();
    // Its own message, never an op in the apply batch (UX §10).
    send({ type: "delete-in-figma", writes, clearOverlayFor });
  });
  actions.appendChild(confirm);
  body.appendChild(actions);

  const values = plan.entries
    .filter((entry) => entry.status === "ready")
    .map((entry) => describe(entry.value));
  if (values.length > 0) {
    // The value goes on screen before it goes away — the same courtesy the orphaned-edit panel
    // extends, for the same reason: retyping from memory is not a recovery path.
    body.appendChild(el("p", "empty", `Current value${values.length === 1 ? "" : "s"}: ${values.slice(0, 6).join(", ")}`));
  }
}

/** Untruncated: this is the last time the value is on screen before it stops existing. */
function describe(value: unknown): string {
  return describeValue(value);
}
