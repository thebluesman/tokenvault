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
import { getModel, onChange, send, setOverlay, setPayload } from "./state";
import {
  editsListPopover,
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
  importTab.classList.toggle("active", tab === "import");
  tokensTab.classList.toggle("active", tab === "tokens");
  contentEl.classList.toggle("hidden", tab !== "import");
  tokensEl.classList.toggle("hidden", tab !== "tokens");
  if (tab === "tokens") renderTokens();
}

/**
 * The header's right slot.
 *
 * "Local edits", not "unsaved changes" (UX §5.4): `clientStorage` is per-device and unsynced, so
 * the edits are durable on this machine, invisible on another, and not committed anywhere.
 * "Unsaved" implies a Save button that doesn't exist until Phase 6; "saved" implies they're
 * somewhere safe, which they aren't. The slot itself is reserved for Phase 6's sync pill.
 */
function renderStateSlot(): void {
  stateSlot.textContent = "";
  const count = getModel().overlay.entries.length;
  if (count === 0) return;

  const chip = el("button", "chip on", `Local edits · ${count}`);
  chip.addEventListener("click", () => editsListPopover(chip));
  stateSlot.appendChild(chip);
}

// ---------------------------------------------------------------------------

initImportView(send);
initTokens();
setNavigator((path) => {
  showTab("tokens");
  revealPath(path);
});
setImportNavigator(() => showTab("import"));

onChange(() => {
  renderStateSlot();
  if (tab === "tokens") {
    renderTokens();
    if (isDetailOpen()) renderDetail();
  }
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
    resetExpansion();
    setImportPayload(message.payload);
    setPayload(message.payload);
    renderStateSlot();

    const merge = message.payload.merge;
    if (merge !== undefined && merge.conflicts + merge.orphaned === 0 && merge.applied > 0) {
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

send({ type: "ui-ready" } satisfies UiToPluginMessage);
