// Minimal Phase 2/3 import UI.
//
// Deliberately scaffold-level: it exists so the import can be inspected and its one required
// interaction — confirming number subtypes (PRD §6.1) — can happen. The real token browser,
// editor and diff view are Phase 4/6 and belong to @ux-designer, not to this file.
//
// Phase 3 adds the styles side: the same scan produces style sets too, so the summary counts
// them and the report has to render style-shaped participants and the two informational kinds
// (`partial-token`, `redundant-style`) without burying the failures underneath them.

import type { ImportPayload, PluginToUiMessage, UiToPluginMessage } from "../messages";
import type {
  ReportEntry,
  ReportParticipant,
  Subtype,
  SubtypeCandidate,
  SubtypeSelection,
} from "../tokens/types";

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
 * Whether the two informational report kinds are shown.
 *
 * They are on by default because ADR-0003 §4 already de-noises the common mirror case, and
 * hiding an entry by default is how a "fail loud" report quietly stops being one. The toggle
 * exists because a file where styles and Variables were maintained in parallel can still produce
 * a long list, and a failure should not be buried under it.
 */
let showInformational = true;
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
    ["Styles", data.counts.styles ?? 0],
    ["Tokens", data.counts.tokens],
    // Of the token total, so a file whose styles all mirrored Variables reads as 0 rather than
    // looking like the styles scan silently failed.
    ["from styles", data.counts.styleTokens ?? 0],
    ["Flagged", data.counts.flagged],
    ["Partial", data.counts.partialTokens ?? 0],
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

/**
 * The two kinds that report something imported rather than something lost (ADR-0003 §6).
 *
 * `redundant-style` is not a failure at all, and `partial-token` is a token that exists but is
 * degraded. Both are rendered differently from a real failure so the failures stay legible.
 */
const INFORMATIONAL_KINDS: ReportEntry["kind"][] = ["partial-token", "redundant-style"];

function isInformational(entry: ReportEntry): boolean {
  return INFORMATIONAL_KINDS.indexOf(entry.kind) !== -1;
}

/**
 * One participant, whichever source it came from.
 *
 * A style participant carries `styleId`/`styleName` with the variable fields left empty, and a
 * collection participant is the mirror of that (Amendment 1 §E, ADR-0003 §5) — so the label is
 * chosen by which identity is actually populated rather than assumed.
 */
function participantLabel(participant: ReportParticipant): string {
  const outcome = participant.outcome === "written" ? "kept" : "skipped";
  if (participant.styleName) return `${outcome}: style ${participant.styleName}`;
  if (participant.variableName) return `${outcome}: ${participant.collectionName}/${participant.variableName}`;
  return `${outcome}: collection ${participant.collectionName || "(unknown)"}`;
}

function renderReport(entries: ReportEntry[]): HTMLElement {
  const section = el("section");
  const informational = entries.filter(isInformational);
  const failures = entries.length - informational.length;

  section.appendChild(
    el("h2", undefined, `Flagged — ${failures} + ${informational.length} informational`)
  );

  if (entries.length === 0) {
    section.appendChild(el("p", "empty", "Nothing flagged. Every variable and style mapped cleanly."));
    return section;
  }

  if (informational.length > 0) {
    const toolbar = el("div", "toolbar");
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.checked = showInformational;
    box.addEventListener("change", () => {
      showInformational = box.checked;
      render();
    });
    label.appendChild(box);
    label.appendChild(
      document.createTextNode(
        `Show partial tokens and redundant styles (${informational.length})`
      )
    );
    toolbar.appendChild(label);
    section.appendChild(toolbar);
  }

  const shown = showInformational ? entries : entries.filter((entry) => !isInformational(entry));
  if (shown.length === 0) {
    section.appendChild(el("p", "empty", "Nothing failed. Everything flagged was informational."));
    return section;
  }

  for (const entry of shown) {
    const box = el("div", isInformational(entry) ? "entry info" : "entry");
    const head = el("div");
    head.appendChild(el("span", "kind", `${entry.kind} · ${entry.reason}`));
    if (entry.set !== undefined) head.appendChild(el("span", "badge", entry.set));
    box.appendChild(head);
    box.appendChild(el("div", undefined, entry.message));

    if (entry.omitted !== undefined && entry.omitted.length > 0) {
      box.appendChild(el("div", "meta", `not written: ${entry.omitted.join(", ")}`));
    }

    // `theme-composition` entries are file-scoped and carry no participants (Amendment 1 §C).
    const participants = entry.participants ?? [];
    if (participants.length > 0) {
      box.appendChild(el("div", "meta", participants.map(participantLabel).join("  ·  ")));
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

  // The generated tree is only half a regression fixture: without the scan that produced it,
  // nothing in CI can rebuild it. This is the only way the input leaves the plugin sandbox.
  const copyScan = el("button", undefined, "Copy Figma scan (fixture input)");
  copyScan.addEventListener("click", () => send({ type: "copy-scan" }));
  toolbar.appendChild(copyScan);

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

  if (message.type === "scan-snapshot") {
    if (message.json === null) toast("Nothing scanned yet");
    else copy(message.json, "the Figma scan");
    return;
  }

  if (message.type === "import-error") {
    scanning = false;
    scanButton.disabled = false;
    scanButton.textContent = "Scan file";
    contentEl.textContent = "";
    const box = el("div", "entry");
    box.appendChild(el("span", "kind", "import failed"));
    box.appendChild(el("div", undefined, message.message));
    contentEl.appendChild(box);
  }
};

send({ type: "ui-ready" } satisfies UiToPluginMessage);
