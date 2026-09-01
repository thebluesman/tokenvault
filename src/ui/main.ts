// Minimal Phase 2 import UI.
//
// Deliberately scaffold-level: it exists so the import can be inspected and its one required
// interaction — confirming number subtypes (PRD §6.1) — can happen. The real token browser,
// editor and diff view are Phase 4/6 and belong to @ux-designer, not to this file.

import type { ImportPayload, PluginToUiMessage, UiToPluginMessage } from "../messages";
import type { ReportEntry, Subtype, SubtypeCandidate, SubtypeSelection } from "../tokens/types";

const NUMBER_SUBTYPES: Subtype[] = ["spacing", "sizing", "radius", "opacity", "duration", "unitless"];
const STRING_SUBTYPES: Subtype[] = ["easing"];

/** Dropdown sentinel for "clear my choice and auto-detect again" — distinct from "untagged". */
const RESET = "__reset";

const fileNameEl = document.getElementById("file-name") as HTMLHeadingElement;
const scanButton = document.getElementById("scan") as HTMLButtonElement;
const contentEl = document.getElementById("content") as HTMLElement;
const toastEl = document.getElementById("toast") as HTMLDivElement;
const clipboardEl = document.getElementById("clipboard") as HTMLTextAreaElement;

let payload: ImportPayload | null = null;
let onlyUnconfirmed = true;
/**
 * True from the moment Scan is clicked until a result or error lands. Every control that would
 * rebuild against the snapshot is disabled meanwhile — a tag edit mid-scan would otherwise be
 * applied to Figma data that is about to be replaced.
 */
let scanning = false;

function send(message: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

let toastTimer = 0;
function toast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1600);
}

/**
 * `navigator.clipboard` is not reliably available inside Figma's plugin iframe, so this uses
 * the selected-textarea route, which is.
 */
function copy(text: string, label: string): void {
  clipboardEl.value = text;
  clipboardEl.select();
  try {
    document.execCommand("copy");
    toast(`Copied ${label}`);
  } catch {
    toast("Copy failed — select the JSON manually");
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------

function render(): void {
  contentEl.textContent = "";
  if (!payload) return;

  contentEl.appendChild(renderCounts(payload));
  contentEl.appendChild(renderSubtypes(payload.candidates));
  contentEl.appendChild(renderReport(payload.entries));
  contentEl.appendChild(renderFiles(payload));
}

function renderCounts(data: ImportPayload): HTMLElement {
  const section = el("section");
  section.appendChild(el("h2", undefined, "Summary"));
  const grid = el("div", "counts");

  if (data.importedAt !== "") {
    const read = el("p", "empty", `Figma file read at ${data.importedAt}`);
    section.appendChild(read);
  }

  const stats: Array<[string, number]> = [
    ["Collections", data.counts.collections],
    ["Modes", data.counts.modes],
    ["Variables", data.counts.variables],
    ["Tokens", data.counts.tokens],
    ["Flagged", data.counts.flagged],
    ["Unconfirmed", data.counts.unconfirmedSubtypes],
  ];

  for (const [label, value] of stats) {
    const box = el("div", "count");
    box.appendChild(el("b", undefined, String(value)));
    box.appendChild(el("span", undefined, label));
    grid.appendChild(box);
  }

  section.appendChild(grid);
  return section;
}

function renderSubtypes(candidates: SubtypeCandidate[]): HTMLElement {
  const section = el("section");
  const unconfirmed = candidates.filter((candidate) => candidate.needsConfirmation);
  section.appendChild(
    el("h2", undefined, `Number & string types — ${unconfirmed.length} unconfirmed`)
  );

  if (candidates.length === 0) {
    section.appendChild(el("p", "empty", "No number or string variables in this file."));
    return section;
  }

  const toolbar = el("div", "toolbar");

  const filterLabel = el("label");
  const filterBox = el("input");
  filterBox.type = "checkbox";
  filterBox.checked = onlyUnconfirmed;
  filterBox.addEventListener("change", () => {
    onlyUnconfirmed = filterBox.checked;
    render();
  });
  filterLabel.appendChild(filterBox);
  filterLabel.appendChild(document.createTextNode("Only unconfirmed"));
  toolbar.appendChild(filterLabel);

  const shown = onlyUnconfirmed ? unconfirmed : candidates;

  const bulkSelect = el("select");
  bulkSelect.appendChild(new Option("Set all shown to…", ""));
  bulkSelect.appendChild(new Option("untagged", "untagged"));
  for (const subtype of NUMBER_SUBTYPES) bulkSelect.appendChild(new Option(subtype, subtype));
  for (const subtype of STRING_SUBTYPES) bulkSelect.appendChild(new Option(subtype, subtype));
  bulkSelect.disabled = scanning;
  bulkSelect.addEventListener("change", () => {
    const chosen = bulkSelect.value as SubtypeSelection | "";
    if (chosen === "") return;
    const updates: Record<string, SubtypeSelection | null> = {};
    for (const candidate of shown) {
      if (isSelectable(chosen, candidate.tokenType)) updates[candidate.variableId] = chosen;
    }
    bulkSelect.value = "";
    if (Object.keys(updates).length > 0) send({ type: "set-subtypes", subtypes: updates });
  });
  toolbar.appendChild(bulkSelect);

  const confirmAll = el("button", undefined, "Confirm all guesses as-is");
  confirmAll.disabled = scanning || unconfirmed.length === 0;
  confirmAll.addEventListener("click", () => {
    const updates: Record<string, SubtypeSelection | null> = {};
    for (const candidate of unconfirmed) {
      if (candidate.subtype !== undefined) updates[candidate.variableId] = candidate.subtype;
    }
    if (Object.keys(updates).length > 0) send({ type: "set-subtypes", subtypes: updates });
  });
  toolbar.appendChild(confirmAll);

  section.appendChild(toolbar);

  if (shown.length === 0) {
    section.appendChild(el("p", "empty", "Every number variable has a confirmed or auto-detected type."));
    return section;
  }

  for (const candidate of shown) {
    section.appendChild(renderCandidateRow(candidate));
  }
  return section;
}

function renderCandidateRow(candidate: SubtypeCandidate): HTMLElement {
  const row = el("div", "row");

  const name = el("div", "name", candidate.variableName);
  name.title = `${candidate.collectionName} · ${candidate.scopes.join(", ") || "no scopes"} · ${String(candidate.sampleValue)}`;
  row.appendChild(name);

  const badge = el(
    "span",
    candidate.needsConfirmation ? "badge needs" : "badge",
    candidate.subtypeSource
  );
  row.appendChild(badge);

  const select = el("select");
  const allowed = candidate.tokenType === "number" ? NUMBER_SUBTYPES : STRING_SUBTYPES;
  // Three states, matching what the importer can represent: hand it back to auto-detection,
  // deliberately give it no subtype, or name one.
  select.appendChild(new Option("auto-detect", RESET));
  select.appendChild(new Option("untagged", "untagged"));
  for (const subtype of allowed) select.appendChild(new Option(subtype, subtype));
  select.value =
    candidate.subtype ?? (candidate.subtypeSource === "user" ? "untagged" : RESET);
  select.disabled = scanning;
  select.addEventListener("change", () => {
    const chosen = select.value === RESET ? null : (select.value as SubtypeSelection);
    send({ type: "set-subtypes", subtypes: { [candidate.variableId]: chosen } });
  });
  row.appendChild(select);

  return row;
}

function isSelectable(selection: SubtypeSelection, tokenType: "number" | "string"): boolean {
  if (selection === "untagged") return true;
  const allowed = tokenType === "number" ? NUMBER_SUBTYPES : STRING_SUBTYPES;
  return allowed.indexOf(selection) !== -1;
}

function renderReport(entries: ReportEntry[]): HTMLElement {
  const section = el("section");
  section.appendChild(el("h2", undefined, `Flagged — ${entries.length}`));

  if (entries.length === 0) {
    section.appendChild(el("p", "empty", "Nothing flagged. Every variable mapped cleanly."));
    return section;
  }

  for (const entry of entries) {
    const box = el("div", "entry");
    const head = el("div");
    head.appendChild(el("span", "kind", `${entry.kind} · ${entry.reason}`));
    box.appendChild(head);
    box.appendChild(el("div", undefined, entry.message));
    // `theme-composition` entries are file-scoped and carry no participants (Amendment 1 §C).
    const participants = entry.participants ?? [];
    if (participants.length > 0) {
      const names = participants
        .map((participant) => `${participant.outcome === "written" ? "kept" : "skipped"}: ${participant.collectionName}/${participant.variableName || "(collection)"}`)
        .join("  ·  ");
      box.appendChild(el("div", "meta", names));
    }
    section.appendChild(box);
  }
  return section;
}

function renderFiles(data: ImportPayload): HTMLElement {
  const section = el("section");
  section.appendChild(el("h2", undefined, `Generated files — ${data.files.length}`));

  const toolbar = el("div", "toolbar");
  const copyAll = el("button", "primary", "Copy whole tree as JSON");
  copyAll.addEventListener("click", () => {
    // A path → content map, so the tree can be written to disk in one line:
    //   node scripts/write-tokens.mjs <file.json>
    const tree: Record<string, unknown> = {};
    for (const file of data.files) tree[file.path] = JSON.parse(file.json);
    copy(JSON.stringify(tree, null, 2), `${data.files.length} files`);
  });
  toolbar.appendChild(copyAll);
  section.appendChild(toolbar);

  for (const file of data.files) {
    const details = el("details", "file");
    const summary = el("summary");
    summary.appendChild(el("span", "grow", file.path));

    const copyOne = el("button", undefined, "Copy");
    copyOne.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      copy(file.json, file.path);
    });
    summary.appendChild(copyOne);
    details.appendChild(summary);
    details.appendChild(el("pre", undefined, file.json));
    section.appendChild(details);
  }

  return section;
}

// ---------------------------------------------------------------------------

scanButton.addEventListener("click", () => {
  scanning = true;
  scanButton.disabled = true;
  scanButton.textContent = "Scanning…";
  // Re-render so the subtype controls disable too, not just this button.
  render();
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
    scanning = false;
    scanButton.disabled = false;
    scanButton.textContent = "Rescan";
    payload = message.payload;
    render();
    return;
  }

  if (message.type === "import-error") {
    scanning = false;
    scanButton.disabled = false;
    scanButton.textContent = "Scan Variables";
    contentEl.textContent = "";
    const box = el("div", "entry");
    box.appendChild(el("span", "kind", "import failed"));
    box.appendChild(el("div", undefined, message.message));
    contentEl.appendChild(box);
  }
};

send({ type: "ui-ready" } satisfies UiToPluginMessage);
