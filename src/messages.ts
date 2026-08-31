// Message contract between the plugin controller (code.ts) and the UI iframe (ui/main.ts).

export type UiToPluginMessage = { type: "ui-ready" };

export type PluginToUiMessage = { type: "plugin-ready"; fileName: string };
