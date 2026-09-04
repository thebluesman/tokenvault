// Plugin UI entry point: two tabs, one message pump.
//
// Import (Phase 2/3) is unchanged in substance. Tokens (Phase 4) is the local editor — browse,
// edit, delete, undo — over the imported tree, with the `clientStorage` edit overlay laid on top
// (`docs/ux/local-editor.md`, ADR-0004).
//
// Nothing here writes to Figma. Editing a token changes the local tree only; applying tokens back
// to Variables and Styles is Phase 5, and committing them is Phase 6.

import type { ImportPayload, PluginToUiMessage, UiToPluginMessage } from "../messages";
import { copy, el, toast } from "./dom";
import { closeDetail, isDetailOpen, renderDetail, setNavigator } from "./detail";
import {
  initImportView,
  setImportPayload,
  setImportScanning,
  setRetryHandler,
  showImportError,
} from "./importView";
import { conflictedLines, driftedLines, getModel, onChange, send, setOverlay, setPayload } from "./state";
import {
  closeChanges,
  isChangesOpen,
  openChanges,
  renderChanges,
  setChangesNavigator,
} from "./changes";
import { closeModal } from "./applyDialog";
import { closeDeletePanel, isDeletePanelOpen, reportDeleteResult, setConsumerCounts } from "./deleteFigma";
import {
  initTokens,
  renderTokens,
  resetExpansion,
  revealPath,
  setApplyFailure,
  setImportNavigator,
} from "./tokens";
import { crash, describeOperation, guard, installErrorBoundary } from "./errors";
import { getGit, handleGitMessage, onGitChange, recomputeStatus } from "./git";
import {
  connectionBroken,
  openSettings,
  renderSettings,
  setSettingsCloseHandler,
} from "./settings";
import {
  renderRepo,
  repoTabLabel,
  setPullReviewHandler,
  setSettingsOpener,
  showRepoTab,
} from "./repo";

const fileNameEl = document.getElementById("file-name") as HTMLHeadingElement;
const scanButton = document.getElementById("scan") as HTMLButtonElement;
const importTab = document.getElementById("tab-import") as HTMLButtonElement;
const tokensTab = document.getElementById("tab-tokens") as HTMLButtonElement;
const repoTab = document.getElementById("tab-repo") as HTMLButtonElement;
const gearButton = document.getElementById("gear") as HTMLButtonElement;
const stateSlot = document.getElementById("state-slot") as HTMLElement;
const contentEl = document.getElementById("content") as HTMLElement;
const tokensEl = document.getElementById("tokens") as HTMLElement;

type Tab = "import" | "tokens" | "repo";
let tab: Tab = "import";
let hasImport = false;

function showTab(next: Tab): void {
  if (next === "tokens" && !hasImport && getModel().overlay.entries.length === 0) return;
  tab = next;
  closeDetail();
  closeChanges();
  closeDeletePanel();
  closeModal();
  importTab.classList.toggle("active", tab === "import");
  tokensTab.classList.toggle("active", tab === "tokens");
  repoTab.classList.toggle("active", tab === "repo");
  contentEl.classList.toggle("hidden", tab !== "import");
  tokensEl.classList.toggle("hidden", tab !== "tokens");
  // The Repo tab is a sibling of the other two, and switching to it never buries the state chip
  // behind a back arrow — the header stays put (UX git-sync §4.1, §6.2).
  showRepoTab(tab === "repo");
  if (tab === "tokens") renderTokens();
}

/**
 * The header's right slot — UX apply-and-drift §6.3.
 *
 * Phase 4 put **Local edits · 7** here and called it the first occupant of a permanent slot. Phase
 * 5 makes it plural, not different: the chip **names the state, not the arithmetic**, and there are
 * 100px to do it in.
 *
 * | Situation           | Chip                                              |
 * |---------------------|---------------------------------------------------|
 * | Nothing anywhere    | `● In sync` — green, low emphasis, still tappable  |
 * | Local edits only    | `7 local`                                         |
 * | Figma changes only  | `3 changed`                                       |
 * | Both                | `7 local · 3 changed`                             |
 * | Any conflicts       | `2 conflicts` — amber, wins the slot outright     |
 * | Any cycles          | `2 cycles` — amber, outranks even conflicts (§9)  |
 *
 * Conflicts win because they are the only state where the panel is showing a value two sources
 * disagree about; everything else is merely pending.
 *
 * "Local edits", not "unsaved changes" (local-editor §5.4): `clientStorage` is per-device and
 * unsynced, so the edits are durable on this machine, invisible on another, and not committed
 * anywhere. The slot itself still belongs to Phase 6's sync pill in the end.
 */
function renderStateSlot(): void {
  stateSlot.textContent = "";
  const model = getModel();
  const git = getGit();
  if (!model.ready && model.overlay.entries.length === 0 && git.settings === null) return;

  const conflicts = conflictedLines().length;
  const drifted = driftedLines().length;
  const local = model.overlay.entries.filter((entry) => entry.conflict === undefined).length;
  const cycles = model.cycles.length;

  let label: string;
  let tone: "" | "on" | "warn" | "ok";

  if (cycles > 0) {
    // Rank 2 — above conflicts (UX §9, resolution 4). A cycle is the only left-half state that
    // **refuses an operation outright**: every token on a loop is blocked at apply, so a user about
    // to press Apply needs to know before they press it. That is the same argument that put
    // `diverged` first, applied to the Figma side; conflicts, by contrast, have a live value and
    // merely need a decision.
    //
    // The count is **loops, not tokens on loops**. Counting the nine tokens across two loops would
    // make a small problem look like a large one.
    label = `${cycles} cycle${cycles === 1 ? "" : "s"}`;
    tone = "warn";
  } else if (conflicts > 0) {
    label = `${conflicts} conflict${conflicts === 1 ? "" : "s"}`;
    tone = "warn";
  } else if (local === 0 && drifted === 0) {
    // Never a green all-clear without a baseline (ADR-0005 §8): "we haven't checked" and "nothing
    // to report" are different answers, and only one of them has earned a green dot.
    if (!model.driftKnown) {
      label = "Not compared";
      tone = "";
    } else {
      label = "● In sync";
      tone = "ok";
    }
  } else {
    const parts: string[] = [];
    if (local > 0) parts.push(`${local} local`);
    if (drifted > 0) parts.push(`${drifted} changed`);
    label = parts.join(" · ");
    tone = "on";
  }

  // One chip, split by a hairline divider — left half Figma, right half repo (UX git-sync §6.1).
  // Not two chips: the divider is what makes *in sync with what* answerable without a word, and
  // since §4.1 each half also has its own destination on tap.
  const chip = el("div", "sync-chip");

  const left = el("button", tone === "ok" ? "ok" : undefined, label);
  left.title = "What state is my work in?";
  left.addEventListener("click", () => {
    showTab("tokens");
    openChanges();
  });
  chip.appendChild(left);

  const right = repoHalf();
  if (right !== null) {
    // Precedence when it doesn't all fit (§6.1): diverged › conflicts › repo counts › Figma counts.
    // The Figma half's own warn tone (an unresolved conflict) still has to win over a clean repo
    // status — a connected file with conflicts is not a file with nothing to warn about.
    if (right.tone === "warn" || tone === "warn") chip.classList.add("warn");
    else if (right.tone === "on" || tone === "on") chip.classList.add("on");
    const button = el("button", undefined, right.label);
    button.title = "What does the repo think?";
    button.addEventListener("click", () => showTab("repo"));
    chip.appendChild(button);
  } else if (tone === "warn") {
    chip.classList.add("warn");
  } else if (tone === "on") {
    chip.classList.add("on");
  }

  stateSlot.appendChild(chip);
}

/**
 * The chip's right half — UX §6.1.
 *
 * **When not connected it is absent entirely** — not greyed, not `—` — and takes no taps. That is
 * the whole reason this returns `null` rather than an empty string: an empty slot that still holds
 * width and a click target is a control that does nothing, which is worse than no control.
 *
 * `↑`/`↓` are **file** counts and appear only here; every list spells out *To push* / *To pull*
 * in words (§6.1, §12). `diverged` is always a word, never a glyph — it is the one state that
 * blocks an operation and the one term the user won't already know.
 */
function repoHalf(): { label: string; tone: "on" | "warn" } | null {
  const git = getGit();
  if (git.settings === null) return null;
  if (git.failure !== null && git.failure.kind === "offline") return { label: "⚠ offline", tone: "warn" };
  if (git.status === null) return { label: git.checking ? "…" : "not checked", tone: "on" };

  const status = git.status;
  if (status.diverged.length > 0) {
    return { label: `${status.diverged.length} diverged`, tone: "warn" };
  }
  const parts: string[] = [];
  if (status.toPush.length > 0) parts.push(`↑ ${status.toPush.length}`);
  if (status.toPull.length > 0) parts.push(`↓ ${status.toPull.length}`);
  if (parts.length === 0) return { label: "● in sync", tone: "on" };
  return { label: parts.join(" "), tone: "on" };
}

/** The Repo tab's label and the gear's one state mark, both recomputed on every git change. */
function renderRepoChrome(): void {
  repoTab.textContent = repoTabLabel();
  gearButton.classList.toggle("needs", connectionBroken());
}

// ---------------------------------------------------------------------------

initImportView(send);
initTokens();
const goToPath = (path: string): void => {
  showTab("tokens");
  revealPath(path);
};
setNavigator(goToPath);
setChangesNavigator(goToPath);
setImportNavigator(() => showTab("import"));

setSettingsOpener(openSettings);
setSettingsCloseHandler(() => {
  renderStateSlot();
  renderRepoChrome();
  renderRepo();
});
setPullReviewHandler(() => {
  // *"`[ Review ]` opens the Changes list on the Local tab, where the entries are sitting"* — the
  // state moving from the repo half of the chip to the Figma half, visibly, in one hop (§8.1).
  showTab("tokens");
  openChanges("local");
});

onGitChange(() => {
  renderStateSlot();
  renderRepoChrome();
  renderRepo();
  renderSettings();
  // The drift block's labels are keyed to connection state (UX §10.2), so a connect or disconnect
  // has to repaint whatever is open — both are live code paths, and a file can be disconnected at
  // any time.
  if (tab === "tokens" && isChangesOpen()) renderChanges();
});

onChange(() => {
  // Locally, from the tree already fetched — an edit moves the local half of §4's comparison and
  // nothing else. No request is made here; the network cadence is untouched.
  recomputeStatus();
  renderStateSlot();
  renderRepoChrome();
  if (tab === "repo") renderRepo();
  if (tab !== "tokens") return;
  renderTokens();
  // The three full-panel surfaces share one element, so exactly one of them owns it at a time.
  // Repainting the detail over the Changes list (or over the delete confirmation, mid-decision)
  // is the failure this ordering exists to prevent.
  if (isChangesOpen()) renderChanges();
  else if (!isDeletePanelOpen() && isDetailOpen()) renderDetail();
});

importTab.addEventListener("click", () => showTab("import"));
tokensTab.addEventListener("click", () => showTab("tokens"));
repoTab.addEventListener("click", () => showTab("repo"));
gearButton.addEventListener("click", () => openSettings());

function beginScan(): void {
  setImportScanning(true);
  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
}

scanButton.addEventListener("click", () => {
  beginScan();
  send({ type: "scan" });
});

// `[ Try again ]` inside the scan-failure notice sends the `scan` itself; this puts the header
// button into the same state, so there is one scanning state rather than two that can disagree.
setRetryHandler(beginScan);

/** The theme currently reported by the plugin, so a change can be told from a re-emit. */
let lastReportedTheme: string | null | undefined;

/**
 * §8.3 — the two consequences of a theme change that would otherwise read as bugs, in one toast.
 *
 * Values change, which is the feature. And **flag counts change**, because `⚑ unresolved` appears
 * and disappears with the theme and so can `⚑ cycle` — the graph is theme-scoped too (§7.4). A
 * `⚑ N flagged` count moving when you switch a lens looks alarming; the second sentence is what
 * makes it read as arithmetic instead, and it is **omitted entirely when the count is zero**,
 * because a toast that says "and nothing is wrong" every time is one people dismiss unread.
 */
function reportThemeChange(payload: ImportPayload): void {
  if (payload.themeFellBackFrom !== undefined) {
    // Silently resolving against a stack the user did not choose would change every displayed value
    // with no explanation (ADR-0007 §7a).
    toast(
      `${payload.themeFellBackFrom} isn't in this file any more. Showing ${payload.activeTheme ?? "nothing"} instead.`
    );
    lastReportedTheme = payload.activeTheme;
    return;
  }

  const changed = lastReportedTheme !== undefined && lastReportedTheme !== payload.activeTheme;
  lastReportedTheme = payload.activeTheme;
  if (!changed || payload.activeTheme === null) return;

  const unresolved = payload.entries.filter((entry: { kind: string }) => entry.kind === "unresolved-in-theme").length;
  toast(
    unresolved === 0
      ? `Resolving against ${payload.activeTheme}.`
      : `Resolving against ${payload.activeTheme}. ${unresolved} token${unresolved === 1 ? "" : "s"} ${unresolved === 1 ? "has" : "have"} no value in this theme.`
  );
}

window.onmessage = (event: MessageEvent) => {
  // Every message is handled inside the boundary: a render that throws mid-message used to leave a
  // half-painted tree that no longer responded, which is indistinguishable from a hung plugin
  // (UX `error-states.md` §3).
  guard(() => handleMessage(event.data.pluginMessage as PluginToUiMessage | undefined));
};

function handleMessage(message: PluginToUiMessage | undefined): void {
  if (!message) return;

  // Git messages are routed first and consumed there — the credential reply in particular must not
  // fall through to anything that logs or renders a message (ADR-0006 §1).
  if (handleGitMessage(message)) {
    if (message.type === "git-pull-result" && message.conflicts > 0) {
      toast(
        `${message.conflicts} pulled change${message.conflicts === 1 ? "" : "s"} landed on a token you'd edited — resolve them in Conflicts.`
      );
    }
    return;
  }

  if (message.type === "plugin-ready") {
    fileNameEl.textContent = message.fileName;
    // *"A status check runs on panel open"* (UX §14) — fired from the `git-config` handler rather
    // than here, because the settings and the token it needs arrive in that later message.
    return;
  }

  if (message.type === "import-result") {
    setImportScanning(false);
    scanButton.disabled = false;
    scanButton.textContent = "Rescan";
    hasImport = true;
    tokensTab.disabled = false;
    tokensTab.title = "";
    // The tree may not have the same shape after a rescan, so expansion starts over (UX §4.4).
    // A `refresh` is the same snapshot re-derived after a conflict/orphan resolution — collapsing
    // the tree under the user mid-review would be a worse answer than the stale flag was.
    if (message.payload.refresh !== true) resetExpansion();
    setImportPayload(message.payload);
    setPayload(message.payload);
    renderStateSlot();

    const merge = message.payload.merge;
    if (
      merge !== undefined &&
      merge.conflicts + merge.orphaned + merge.drifted === 0 &&
      merge.applied > 0
    ) {
      // Nothing needs attention, so nothing should hold screen space in a 640px panel — a toast,
      // not the banner (UX §5.5).
      toast(`${merge.applied} local edit${merge.applied === 1 ? "" : "s"} reapplied.`);
    }
    reportThemeChange(message.payload);
    if (tab === "tokens") renderTokens();
    return;
  }

  if (message.type === "theme-switch-result") {
    // Partial mapping is reported, never silent (ADR-0007 §7c). Style-backed sets are excluded
    // upstream and never appear here — Figma Styles have no modes, so naming them every time is how
    // you teach someone to stop reading the toast.
    //
    // **No `[ Undo ]`.** The rule holds without an exemption: the panel can undo what it did to the
    // tokens; only Figma can undo what was done to the file (UX §8.4).
    const unmapped = message.unmapped.concat(message.failed.map((each) => each.collectionName));
    const head = `Switched this page to ${message.theme}.`;
    toast(
      unmapped.length === 0
        ? head
        : `${head} ${unmapped.length} set${unmapped.length === 1 ? "" : "s"} ${unmapped.length === 1 ? "has" : "have"} no Figma mode: ${unmapped.join(", ")}.`
    );
    return;
  }

  if (message.type === "overlay-state") {
    // Edits are applied optimistically in the UI; this is the confirmation, and the only place a
    // failed write can reach the user (ADR-0004 §6).
    setOverlay(message.overlay, message.storageError, message.recovery);
    tokensTab.disabled = hasImport === false && message.overlay.entries.length === 0;
    renderStateSlot();
    return;
  }

  if (message.type === "apply-result") {
    // Nothing about a canvas write is visible in the panel afterwards, so the toast carries real
    // weight — and it is **report only, with no action button**: there is no plugin-side undo for
    // anything that touches the file (UX §5.5). Phase 4's `[ Undo ]` stays on the local-edit
    // toasts it already serves, and only those.
    const { report } = message;
    const verb = report.destructive ? "Deleted" : "Applied";

    // The delete confirmation is still on screen and owns its own outcome (UX apply-and-drift §7):
    // it closes on success and stays open with the refusal on it on failure.
    if (report.destructive && reportDeleteResult(report.failed, firstFailure(message))) {
      if (report.failed === 0) {
        toast(`Deleted ${report.applied} item${report.applied === 1 ? "" : "s"} from Figma.`);
      }
      return;
    }

    // A value apply that failed leaves an `.entry` behind the toast, because the toast is gone in
    // 1.8 seconds and the failure is still true afterwards (§7, amended 2026-09-04).
    if (!report.destructive) {
      if (report.failed === 0) setApplyFailure(null);
      else if (report.applied === 0) {
        setApplyFailure({
          text: "Couldn't apply — nothing changed in Figma.",
          reason: firstFailure(message),
        });
      } else {
        setApplyFailure({
          text: `Applied ${report.applied} of ${report.outcomes.length}. ${report.failed} failed — they're still in your local edits.`,
          reason: firstFailure(message),
        });
      }
    }

    if (report.outcomes.length === 0) {
      toast("Nothing to apply.");
    } else if (report.failed === 0) {
      toast(`${verb} ${report.applied} change${report.applied === 1 ? "" : "s"} in Figma.`);
    } else if (report.applied === 0) {
      // Nothing landed, so there is nothing to take back — the reason is what matters.
      toast(`Couldn't ${report.destructive ? "delete" : "apply"} — ${firstFailure(message)}`);
    } else {
      // Partial success never rounds up to success. The failed entries did not match after the
      // rescan, so they are still in the overlay and still visible in the tree.
      toast(
        `${verb} ${report.applied} of ${report.outcomes.length}. ${report.failed} failed — ${firstFailure(message)}`
      );
    }
    return;
  }

  if (message.type === "consumer-counts") {
    setConsumerCounts(message.counts);
    return;
  }

  if (message.type === "tree-json") {
    if (message.files === 0) toast("Nothing scanned yet");
    else copy(message.json, `${message.files} files`);
    return;
  }

  if (message.type === "scan-snapshot") {
    if (message.json === null) toast("Nothing scanned yet");
    else copy(message.json, "the Figma scan");
    return;
  }

  if (message.type === "import-error") {
    // A scan that failed changed nothing (UX `error-states.md` §2.1), so the panel keeps whatever
    // tree it had: the Tokens tab stays enabled, the button goes back to whichever verb is true,
    // and the notice is added to the Import view rather than replacing it.
    setImportScanning(false);
    scanButton.disabled = false;
    scanButton.textContent = hasImport ? "Rescan" : "Scan file";
    showTab("import");
    showImportError(message.message);
    return;
  }

  if (message.type === "plugin-error") {
    // Everything the product knows how to fail at has its own designed notice. This is what is
    // left — see `error-states.md` §3.3, and the routing rule that keeps it rare.
    crash({ message: message.message, context: describeOperation(message.source) });
  }
};

/**
 * Re-runs the startup handshake — the crash screen's `[ Reload the panel ]` (§3.2).
 *
 * Not `location.reload()`: the plugin iframe's document is injected by Figma rather than served, so
 * reloading it is unreliable, and this path re-derives everything the UI holds anyway. It is also
 * the path exercised on every panel open, which makes it the one most likely to still work in the
 * state a crash leaves behind.
 */
function recoverUi(): void {
  closeDetail();
  closeChanges();
  closeDeletePanel();
  closeModal();
  setApplyFailure(null);
  send({ type: "ui-ready" });
}

installErrorBoundary(recoverUi);

/** The first failure's own words. Figma's message beats any sentence we could write over it. */
function firstFailure(message: { report: { outcomes: Array<{ ok: boolean; message?: string }> } }): string {
  const failed = message.report.outcomes.filter((outcome) => !outcome.ok);
  return failed[0]?.message ?? "Figma refused the write.";
}

send({ type: "ui-ready" } satisfies UiToPluginMessage);
