// The Repo tab and its three screens — UX git-sync §6.2, §7.2, §9.2.
//
// **A new third top-level tab, beside Import and Tokens** (§4.1). Not a fourth section tab on
// Phase 5's Changes list, and not a modal. The Changes list answers *what have I got outstanding
// against Figma*, at token granularity; this answers *what does the repo think*, at file
// granularity. Two questions, two units, two surfaces (§3, §6.3).
//
// Three screens live inside it, each pushed with a back arrow that preserves state:
//
//   home       →  §6.2   To push / To pull / Diverged, files at the top level
//   review     →  §7.2   Review & push — file rows, nested token rows, message, one write button
//   diverged   →  §9.2   The per-file pick-a-side queue
//   compare    →  §9.2   A read-only token-level diff for one file
//
// The rule that shapes all four: **files in sync are not listed at all, and there is no green
// tick** (§12). In a list, in-sync is the absence of a mark.

import type { TokenGroup } from "../tokens/types";
import type { FileStatus } from "../git/types";
import { diffTrees, describeManifestChange, type FileDiff } from "../git/filediff";
import { button, el, toast } from "./dom";
import { diffRow } from "./diffRow";
import { entryRefs } from "../tokens/overlay";
import {
  branchName,
  checkStatus,
  entriesForFile,
  getGit,
  isManifestPath,
  keepMineForFile,
  localParsedTrees,
  messageFor,
  pull,
  push,
  repoTreeFor,
  setsForFile,
  tokenCounts,
} from "./git";
import { clearLastPull } from "./git";
import { importedManifest, revertEntries } from "./state";
import { failureText } from "./settings";

const repoEl = document.getElementById("repo") as HTMLElement;

type Screen = "home" | "review" | "diverged" | "compare";

let screen: Screen = "home";
let openTab = false;

/**
 * The Review & push screen's state, preserved across a back arrow, a failed push and a tab switch.
 *
 * *"Going back from Review & push preserves checkbox state and the typed message. So does a failed
 * push. The screen is only torn down on a successful commit"* (UX §14) — a user who taps Tokens to
 * check a value mid-review has not cancelled anything.
 */
interface ReviewState {
  unchecked: Set<string>;
  summary: string | null;
  body: string | null;
  /** True once the user has typed in the body — after that it stops regenerating (UX §7.3). */
  bodyTouched: boolean;
  expanded: Set<string>;
  full: Set<string>;
  /** The repo's version of each file being reviewed. Fetched when the screen opens (§4). */
  repoTrees: Map<string, TokenGroup> | null;
  loading: boolean;
}

let review: ReviewState = blankReview();

function blankReview(): ReviewState {
  return {
    unchecked: new Set(),
    summary: null,
    body: null,
    bodyTouched: false,
    expanded: new Set(),
    full: new Set(),
    repoTrees: null,
    loading: false,
  };
}

/** The Diverged files queue — `1/2` in the header, advancing on each choice (§9.2). */
let divergedAt = 0;
let compareFor: string | null = null;
let comparingTree: TokenGroup | null = null;

export function showRepoTab(show: boolean): void {
  openTab = show;
  repoEl.classList.toggle("hidden", !show);
  if (!show) return;
  // *"A status check runs on panel open, on Repo tab open, and after every push and pull"* — and
  // never on a timer (UX §14, ADR-0006 §5).
  void checkStatus();
  renderRepo();
}

export function goRepoHome(): void {
  screen = "home";
  renderRepo();
}

/** The tab label's count and flag — `Repo 3`, `⚑ Repo`, or bare `Repo` (§6.2). No green tick. */
export function repoTabLabel(): string {
  const git = getGit();
  if (git.status === null) return "Repo";
  if (git.status.diverged.length > 0) return "⚑ Repo";
  const count = git.status.toPush.length + git.status.toPull.length;
  return count === 0 ? "Repo" : `Repo ${count}`;
}

// ---------------------------------------------------------------------------

export function renderRepo(): void {
  if (!openTab) return;
  repoEl.textContent = "";

  if (screen === "review") renderReview();
  else if (screen === "diverged") renderDiverged();
  else if (screen === "compare") renderCompare();
  else renderHome();
}

function head(title: string, back: (() => void) | null, sub?: string): HTMLElement {
  const bar = el("div", "panel-head");
  if (back !== null) {
    const arrow = button("←");
    arrow.title = "Back";
    arrow.addEventListener("click", back);
    bar.appendChild(arrow);
  }
  const wrap = el("div", "title");
  wrap.textContent = title;
  bar.appendChild(wrap);
  if (sub !== undefined) bar.appendChild(el("span", "note", sub));
  return bar;
}

// ---------------------------------------------------------------------------
// The home screen — §6.2
// ---------------------------------------------------------------------------

function renderHome(): void {
  const git = getGit();
  repoEl.appendChild(head("Repo", null));

  const body = el("div", "panel-body");

  if (git.settings === null) {
    body.appendChild(el("p", undefined, "This file isn't connected to a repo."));
    body.appendChild(
      el("p", "empty", "Point it at a GitHub repo to push and pull your tokens.")
    );
    const open = button("Open settings", "primary");
    open.addEventListener("click", () => openSettingsFromRepo());
    body.appendChild(open);
    repoEl.appendChild(body);
    return;
  }

  // *"The repo and branch are named at the top of the tab, every time."* A user with two Figma
  // files and two repos should never have to remember which one this panel is talking to.
  body.appendChild(
    el("div", "mono", `${git.settings.owner}/${git.settings.repo} · ${git.settings.branch}`)
  );

  const fresh = el("div", "toolbar");
  fresh.appendChild(el("span", "empty", freshness()));
  const again = button("Check again");
  again.disabled = git.checking;
  again.addEventListener("click", () => void checkStatus());
  fresh.appendChild(again);
  body.appendChild(fresh);

  if (git.rateLimit !== null && git.rateLimit.remaining < 500) {
    // Surfaced rather than discovered as an unexplained 403 later (ADR-0006 §10).
    body.appendChild(el("div", "empty", `${git.rateLimit.remaining} GitHub requests left this hour.`));
  }
  if (git.truncated) {
    body.appendChild(
      el("div", "entry", "This repo is too large for GitHub to list in one call, so some files may be missing from the comparison.")
    );
  }

  if (git.failure !== null) {
    const entry = el("div", "entry");
    entry.appendChild(el("div", "kind", git.failure.kind));
    entry.appendChild(
      el("div", undefined, failureText(git.failure.kind, git.failure.message, git.failure.rateLimitReset))
    );
    if (git.failure.kind === "unauthorized" || git.failure.kind === "not-found") {
      const open = button("Open settings");
      open.addEventListener("click", () => openSettingsFromRepo());
      entry.appendChild(open);
    }
    body.appendChild(entry);
  }

  for (const path of git.unreadable) {
    body.appendChild(
      el("div", "entry", `Can't read ${path} — it isn't valid token JSON. Other files pulled normally.`)
    );
  }

  renderPullReport(body);

  const status = git.status;
  if (status === null) {
    body.appendChild(el("p", "empty", git.checking ? "Checking…" : "Status not checked yet."));
    repoEl.appendChild(body);
    return;
  }

  if (status.clean) {
    const line = el("div", "ok-line");
    line.appendChild(el("span", "dot", "●"));
    line.appendChild(el("span", undefined, `Everything's pushed. ${git.settings.branch} matches your tokens.`));
    body.appendChild(line);
  }

  // `↑`/`↓` never appear here — every list spells it out in words (§6.1, §12).
  section(body, "To push", status.toPush, false);
  section(body, "To pull", status.toPull, false);
  section(body, "⚑ Diverged", status.diverged, true);

  repoEl.appendChild(body);

  const foot = el("div", "panel-foot");
  const pullable = status.toPull.length;
  // No ellipsis and no review screen: one action with a fully described outcome, and it writes
  // nothing to Figma or the repo (§6.2, §8).
  const pullBtn = button(pullable === 0 ? "Pull" : `Pull ${pullable} file${pullable === 1 ? "" : "s"}`);
  pullBtn.disabled = pullable === 0 || git.busy !== null;
  pullBtn.addEventListener("click", () => void runPull(status.toPull.map((file) => file.path)));
  foot.appendChild(pullBtn);
  foot.appendChild(el("span", "grow"));

  // `[ Review… ]`, not `[ Push… ]`: it goes forward to a screen, and the screen's own footer is
  // what pushes. Naming it `Push…` would promise a write from a button that only navigates (§6.2).
  const reviewBtn = button("Review…", "primary");
  reviewBtn.disabled = status.toPush.length === 0 || git.busy !== null;
  reviewBtn.addEventListener("click", () => openReview());
  foot.appendChild(reviewBtn);
  repoEl.appendChild(foot);

  // Both buttons disable with a reason, never silently (§6.2).
  if (pullable === 0 || status.toPush.length === 0) {
    const why = el("div", "panel-foot");
    const parts: string[] = [];
    if (pullable === 0) parts.push("Nothing to pull");
    if (status.toPush.length === 0) parts.push("Nothing to push");
    why.appendChild(el("span", "note", parts.join(" · ")));
    repoEl.appendChild(why);
  }
}

function section(into: HTMLElement, title: string, files: FileStatus[], diverged: boolean): void {
  if (files.length === 0) return;
  const wrap = el("div", "repo-section");
  wrap.appendChild(
    el("h3", undefined, `${title} · ${files.length} file${files.length === 1 ? "" : "s"}`)
  );

  for (const file of files) {
    const row = el("div", "file-row");
    row.appendChild(el("div", "fname", file.path));
    const sets = setsForFile(file.path);
    if (sets.length > 0) row.appendChild(el("span", "badge", sets[0]));
    else if (isManifestPath(file.path)) row.appendChild(el("span", "badge", "manifest"));
    wrap.appendChild(row);

    if (diverged) {
      // A diverged file cannot be expanded into token rows inline: rendering its tokens in the same
      // list as pushable ones would put three different meanings on one arrow (§6.2).
      wrap.appendChild(el("div", "empty", "Changed in the repo and here."));
      const sort = button("Sort this out");
      sort.addEventListener("click", () => openDiverged(file.path));
      wrap.appendChild(sort);
    }
  }
  into.appendChild(wrap);
}

function freshness(): string {
  const git = getGit();
  if (git.busy !== null) return git.busy;
  if (git.checking) return "Checking…";
  if (git.checkedAt === null) return "Not checked yet";
  const seconds = Math.round((Date.now() - git.checkedAt) / 1000);
  if (seconds < 45) return "Checked just now";
  const minutes = Math.round(seconds / 60);
  return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

/**
 * §8.4 — repo tokens with no Figma counterpart.
 *
 * *"Listed, named, and given a workaround… No action button, because there is no action. A greyed
 * `[ Create ]` would promise a feature that isn't built."* It appears once per pull, in the pull
 * result, and never becomes a persistent badge — hence the dismiss rather than a counter.
 */
function renderPullReport(into: HTMLElement): void {
  const last = getGit().lastPull;
  if (last === null || last.unmatched.length === 0) return;

  const box = el("div", "entry");
  box.appendChild(
    el(
      "div",
      undefined,
      `${last.unmatched.length} token${last.unmatched.length === 1 ? " is" : "s are"} in the repo but not in this file`
    )
  );
  for (const token of last.unmatched.slice(0, 4)) {
    const row = el("div", "mono empty");
    row.textContent = `${token.path}    ${token.set}`;
    box.appendChild(row);
  }
  if (last.unmatched.length > 4) {
    box.appendChild(el("div", "empty", `… ${last.unmatched.length - 4} more`));
  }
  box.appendChild(
    el(
      "div",
      "empty",
      "Tokenvault can update Variables and Styles but can't create them yet. Add these in Figma and scan again, and they'll sync from then on."
    )
  );
  const dismiss = button("Dismiss");
  dismiss.addEventListener("click", () => {
    clearLastPull();
    renderRepo();
  });
  box.appendChild(dismiss);
  into.appendChild(box);
}

// ---------------------------------------------------------------------------
// Pull — §8.1
// ---------------------------------------------------------------------------

let onReviewPulled: () => void = () => undefined;

export function setPullReviewHandler(fn: () => void): void {
  onReviewPulled = fn;
}

async function runPull(paths: string[]): Promise<void> {
  renderRepo();
  const outcome = await pull(paths);
  renderRepo();
  if (outcome === null) return;

  const count = outcome.result.entries.length;
  if (count === 0) {
    toast(`${branchName()} has nothing new.`);
    return;
  }
  // The sentence that has to land in one breath (§8.1): *pull* in every other tool means the thing
  // arrives, and here it does not — it becomes pending work that an apply still has to move.
  toast(
    `Pulled ${count} change${count === 1 ? "" : "s"} from ${branchName()}. They're pending — apply them to update Figma.`,
    { label: "Review", run: onReviewPulled }
  );
}

// ---------------------------------------------------------------------------
// Review & push — §7.2
// ---------------------------------------------------------------------------

function openReview(): void {
  screen = "review";
  review = blankReview();
  review.loading = true;
  renderRepo();

  void (async () => {
    const status = getGit().status;
    if (status === null) return;
    // Content is fetched only for the files that actually differ, and only when the user opens the
    // diff — ADR-0006 §4. The status check itself downloaded nothing.
    const trees = new Map<string, TokenGroup>();
    for (const file of status.toPush) {
      const tree = await repoTreeFor(file.path);
      if (tree !== null) trees.set(file.path, tree);
    }
    review.repoTrees = trees;
    review.loading = false;
    renderRepo();
  })();
}

/** The token-level diff for one file: the repo's version on the left, ours on the right. */
function fileDiff(path: string): FileDiff {
  const local = localParsedTrees().get(path) ?? null;
  const remote = review.repoTrees?.get(path) ?? null;
  return diffTrees(remote, local);
}

function renderReview(): void {
  const git = getGit();
  const status = git.status;
  if (status === null) {
    goRepoHome();
    return;
  }

  const checked = status.toPush.filter((file) => !review.unchecked.has(file.path));
  const diffs = new Map<string, FileDiff>();
  let rows = 0;
  for (const file of status.toPush) {
    if (isManifestPath(file.path)) continue;
    const diff = fileDiff(file.path);
    diffs.set(file.path, diff);
    if (!review.unchecked.has(file.path)) rows += diff.rows.length;
  }

  repoEl.appendChild(
    head("Review & push", goRepoHome, `${checked.length}/${status.toPush.length}`)
  );

  const body = el("div", "panel-body");
  body.appendChild(
    el(
      "div",
      "empty",
      `${rows} change${rows === 1 ? "" : "s"} in ${checked.length} file${checked.length === 1 ? "" : "s"} → ${git.settings?.branch ?? "main"}`
    )
  );

  if (review.loading) body.appendChild(el("p", "empty", "Loading the diff…"));

  let first = true;
  for (const file of status.toPush) {
    const row = el("div", "file-row");

    // Per-**file** checkboxes: git cannot commit half a file, and a checkbox that implies
    // otherwise is a lie about the unit (§7.2).
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = !review.unchecked.has(file.path);
    box.addEventListener("change", () => {
      if (box.checked) review.unchecked.delete(file.path);
      else review.unchecked.add(file.path);
      // The body regenerates as checkboxes change — until the user types in it (§7.3).
      renderRepo();
    });
    row.appendChild(box);
    row.appendChild(el("div", "fname", file.path));

    const diff = diffs.get(file.path);
    const count = diff === undefined ? 0 : diff.rows.length;
    row.appendChild(
      el("span", "fcount", isManifestPath(file.path) ? "manifest" : `${count} change${count === 1 ? "" : "s"}`)
    );

    // Collapsed by default except the first: a screen that opens fully collapsed makes the user
    // work to see anything at all.
    const isOpen = review.expanded.has(file.path) || (first && !review.expanded.has(`!${file.path}`));
    const caret = button(isOpen ? "▲" : "▼");
    caret.addEventListener("click", () => {
      if (isOpen) {
        review.expanded.delete(file.path);
        review.expanded.add(`!${file.path}`);
      } else {
        review.expanded.add(file.path);
        review.expanded.delete(`!${file.path}`);
      }
      renderRepo();
    });
    row.appendChild(caret);
    body.appendChild(row);
    first = false;

    if (!isOpen) continue;
    const children = el("div", "file-children");

    if (isManifestPath(file.path)) {
      // *"`tokens/$manifest.json` means nothing to a designer, so its nested line says what changed
      // in human terms."* A file in the diff the user cannot interpret is one they learn to ignore.
      //
      // Counts are computed only over the files whose repo content is actually in hand — the ones
      // that differ, which are the only ones fetched (§4). A set whose file is unchanged
      // contributes no line rather than a made-up one: the same "unknown is not none" rule the
      // drift baseline follows (ADR-0005 §8).
      const manifest = importedManifest();
      const repoManifest = (review.repoTrees?.get(file.path) ?? null) as unknown as typeof manifest;
      const repoTrees = review.repoTrees ?? new Map<string, TokenGroup>();
      for (const line of describeManifestChange(repoManifest, manifest, {
        before: tokenCounts(repoTrees, repoManifest),
        after: tokenCounts(localParsedTrees(), manifest),
      })) {
        children.appendChild(el("div", "empty", line));
      }
      body.appendChild(children);
      continue;
    }

    const showAll = review.full.has(file.path);
    const list = diff === undefined ? [] : showAll ? diff.rows : diff.rows.slice(0, 3);
    for (const item of list) {
      children.appendChild(
        diffRow({
          path: item.path,
          set: setsForFile(file.path)[0],
          before: item.before,
          after: item.after,
          state: item.state === "removed" ? "removed" : item.state === "added" ? "added" : "ready",
        })
      );
    }
    if (diff !== undefined && !showAll && diff.rows.length > 3) {
      // `+ 3 more` inside a file, not a scrollbar race — a 200-token commit stays readable.
      const more = el("div", "more-line", `+ ${diff.rows.length - 3} more`);
      more.addEventListener("click", () => {
        review.full.add(file.path);
        renderRepo();
      });
      children.appendChild(more);
    }
    body.appendChild(children);
  }

  // Diverged files appear, above the message field, blocked and unchecked — never hidden. Same
  // treatment as the apply dialog's blocked rows: the failure is visible before the write (§7.2).
  if (status.diverged.length > 0) {
    const blocked = el("div", "repo-section");
    blocked.appendChild(
      el("h3", undefined, `⚑ ${status.diverged.length} file${status.diverged.length === 1 ? "" : "s"} can't be pushed`)
    );
    for (const file of status.diverged) {
      const row = el("div", "file-row");
      row.appendChild(el("div", "fname", file.path));
      row.appendChild(el("span", "badge needs", "diverged"));
      blocked.appendChild(row);
    }
    const sort = button("Sort this out");
    sort.addEventListener("click", () => openDiverged(status.diverged[0].path));
    blocked.appendChild(sort);
    body.appendChild(blocked);
  }

  if (git.failure !== null) {
    const entry = el("div", "entry");
    entry.appendChild(
      el("div", undefined, failureText(git.failure.kind, git.failure.message, git.failure.rateLimitReset))
    );
    if (git.failure.kind === "non-fast-forward") {
      // The one error where the plugin offers the next step as a button, because there is exactly
      // one sensible next step (§7.4). The screen stays put with the message and checkboxes intact.
      const recheck = button("Check again");
      recheck.addEventListener("click", () => void checkStatus().then(renderRepo));
      entry.appendChild(recheck);
    }
    body.appendChild(entry);
  }

  // --- The commit message (§7.3) -------------------------------------------
  const generated = messageFor(
    checked.map((file) => {
      const diff = diffs.get(file.path);
      return {
        path: file.path,
        changed: diff?.changed ?? 0,
        added: diff?.added ?? 0,
        removed: diff?.removed ?? 0,
      };
    })
  );

  body.appendChild(el("h3", undefined, "Message"));
  const summary = el("input", "msg-field") as HTMLInputElement;
  summary.type = "text";
  summary.value = review.summary ?? generated.summary;
  summary.addEventListener("input", () => {
    review.summary = summary.value;
  });
  // Clearing it restores the generated text rather than blocking the button: an empty commit
  // message is not a state anyone wants, it is one they arrived at by selecting all and typing.
  summary.addEventListener("blur", () => {
    if (summary.value.trim().length === 0) {
      review.summary = null;
      summary.value = generated.summary;
    }
  });
  body.appendChild(summary);

  const bodyField = el("textarea", "msg-field field") as HTMLTextAreaElement;
  bodyField.rows = 3;
  bodyField.value = review.bodyTouched ? (review.body ?? "") : generated.body;
  bodyField.addEventListener("input", () => {
    // Nothing is more annoying than a field that eats what you wrote because you toggled a box.
    review.bodyTouched = true;
    review.body = bodyField.value;
  });
  body.appendChild(bodyField);

  repoEl.appendChild(body);

  // A footer with one action, which writes, and one navigation control in the header, which
  // doesn't — that is what keeps the write verb alone and unmissable. No `[ Cancel ]`: back is the
  // way out, as on every other screen in the panel (§7.2).
  const foot = el("div", "panel-foot");
  if (checked.length === 0) foot.appendChild(el("span", "note grow", "Nothing selected"));
  else foot.appendChild(el("span", "grow"));

  const commit = button(`Commit to ${git.settings?.branch ?? "main"}`, "primary");
  commit.disabled = checked.length === 0 || git.busy !== null || review.loading;
  commit.addEventListener("click", () => {
    const text = compose(
      review.summary ?? generated.summary,
      review.bodyTouched ? (review.body ?? "") : generated.body,
      generated.summary
    );
    void runPush(checked, text, rows);
  });
  foot.appendChild(commit);
  repoEl.appendChild(foot);
}

function compose(summary: string, body: string, fallback: string): string {
  const head = summary.trim().length === 0 ? fallback : summary.trim();
  const rest = body.trim();
  return rest.length === 0 ? head : `${head}\n\n${rest}`;
}

async function runPush(files: FileStatus[], message: string, rows: number): Promise<void> {
  const branch = branchName();
  const outcome = await push(files, message, rows);
  if (outcome === null) {
    // Nothing was pushed, and the screen survives its own failure with the message and the
    // checkboxes intact (§7.4). No partial commit state exists, so the copy means it (ADR-0006 §10).
    renderRepo();
    return;
  }

  // The screen is torn down only on a *successful* commit (UX §14).
  review = blankReview();
  screen = "home";
  renderRepo();

  // §11's last row: the push succeeded, so the toast says so — but if the status check that runs
  // after it failed, the freshness line is unknown and the copy must not pretend otherwise.
  if (getGit().failure !== null) {
    toast("Pushed. Couldn't re-check status.", {
      label: "Check again",
      run: () => void checkStatus().then(renderRepo),
    });
    return;
  }

  toast(`Pushed ${rows} change${rows === 1 ? "" : "s"} to ${branch}.`, {
    label: "View commit ↗",
    run: () => window.open(outcome.url, "_blank"),
  });
}

// ---------------------------------------------------------------------------
// Diverged files — §9.2
// ---------------------------------------------------------------------------

function openDiverged(path: string): void {
  const status = getGit().status;
  divergedAt = status === null ? 0 : Math.max(0, status.diverged.findIndex((file) => file.path === path));
  screen = "diverged";
  comparingTree = null;
  renderRepo();
  void loadDivergedTree();
}

async function loadDivergedTree(): Promise<void> {
  const status = getGit().status;
  const file = status?.diverged[divergedAt];
  if (file === undefined) return;
  comparingTree = await repoTreeFor(file.path);
  renderRepo();
}

function renderDiverged(): void {
  const status = getGit().status;
  if (status === null || status.diverged.length === 0) {
    goRepoHome();
    return;
  }
  const at = Math.min(divergedAt, status.diverged.length - 1);
  const file = status.diverged[at];

  repoEl.appendChild(
    head("Diverged files", goRepoHome, `${at + 1}/${status.diverged.length}`)
  );

  const body = el("div", "panel-body");
  body.appendChild(el("div", "mono", file.path));
  // Never say "diverged" without saying what it means in the same breath (§3).
  body.appendChild(
    el(
      "p",
      undefined,
      "This file changed in the repo and here. Tokenvault won't guess which is right, so it won't sync this file until you pick."
    )
  );

  const local = localParsedTrees().get(file.path) ?? null;
  const mine = entriesForFile(file.path);

  if (comparingTree === null) {
    body.appendChild(el("p", "empty", "Reading the repo's version…"));
  } else {
    // Both sides summarized before either button: a file-wide decision made without seeing what is
    // in the file is a coin flip, and this screen exists to stop it being one (§9.2).
    //
    // The two sides are derived from what the panel can actually know: the *repo* side is the repo's
    // tree against the pristine import, and the *here* side is the local edits this file carries.
    // ADR-0006 §3 deliberately stores no per-token base, so a truer three-way split is not
    // available — and inventing one would be the merge §6 refuses, with extra steps.
    const repoSide = diffTrees(local, comparingTree).rows.map((row) => row.path);
    const hereSide = mine.map((entry) => entry.path ?? "").filter((path) => path.length > 0);
    const overlap = repoSide.filter((path) => hereSide.indexOf(path) !== -1);

    side(body, "In the repo", repoSide, comparingTree);
    side(body, "Here", hereSide, local);

    if (overlap.length > 0) {
      // The number that tells the user whether this is a real collision or two people working in
      // different corners of the same file.
      body.appendChild(
        el("div", "entry", `⚠ ${overlap.length} token${overlap.length === 1 ? "" : "s"} changed on both sides.`)
      );
    }

    const compare = button("Compare");
    compare.addEventListener("click", () => {
      compareFor = file.path;
      screen = "compare";
      renderRepo();
    });
    body.appendChild(compare);
  }

  repoEl.appendChild(body);

  const foot = el("div", "panel-foot");
  // Neither button is styled destructive. Both discard something, symmetrically, and neither
  // deletes anything from the file or the repo — making one red would imply the other is safe.
  const takeRepo = button("Take the repo's");
  takeRepo.disabled = comparingTree === null || getGit().busy !== null;
  takeRepo.addEventListener("click", () => {
    void (async () => {
      // The local changes to this file are dropped, and the panel said how many before it did it.
      if (mine.length > 0) revertEntries(entryRefs(mine));
      await pull([file.path]);
      advanceDiverged();
    })();
  });
  foot.appendChild(takeRepo);
  foot.appendChild(el("span", "grow"));

  const keepMine = button("Keep mine");
  keepMine.disabled = getGit().busy !== null;
  keepMine.addEventListener("click", () => {
    void (async () => {
      await keepMineForFile(file.path);
      advanceDiverged();
    })();
  });
  foot.appendChild(keepMine);
  repoEl.appendChild(foot);

  const note = el("div", "panel-foot");
  note.appendChild(el("span", "note", "Whichever you pick applies to the whole file."));
  repoEl.appendChild(note);
}

function side(into: HTMLElement, title: string, paths: string[], tree: TokenGroup | null): void {
  const wrap = el("div", "repo-section");
  wrap.appendChild(
    el("h3", undefined, `${title} · ${paths.length} token${paths.length === 1 ? "" : "s"} differ`)
  );
  for (const path of paths.slice(0, 2)) {
    const row = el("div", "file-row");
    row.appendChild(el("div", "fname", path));
    wrap.appendChild(row);
  }
  if (paths.length > 2) wrap.appendChild(el("div", "empty", `… ${paths.length - 2} more`));
  if (tree === null) wrap.appendChild(el("div", "empty", "Not readable."));
  into.appendChild(wrap);
}

/** Resolving one advances the queue; backing out leaves the rest, and the Repo tab still shows them. */
function advanceDiverged(): void {
  const status = getGit().status;
  if (status === null || status.diverged.length === 0) {
    goRepoHome();
    return;
  }
  divergedAt = 0;
  comparingTree = null;
  renderRepo();
  void loadDivergedTree();
}

// ---------------------------------------------------------------------------
// Compare — §9.2, read-only
// ---------------------------------------------------------------------------

function renderCompare(): void {
  const path = compareFor;
  if (path === null) {
    screen = "diverged";
    renderRepo();
    return;
  }

  repoEl.appendChild(
    head("Compare", () => {
      screen = "diverged";
      renderRepo();
    })
  );

  const body = el("div", "panel-body");
  body.appendChild(el("div", "mono", path));
  body.appendChild(el("div", "empty", "repo → here. Read-only."));

  const local = localParsedTrees().get(path) ?? null;
  const diff = diffTrees(comparingTree, local);

  // Unchanged tokens are collapsed to a count rather than listed — the same rule the apply dialog
  // applies to its `already match` rows (§12: in a list, in-sync is the absence of a mark).
  if (diff.rows.length === 0) body.appendChild(el("p", "empty", "No token-level differences."));
  for (const row of diff.rows) {
    // The same row component as the commit diff and the apply dialog. **Per-token selection is not
    // offered** — picking tokens individually is the three-way merge ADR-0006 §6 refuses, and
    // building a UI for it here would be smuggling it in (§9.2).
    body.appendChild(
      diffRow({
        path: row.path,
        before: row.before,
        after: row.after,
        state: row.state === "removed" ? "removed" : row.state === "added" ? "added" : "ready",
      })
    );
  }
  repoEl.appendChild(body);
}

// ---------------------------------------------------------------------------

let openSettingsHandler: () => void = () => undefined;

export function setSettingsOpener(fn: () => void): void {
  openSettingsHandler = fn;
}

function openSettingsFromRepo(): void {
  openSettingsHandler();
}

