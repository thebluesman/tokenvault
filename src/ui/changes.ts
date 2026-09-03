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
import { entryRefs, localEntries } from "../tokens/overlay";
import {
  conflictedLines,
  dismissDrift,
  driftBaseline,
  driftedLines,
  getModel,
  keysOf,
  lineForTarget,
  planFor,
  planRestoreDrift,
  resolveKeepMine,
  resolveTakeRepo,
  revert,
  revertEntries,
} from "./state";
import { openApplyDialog } from "./applyDialog";
import { button, el, toast } from "./dom";
import { describeValue } from "../tokens/format";
import { branchName, isConnected } from "./git";
import { originOf } from "../tokens/overlay";

const panelEl = document.getElementById("panel") as HTMLElement;

type Section = "local" | "changed" | "conflicts";

let open = false;
let section: Section = "local";
let selected = new Set<string>();
let navigate: (path: string) => void = () => undefined;

/** Which bulk action is awaiting §10.4's inline confirmation, or `null` when none is. */
let confirming: "figma" | "repo" | null = null;

// `Esc` cancels the confirm strip, matching every other dismissable thing in the panel. A tap on
// the list cancels too — see the body's mousedown handler in `renderChanges`.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && confirming !== null) cancelConfirm();
});

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
  // The confirm strip is about a selection; clearing one without the other leaves a strip offering
  // to act on nothing, with its button live, the next time the list opens.
  confirming = null;
  panelEl.classList.add("hidden");
  panelEl.textContent = "";
}

export function openChanges(startAt?: Section): void {
  open = true;
  selected = new Set();
  confirming = null;
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
  // Conflicted entries are shown in their own section, so the Local list is the rest. The same
  // function decides *Undo all*'s scope below — see `localEntries`.
  const local = localEntries(model.overlay);

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
  // A tap on the list cancels the confirm strip (§10.4) — nothing here is destructive, so backing
  // out must be at least as easy as going through.
  body.addEventListener("mousedown", (event) => {
    if (confirming === null) return;
    const bar = document.getElementById("drift-bulk");
    if (bar !== null && bar.contains(event.target as Node)) return;
    cancelConfirm();
  });

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
    confirming = null;
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
  // Scoped to `entries` — the rows this tab is actually showing. Conflicts are filtered out above
  // and are resolved one at a time in their own tab, so a global wipe would discard decisions the
  // user was never offered here.
  undoAll.title = "Undoes the local edits listed below. Conflicts are resolved separately.";
  undoAll.addEventListener("click", () => {
    const count = entries.length;
    revertEntries(entryRefs(entries));
    toast(`Reverted ${count} local edit${count === 1 ? "" : "s"}`);
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
    // *"A small grey `from repo` tag on its row. That is the whole visual difference, and it is
    // grey rather than a badge, because a pulled change **needs nothing from you** beyond the
    // apply you were going to do anyway."* (UX git-sync §8.2.)
    if (originOf(entry) === "pulled") row.appendChild(el("span", "empty", "from repo"));

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

/**
 * The footer under the drift list — and, since Phase 6, §10.4's inline confirm strip.
 *
 * The two bulk actions are named for whichever baseline drift is actually comparing against
 * (UX §10.2, ADR-0006 §7): connected, the left button writes **the repo's** value into Figma and is
 * called that; disconnected, the only thing left to push is the value from before the change, so it
 * stays Phase 5's *Put Figma back*. Both are live code paths — a file can be disconnected at any
 * time — and the labels follow the connection, never a feature flag (UX §14).
 */
/** Whether drift on this file is a comparison against the repo — the wording's one condition. */
function repoDrift(): boolean {
  return driftBaseline() === "repo" && isConnected();
}

function renderBulkBar(): void {
  const bar = document.getElementById("drift-bulk");
  if (bar === null) return;
  bar.textContent = "";
  // The same test the single-token detail block uses (detail.ts): *connected* here has to mean
  // "drift is actually being compared against the repo", not merely "settings exist". A file
  // connected by publishing Figma's tree never fetches a repo baseline, so drift is still measured
  // against the last scan — and the bulk bar promising the repo's value would disagree with the
  // very row it sits under.
  const connected = repoDrift();

  // §10.4, the phase's one new component. **It replaces the bulk button in the footer, in place:**
  // nothing dims, nothing overlays, the rows the user is being asked about stay visible and
  // scrollable behind it. A bulk action deserves a beat, not an interruption.
  if (confirming !== null) {
    const count = selected.size;
    const strip = el("div", "confirm-strip");
    strip.appendChild(
      el(
        "div",
        undefined,
        confirming === "figma"
          ? `Accept Figma's values for ${count} token${count === 1 ? "" : "s"}?`
          : `Take the repo's values for ${count} token${count === 1 ? "" : "s"}?`
      )
    );
    // The second line names the consequence in the user's units and names the branch. That
    // sentence is the entire reason the confirm exists; without it this is friction.
    strip.appendChild(
      el(
        "div",
        "empty",
        confirming === "figma"
          ? `They become ${count} change${count === 1 ? "" : "s"} to push to ${branchName()}.`
          : "They'll be pending changes to apply in Figma."
      )
    );

    const actions = el("div", "actions");
    // Cancel is the wider, quieter of the two, and `Esc` and tapping the list both cancel —
    // nothing here is destructive, so backing out must be at least as easy as going through.
    const cancel = button("Cancel");
    cancel.addEventListener("click", cancelConfirm);
    actions.appendChild(cancel);
    actions.appendChild(el("span", "grow"));
    // `[ Accept 40 ]`, not `[ Confirm ]`: the button restates the scale, so a stray tap on a
    // confirm still tells you what it did.
    const go = button(confirming === "figma" ? `Accept ${count}` : `Take ${count}`, "primary");
    go.addEventListener("click", () => {
      const kind = confirming;
      confirming = null;
      if (kind === "figma") acceptFigma();
      else takeRepo();
    });
    actions.appendChild(go);
    strip.appendChild(actions);
    bar.appendChild(strip);
    return;
  }

  bar.appendChild(el("span", "empty", `${selected.size} selected`));

  const reapply = button(connected ? "Take the repo's" : "Put Figma back");
  reapply.disabled = selected.size === 0;
  reapply.addEventListener("click", () => {
    // Its counterpart confirms too — one vocabulary for picking a side, one for confirming the
    // pick (§10.4). Single-token accepts never confirm; nothing confirms while disconnected.
    if (connected && selected.size > 1) {
      confirming = "repo";
      renderBulkBar();
      return;
    }
    takeRepo();
  });
  bar.appendChild(reapply);

  const take = button("Take Figma's");
  take.disabled = selected.size === 0;
  take.addEventListener("click", () => {
    // The rule is: confirm when the action stages more than one change into work that is headed
    // for a shared repo. Disconnected, accepting still writes nothing, and Phase 5's dissolved
    // premise is intact.
    if (connected && selected.size > 1) {
      confirming = "figma";
      renderBulkBar();
      return;
    }
    acceptFigma();
  });
  bar.appendChild(take);
}

/**
 * *Take Figma's* — accepts the drift.
 *
 * **Disconnected it writes nothing** and the toast says so, exactly as Phase 5 did: the tree is
 * re-derived from Figma on every scan, so an unedited drifted token already shows Figma's value.
 * **Connected, that same acceptance is an uncommitted change**: the file the panel would push
 * already carries Figma's value, so the repo now disagrees with it and the file reads as *to push*.
 * Two different facts, two different sentences (UX §10.2, §14).
 */
function acceptFigma(): void {
  const count = selected.size;
  dismissDrift(Array.from(selected));
  selected = new Set();
  if (repoDrift()) {
    toast(`Accepted ${count} change${count === 1 ? "" : "s"} from Figma — ${count} change${count === 1 ? "" : "s"} to push.`);
  } else {
    toast(`Accepted ${count} change${count === 1 ? "" : "s"} from Figma.`);
  }
  renderChanges();
}

/** *Take the repo's* / *Put Figma back* — a canvas write, so it routes through the dialog (§6.5). */
function takeRepo(): void {
  openApplyDialog({
    plan: planRestoreDrift(Array.from(selected)),
    title: repoDrift() ? "Take the repo's" : "Put Figma back",
    nothingToDo: "Nothing to put back.",
    onNothingToDo: toast,
  });
}

function cancelConfirm(): void {
  if (confirming === null) return;
  confirming = null;
  renderBulkBar();
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

    // ADR-0006 §5's `origin` field doing UX work: *"so a conflict message can name the repo rather
    // than the user"* (UX §8.2). Guessing wrong here is the difference between blaming a colleague
    // and blaming a bot.
    const fromRepo = conflict.conflict?.origin === "repo";
    const compare = el("div", "mono empty");
    compare.textContent = fromRepo
      ? `Yours ${describe(conflict.value)} · From the repo ${describe(conflict.conflict?.figma)}`
      : `yours ${describe(conflict.value)} · Figma ${describe(conflict.conflict?.figma)}`;
    body.appendChild(compare);
    if (fromRepo) {
      body.appendChild(
        el("div", "empty", "You edited this token; the repo changed it too. Pick one.")
      );
    }

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

    const theirs = button(fromRepo ? "Take the repo's" : "Take Figma's");
    theirs.addEventListener("click", () => {
      if (fromRepo) {
        // The repo's value is not in Figma, so taking it *records* it as a pending change rather
        // than dropping the entry and falling back to something neither side asked for.
        if (resolveTakeRepo(line)) toast("Took the repo's value — apply it to update Figma.");
      } else if (line.target !== null) {
        revert([line.target], conflict.op);
        toast("Took Figma's value.");
      }
      renderChanges();
    });
    actions.appendChild(theirs);

    body.appendChild(actions);
  }
}

/** 34 characters, because this line carries *two* values either side of a `→` or a `·`. */
function describe(value: unknown): string {
  return describeValue(value, { limit: 34 });
}
