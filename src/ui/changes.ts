// The Changes list — UX apply-and-drift §6.3, §6.5.
//
// Phase 4's local-edits popover, grown a second and third section. It is the one place the whole
// state of the world is legible, and it is the slot Phase 6's sync pill lands *on top of* rather
// than beside: same slot, same role, third occupant.
//
// The one asymmetry worth reading twice — §6.5:
//
//   - **Conflicts keep per-row actions only.** Across 1,316 tokens the right answer differs per
//     token, which is exactly why Phase 4 refused a global keep-mine/take-theirs.
//   - **Drift allows bulk.** Drift is usually *systemic* — someone re-toned a palette, a library
//     update rolled in — so the answer is the same for all 40 tokens, and forcing 40 taps is
//     contempt.
//
// with three guardrails on the bulk half: checkboxes unchecked by default, the filtered list is the
// scope, and a bulk re-apply routes through the apply dialog like every other canvas write.

import type { Line } from "./state";
import type { OverlayEntry } from "../tokens/overlay";
import {
  conflictedLines,
  dismissDrift,
  driftedLines,
  getModel,
  keysOf,
  lineForTarget,
  planFor,
  planRestoreDrift,
  resolveKeepMine,
  revert,
  revertAll,
} from "./state";
import { openApplyDialog } from "./applyDialog";
import { button, el, toast } from "./dom";
import { stableStringify } from "../tokens/serialize";

const panelEl = document.getElementById("panel") as HTMLElement;

type Section = "local" | "changed" | "conflicts";

let open = false;
let section: Section = "local";
let selected = new Set<string>();
let navigate: (path: string) => void = () => undefined;

export function setChangesNavigator(fn: (path: string) => void): void {
  navigate = fn;
}

export function isChangesOpen(): boolean {
  return open;
}

export function closeChanges(): void {
  if (!open) return;
  open = false;
  selected = new Set();
  panelEl.classList.add("hidden");
  panelEl.textContent = "";
}

export function openChanges(startAt?: Section): void {
  open = true;
  selected = new Set();
  const model = getModel();
  // Land on the section that has something in it, rather than on an empty "Local" tab that makes
  // the user hunt for the count they just tapped.
  section =
    startAt ??
    (conflictedLines().length > 0
      ? "conflicts"
      : model.overlay.entries.length > 0
        ? "local"
        : driftedLines().length > 0
          ? "changed"
          : "local");
  renderChanges();
}

export function renderChanges(): void {
  if (!open) return;
  const model = getModel();
  const drifted = driftedLines();
  const conflicts = conflictedLines();
  // Conflicted entries are shown in their own section, so the Local list is the rest.
  const local = model.overlay.entries.filter((entry) => entry.conflict === undefined);

  panelEl.textContent = "";
  panelEl.classList.remove("hidden");

  const head = el("div", "panel-head");
  const back = button("←");
  back.title = "Back to the tree";
  back.addEventListener("click", closeChanges);
  head.appendChild(back);
  head.appendChild(el("div", "title", "Changes"));
  panelEl.appendChild(head);

  const body = el("div", "panel-body");

  const tabs = el("div", "chips");
  tabs.style.marginBottom = "8px";
  addTab(tabs, "local", `Local ${local.length}`);
  addTab(tabs, "changed", `Changed ${drifted.length}`);
  addTab(tabs, "conflicts", `Conflicts ${conflicts.length}`);
  body.appendChild(tabs);

  if (section === "local") renderLocal(body, local);
  else if (section === "changed") renderChanged(body, drifted);
  else renderConflicts(body, conflicts);

  panelEl.appendChild(body);
}

function addTab(into: HTMLElement, id: Section, label: string): void {
  const tab = el("button", section === id ? "chip on" : "chip", label) as HTMLButtonElement;
  tab.addEventListener("click", () => {
    section = id;
    selected = new Set();
    renderChanges();
  });
  into.appendChild(tab);
}

// ---------------------------------------------------------------------------
// Local edits
// ---------------------------------------------------------------------------

function renderLocal(body: HTMLElement, entries: OverlayEntry[]): void {
  if (entries.length === 0) {
    body.appendChild(el("p", undefined, "No local edits."));
    body.appendChild(el("p", "empty", "Edits you make in the tree collect here until you apply them."));
    return;
  }

  const actions = el("div", "toolbar");
  const apply = button("Apply to Figma", "primary");
  apply.addEventListener("click", () => {
    // The header chip's scope *is* the overlay, so no already-matches section is possible here.
    openApplyDialog({
      plan: planFor(),
      title: "Apply to Figma",
      nothingToDo: "Nothing to apply — Figma already matches your edits.",
      onNothingToDo: toast,
    });
  });
  actions.appendChild(apply);

  const undoAll = button("Undo all");
  undoAll.addEventListener("click", () => {
    revertAll();
    toast("Reverted every local edit");
  });
  actions.appendChild(undoAll);
  body.appendChild(actions);

  for (const entry of entries) {
    const row = el("div", "row");
    const name = el("div", "name", entry.path);
    name.title = `${entry.op} · ${entry.set}`;
    name.style.cursor = "pointer";
    name.addEventListener("click", () => {
      closeChanges();
      navigate(entry.path);
    });
    row.appendChild(name);
    row.appendChild(el("span", "badge", entry.op === "delete" ? "deleted" : entry.set));
    if (entry.orphaned === true) row.appendChild(el("span", "badge needs", "orphaned"));

    const revertOne = button("Revert");
    revertOne.addEventListener("click", () => revert([entry.target], entry.op));
    row.appendChild(revertOne);
    body.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Changed in Figma — the bulk half
// ---------------------------------------------------------------------------

function renderChanged(body: HTMLElement, lines: Line[]): void {
  const model = getModel();

  if (!model.driftKnown) {
    // §8's corollary, said out loud rather than rendered as a clean list: a "nothing has changed"
    // that actually meant "we had no baseline" is the worst possible lie for this feature to tell.
    body.appendChild(el("p", undefined, "We don't know yet."));
    body.appendChild(
      el(
        "p",
        "empty",
        "There's no earlier scan to compare this file against, so nothing can be said about what changed. Rescan to set the baseline."
      )
    );
    return;
  }

  if (lines.length === 0) {
    body.appendChild(el("p", undefined, "Nothing has changed in Figma since your last scan."));
    return;
  }

  for (const line of lines) {
    const drift = line.drift as NonNullable<Line["drift"]>;
    const row = el("div", "row");

    // Unchecked by default. The user selects the scope; there is never an "accept all" that
    // operates on rows they haven't looked at.
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = selected.has(line.key as string);
    box.addEventListener("change", () => {
      if (box.checked) selected.add(line.key as string);
      else selected.delete(line.key as string);
      renderBulkBar();
    });
    row.appendChild(box);

    const grow = el("div", "name");
    grow.textContent = line.entry.path;
    grow.title = `${line.entry.path} · ${line.entry.setId}`;
    grow.style.cursor = "pointer";
    grow.addEventListener("click", () => {
      closeChanges();
      navigate(line.entry.path);
    });
    row.appendChild(grow);
    row.appendChild(el("span", "badge", line.set.code));
    row.appendChild(el("span", "badge needs", shortDrift(drift.kind)));
    body.appendChild(row);

    if (drift.kind === "drift-value") {
      const compare = el("div", "empty");
      compare.className = "mono empty";
      compare.textContent = `${describe(drift.baseline)} → ${describe(drift.current)}`;
      body.appendChild(compare);
    }
  }

  const bar = el("div", "toolbar");
  bar.id = "drift-bulk";
  body.appendChild(bar);
  renderBulkBar();
}

function renderBulkBar(): void {
  const bar = document.getElementById("drift-bulk");
  if (bar === null) return;
  bar.textContent = "";

  bar.appendChild(el("span", "empty", `${selected.size} selected`));

  const reapply = button("Re-apply tokens");
  reapply.disabled = selected.size === 0;
  reapply.addEventListener("click", () => {
    // A canvas write, so it routes through the dialog like every other one (§6.5, guardrail 3).
    openApplyDialog({
      plan: planRestoreDrift(Array.from(selected)),
      title: "Put Figma back",
      nothingToDo: "Nothing to put back.",
      onNothingToDo: toast,
    });
  });
  bar.appendChild(reapply);

  const take = button("Take Figma's");
  take.disabled = selected.size === 0;
  take.addEventListener("click", () => {
    const count = selected.size;
    dismissDrift(Array.from(selected));
    selected = new Set();
    // Honest about what just happened. For an unedited token the tree *already shows* Figma's
    // value — the tree is re-derived from Figma on every scan — so this accepts the change rather
    // than writing anything, and the toast should not imply otherwise.
    toast(`Accepted ${count} change${count === 1 ? "" : "s"} from Figma.`);
    renderChanges();
  });
  bar.appendChild(take);
}

function shortDrift(kind: string): string {
  if (kind === "drift-added") return "⚑ added";
  if (kind === "drift-removed") return "⚑ removed";
  return "⚑ changed";
}

// ---------------------------------------------------------------------------
// Conflicts — per-row only, deliberately
// ---------------------------------------------------------------------------

function renderConflicts(body: HTMLElement, lines: Line[]): void {
  if (lines.length === 0) {
    body.appendChild(el("p", undefined, "No conflicts."));
    body.appendChild(
      el("p", "empty", "A conflict is a token you and Figma both changed since your last scan.")
    );
    return;
  }

  body.appendChild(
    el(
      "p",
      "empty",
      "Both sides moved on these, so they're resolved one at a time — across a thousand tokens the right answer differs per token."
    )
  );

  for (const line of lines) {
    const conflict = line.conflict as NonNullable<Line["conflict"]>;
    const row = el("div", "row");
    const name = el("div", "name", line.entry.path);
    name.style.cursor = "pointer";
    name.addEventListener("click", () => {
      closeChanges();
      navigate(line.entry.path);
    });
    row.appendChild(name);
    row.appendChild(el("span", "badge", line.set.code));
    body.appendChild(row);

    const compare = el("div", "mono empty");
    compare.textContent = `yours ${describe(conflict.value)} · Figma ${describe(conflict.conflict?.figma)}`;
    body.appendChild(compare);

    const actions = el("div", "toolbar");

    const mine = button("Keep mine");
    mine.addEventListener("click", () => {
      if (line.target !== null) resolveKeepMine(line.target, conflict.op);
      toast("Kept your value.");
      renderChanges();
    });
    actions.appendChild(mine);

    // Phase 5's one addition to Phase 4's pair (§6.6): "mine is right, make Figma agree" is the
    // obvious next thought, and Phase 4 had no way to finish it.
    const mineAndApply = button("Keep mine and apply", "primary");
    mineAndApply.addEventListener("click", () => {
      if (line.target === null) return;
      resolveKeepMine(line.target, conflict.op);
      // Re-read the line: resolving rebased the entry, so the plan must be built from the model
      // *after* the resolution or it would still see the conflict and refuse itself (§10).
      const refreshed = lineForTarget(line.target);
      openApplyDialog({
        plan: planFor({ keys: keysOf(refreshed === undefined ? [] : [refreshed]) }),
        title: `Apply ${line.entry.path}`,
        nothingToDo: "Figma already matches your value.",
        onNothingToDo: toast,
      });
    });
    actions.appendChild(mineAndApply);

    const theirs = button("Take Figma's");
    theirs.addEventListener("click", () => {
      if (line.target !== null) revert([line.target], conflict.op);
      toast("Took Figma's value.");
      renderChanges();
    });
    actions.appendChild(theirs);

    body.appendChild(actions);
  }
}

function describe(value: unknown): string {
  if (value === undefined) return "—";
  if (value === "") return "empty";
  if (typeof value === "object" && value !== null) {
    const json = stableStringify(value as never).trim().replace(/\s+/g, " ");
    return json.length > 34 ? `${json.slice(0, 33)}…` : json;
  }
  return String(value);
}
