import type { PluginToUiMessage, UiToPluginMessage } from "./messages";

figma.showUI(__html__, { width: 360, height: 480 });

figma.ui.onmessage = (message: UiToPluginMessage) => {
  if (message.type === "ui-ready") {
    const reply: PluginToUiMessage = { type: "plugin-ready", fileName: figma.root.name };
    figma.ui.postMessage(reply);
  }
};
