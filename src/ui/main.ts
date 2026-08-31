import type { PluginToUiMessage, UiToPluginMessage } from "../messages";

const statusEl = document.getElementById("status") as HTMLParagraphElement;

window.onmessage = (event: MessageEvent) => {
  const message = event.data.pluginMessage as PluginToUiMessage | undefined;
  if (!message) return;

  if (message.type === "plugin-ready") {
    statusEl.textContent = `Connected to "${message.fileName}"`;
  }
};

const ready: UiToPluginMessage = { type: "ui-ready" };
parent.postMessage({ pluginMessage: ready }, "*");
