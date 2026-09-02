// Plugin UI entry point: two tabs, one message pump.
//
// Import (Phase 2/3) is unchanged in substance. Tokens (Phase 4) is the local editor — browse,
// edit, delete, undo — over the imported tree, with the `clientStorage` edit overlay laid on top
// (`docs/ux/local-editor.md`, ADR-0004).
//
// Nothing here writes to Figma. Editing a token changes the local tree only; applying tokens back
// to Variables and Styles is Phase 5, and committing them is Phase 6.

import type { PluginToUiMessage, UiToPluginMessage } from "../messages";
import { copy, el, toast } from "./dom";
import { closeDetail, isDetailOpen, renderDetail, setNavigator } from "./detail";
import { initImportView, setImportPayload, setImportScanning, showImportError } from "./importView";
import { conflictedLines, driftedLines, getModel, onChange, send, setOverlay, setPayload } from "./state";
import {
  closeChanges,
  isChangesOpen,
  openChanges,
  renderChanges,
  setChangesNavigator,
} from "./changes";
import { closeModal } from "./applyDialog";
import { closeDeletePanel, isDeletePanelOpen, setConsumerCounts } from "./deleteFigma";
import {
  initTokens,
  renderTokens,
  resetExpansion,
  revealPath,
  setImportNavigator,
} from "./tokens";

const fileNameEl = document.getElementById("file-name") as HTMLHeadingElement;
const scanButton = document.getElementById("scan") as HTMLButtonElement;
const importTab = document.getElementById("tab-import") as HTMLButtonElement;
const tokensTab = document.getElementById("tab-tokens") as HTMLButtonElement;
const stateSlot = document.getElementById("state-slot") as HTMLElement;
const contentEl = document.getElementById("content") as HTMLElement;
const tokensEl = document.getElementById("tokens") as HTMLElement;

type Tab = "import" | "tokens";
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
  contentEl.classList.toggle("hidden", tab !== "import");
  tokensEl.classList.toggle("hidden", tab !== "tokens");
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
  if (!model.ready && model.overlay.entries.length === 0) return;

  const conflicts = conflictedLines().length;
  const drifted = driftedLines().length;
  const local = model.overlay.entries.filter((entry) => entry.conflict === undefined).length;

  let label: string;
  let className: string;

  if (conflicts > 0) {
    label = `${conflicts} conflict${conflicts === 1 ? "" : "s"}`;
    className = "chip warn on";
  } else if (local === 0 && drifted === 0) {
    // Never a green all-clear without a baseline (ADR-0005 §8): "we haven't checked" and "nothing
    // to report" are different answers, and only one of them has earned a green dot.
    if (!model.driftKnown) {
      label = "Not compared";
      className = "chip";
    } else {
      label = "● In sync";
      className = "chip ok";
    }
  } else {
    const parts: string[] = [];
    if (local > 0) parts.push(`${local} local`);
    if (drifted > 0) parts.push(`${drifted} changed`);
    label = parts.join(" · ");
    className = "chip on";
  }

  const chip = el("button", className, label);
  chip.title = "What state is my work in?";
  chip.addEventListener("click", () => {
    showTab("tokens");
    openChanges();
  });
  stateSlot.appendChild(chip);
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

onChange(() => {
  renderStateSlot();
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

scanButton.addEventListener("click", () => {
  setImportScanning(true);
  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
  send({ type: "scan" });
});

window.onmessage = (event: MessageEvent) => {
  const message = event.data.pluginMessage as PluginToUiMessage | undefined;
  if (!message) return;

  if (message.type === "plugin-ready") {
    fileNameEl.textContent = message.fileName;
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
    if (tab === "tokens") renderTokens();
    return;
  }

  if (message.type === "overlay-state") {
    // Edits are applied optimistically in the UI; this is the confirmation, and the only place a
    // failed write can reach the user (ADR-0004 §6).
    setOverlay(message.overlay, message.storageError);
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
    setImportScanning(false);
    scanButton.disabled = false;
    scanButton.textContent = "Scan file";
    showTab("import");
    showImportError(message.message);
  }
};

/** The first failure's own words. Figma's message beats any sentence we could write over it. */
function firstFailure(message: { report: { outcomes: Array<{ ok: boolean; message?: string }> } }): string {
  const failed = message.report.outcomes.filter((outcome) => !outcome.ok);
  return failed[0]?.message ?? "Figma refused the write.";
}

send({ type: "ui-ready" } satisfies UiToPluginMessage);
