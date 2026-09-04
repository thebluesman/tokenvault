// The Import tab — Phase 2/3's scan/confirm/report screen, unchanged in substance.
//
// Split out of `main.ts` in Phase 4 only because there are now two tabs and one file holding both
// would be the wrong shape. The one Phase 4 addition is honesty about where the displayed tree
// came from: it is the import, without the local edit overlay (the Tokens tab holds that), and it
// may have been restored from the `clientStorage` cache rather than a live scan (ADR-0004 §1).

import type { ImportPayload, UiToPluginMessage } from "../messages";
import type { ReportEntry, ReportParticipant, SubtypeCandidate, SubtypeSelection } from "../tokens/types";
import { NUMBER_SUBTYPES, STRING_SUBTYPES } from "../tokens/subtype";
import { copy, el } from "./dom";

/** Dropdown sentinel for "clear my choice and auto-detect again" — distinct from "untagged". */
const RESET = "__reset";

const contentEl = document.getElementById("content") as HTMLElement;

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
let scanning = false;

let send: (message: UiToPluginMessage) => void = () => undefined;

export function initImportView(sender: (message: UiToPluginMessage) => void): void {
  send = sender;
}

export function setImportPayload(next: ImportPayload): void {
  payload = next;
  renderImport();
}

/** The scan that failed, until the next one starts — UX `error-states.md` §2. */
let scanError: string | null = null;

/** Timer behind §2.3's "still reading" line, so a slow scan is legible rather than mute. */
let slowScanTimer = 0;
let slowScan = false;

/** How long a scan runs before the panel admits it is taking a while (§2.3). */
const SLOW_SCAN_MS = 20000;

export function setImportScanning(next: boolean): void {
  scanning = next;
  window.clearTimeout(slowScanTimer);
  if (next) {
    // A new scan clears the previous failure: the old message describes a read that is no longer
    // the current answer, and leaving it up alongside `Scanning…` reads as a failure of this one.
    scanError = null;
    slowScan = false;
    slowScanTimer = window.setTimeout(() => {
      slowScan = true;
      renderImport();
    }, SLOW_SCAN_MS);
  } else {
    slowScan = false;
  }
  renderImport();
}

/**
 * The scan-failure notice — UX `error-states.md` §2.
 *
 * **Does not wipe the view.** The Phase 2 version cleared `#content` first, so a failed *rescan*
 * took the previous report off the screen with it — which is backwards: a scan is read-only, so a
 * failed one changes nothing about the tree the panel is already holding (§2.1).
 */
export function showImportError(message: string): void {
  scanError = message;
  renderImport();
}

export function renderImport(): void {
  contentEl.textContent = "";

  if (scanError !== null) contentEl.appendChild(renderScanError(scanError));
  else if (scanning && slowScan) contentEl.appendChild(renderSlowScan());

  if (!payload) return;

  contentEl.appendChild(renderCounts(payload));
  contentEl.appendChild(renderSubtypes(payload.candidates));
  contentEl.appendChild(renderReport(payload.entries));
  contentEl.appendChild(renderFiles(payload));
}

function renderScanError(message: string): HTMLElement {
  const box = el("div", "entry");
  box.appendChild(el("span", "kind", "couldn't read this file"));
  box.appendChild(
    el(
      "div",
      undefined,
      // Blast radius before cause (§2.2). A scan is read-only, so this sentence is always true and
      // is stated flatly rather than hedged — it is also the sentence the user actually needs.
      "Tokenvault couldn't finish reading this file's Variables and Styles. Nothing was changed — not in Figma, and not in your local edits."
    )
  );
  // Figma's own words, attributed and unrewritten: it is the only diagnostic there is.
  const said = el("div", "meta");
  said.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
  said.textContent = `Figma said: ${message}`;
  box.appendChild(said);

  const actions = el("div", "toolbar");
  actions.style.marginTop = "6px";
  const retry = el("button", "primary", "Try again");
  retry.addEventListener("click", () => {
    // The same message the header button sends. Transient Figma failures are real, and making the
    // user go find that button again is a small insult on top of the failure.
    onRetry();
    send({ type: "scan" });
  });
  actions.appendChild(retry);

  const details = el("button", undefined, "Copy details");
  details.addEventListener("click", () => copy(`Tokenvault scan failed\n\n${message}`, "the details"));
  actions.appendChild(details);
  box.appendChild(actions);

  return box;
}

/**
 * §2.3 — a scan that hasn't come back yet. Grey, not amber: waiting is not a warning, and the plugin
 * genuinely does not know whether this is a large file or a wedged one.
 */
function renderSlowScan(): HTMLElement {
  const line = el("p", "empty");
  line.textContent =
    "Still reading this file — large files can take a while. Figma can't interrupt a read once it has started, so there's nothing to cancel.";
  return line;
}

/** Set by `main.ts`, which owns the scan button's label and disabled state. */
let onRetry: () => void = () => undefined;

export function setRetryHandler(handler: () => void): void {
  onRetry = handler;
}

function renderCounts(data: ImportPayload): HTMLElement {
  const section = el("section");
  section.appendChild(el("h2", undefined, "Summary"));
  const grid = el("div", "counts");

  if (data.fromCache) {
    section.appendChild(
      el(
        "p",
        "empty",
        data.importedAt === ""
          ? "Restored from this device's cached import. Rescan to re-read the Figma file."
          : `Restored from this device's cached import of ${data.importedAt}. Rescan to re-read the Figma file.`
      )
    );
  } else if (data.importedAt !== "") {
    section.appendChild(el("p", "empty", `Figma file read at ${data.importedAt}`));
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
    renderImport();
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
  row.id = `candidate-${candidate.variableId}`;

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
  select.value = candidate.subtype ?? (candidate.subtypeSource === "user" ? "untagged" : RESET);
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
      renderImport();
    });
    label.appendChild(box);
    label.appendChild(
      document.createTextNode(`Show partial tokens and redundant styles (${informational.length})`)
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
  // Asks the controller rather than serializing here: the copy has to carry the local edit
  // overlay (UX §5.4 — until Phase 6 it is the only durable exit), and the overlay lives there.
  const copyAll = el("button", "primary", "Copy whole tree as JSON");
  copyAll.addEventListener("click", () => send({ type: "copy-tree" }));
  toolbar.appendChild(copyAll);

  // The generated tree is only half a regression fixture: without the scan that produced it,
  // nothing in CI can rebuild it. This is the only way the input leaves the plugin sandbox.
  const copyScan = el("button", undefined, "Copy Figma scan (fixture input)");
  copyScan.addEventListener("click", () => send({ type: "copy-scan" }));
  toolbar.appendChild(copyScan);

  section.appendChild(toolbar);
  section.appendChild(
    el("p", "empty", "Shown as imported. Local edits are applied to the copied tree, and browsable on the Tokens tab.")
  );

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
