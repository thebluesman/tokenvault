// The Import tab — Phase 2/3's scan/confirm/report screen, unchanged in substance.
//
// Split out of `main.ts` in Phase 4 only because there are now two tabs and one file holding both
// would be the wrong shape. The one Phase 4 addition is honesty about where the displayed tree
// came from: it is the import, without the local edit overlay (the Tokens tab holds that), and it
// may have been restored from the `clientStorage` cache rather than a live scan (ADR-0004 §1).

import type { ImportPayload, UiToPluginMessage } from "../messages";
import type { ReportEntry, ReportParticipant, SubtypeCandidate, SubtypeSelection } from "../tokens/types";
import { NUMBER_SUBTYPES, STRING_SUBTYPES } from "../tokens/subtype";
import { countBands } from "../tokens/importCounts";
import {
  bulkUndoMessage,
  confirmMap,
  defaultOpenGroup,
  groupCandidates,
  needsConfirmStrip,
  previousSelections,
  type SubtypeGroup,
} from "../tokens/subtypeGroups";
import { button, copy, el, toast } from "./dom";
import { threePlaceStrip } from "./threePlace";

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
  // A parked bulk write names a set of ids from the previous payload. Once a new build lands those
  // ids may be confirmed, gone, or guessed differently, so the question it was asking is stale.
  pendingBulk = null;
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

  if (!payload) {
    if (scanError === null && !scanning) contentEl.appendChild(renderNeverScanned());
    return;
  }

  contentEl.appendChild(renderCounts(payload));
  contentEl.appendChild(renderSubtypes(payload.candidates));
  contentEl.appendChild(renderReport(payload.entries));
  contentEl.appendChild(renderFiles(payload));
}

/**
 * The Import tab before anything has been read — UX `onboarding-polish.md` §7.1.
 *
 * This screen used to be genuinely blank: `renderImport` returned early with no payload, so a
 * first-timer's first look at the plugin was an empty rectangle and a header button. The strip
 * explains the system; the sentence under it explains the screen; the scan button in the header
 * does the thing.
 */
function renderNeverScanned(): HTMLElement {
  const wrap = el("div");
  wrap.style.padding = "8px 0";
  wrap.appendChild(threePlaceStrip("import"));
  wrap.appendChild(el("p", undefined, "Nothing read from this file yet."));
  wrap.appendChild(
    el("p", "empty", "Press Scan file above to read this file's Variables and Styles.")
  );
  return wrap;
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

  // Banded rather than flat — UX `onboarding-polish.md` §6.1. Two headings, not two colours, and
  // not one number changed: `Flagged` and `Partial` are import defects, `to confirm` is a job, and
  // rendered at identical weight in one row all three read as *132 things went wrong*.
  for (const band of countBands(data.counts)) {
    section.appendChild(el("div", "band-head", band.heading));
    const bandGrid = el("div", "counts");
    for (const box of band.boxes) {
      const cell = el("div", "count");
      cell.appendChild(el("b", undefined, String(box.value)));
      cell.appendChild(el("span", undefined, box.label));
      bandGrid.appendChild(cell);
    }
    section.appendChild(bandGrid);
  }

  return section;
}

// ---------------------------------------------------------------------------
// The subtype queue — UX `onboarding-polish.md` §5
// ---------------------------------------------------------------------------

/** Which guess groups are open. Seeded to the largest on first render, then the user's own. */
let openGroups: Set<string> | null = null;

/** A bulk write waiting on §5.2's confirm strip. `null` when nothing is pending. */
let pendingBulk: {
  ids: string[];
  /** The subtype every id becomes, or `null` for "confirm each row's own guess". */
  subtype: SubtypeSelection | null;
  question: string;
  consequence: string;
  verb: string;
} | null = null;

function cancelBulk(): void {
  pendingBulk = null;
  renderImport();
}

/**
 * Runs a bulk write, or asks first — §5.2.
 *
 * Under the threshold it goes straight through, with the toast as the way back. Over it, the write
 * is parked and `git-sync.md` §10.4's inline confirm strip appears in place: it is the single most
 * consequential control on this tab and it shipped with none of the protections the panel gives to
 * far smaller actions.
 */
function bulkWrite(
  updates: Record<string, SubtypeSelection | null>,
  subtype: SubtypeSelection | null,
  question: (count: number) => string,
  consequence: (count: number) => string,
  verb: (count: number) => string
): void {
  const ids = Object.keys(updates);
  if (ids.length === 0) return;

  if (needsConfirmStrip(ids.length)) {
    pendingBulk = {
      ids,
      subtype,
      question: question(ids.length),
      consequence: consequence(ids.length),
      verb: verb(ids.length),
    };
    renderImport();
    return;
  }
  commitBulk(updates, subtype);
}

/** Sends the write and offers the inverse map back for ten seconds (§5.2, §11). */
function commitBulk(
  updates: Record<string, SubtypeSelection | null>,
  subtype: SubtypeSelection | null
): void {
  const ids = Object.keys(updates);
  // Captured **before** the write, from the candidates the panel is currently showing: the inverse
  // of this map for exactly these ids. Not a snapshot of every stored tag.
  const inverse = previousSelections(payload?.candidates ?? [], ids);
  pendingBulk = null;
  send({ type: "set-subtypes", subtypes: updates });
  toast(bulkUndoMessage(ids.length, subtype), {
    label: "Undo",
    run: () => send({ type: "set-subtypes", subtypes: inverse }),
  });
}

function setAllMap(
  candidates: SubtypeCandidate[],
  chosen: SubtypeSelection
): Record<string, SubtypeSelection | null> {
  const updates: Record<string, SubtypeSelection | null> = {};
  for (const candidate of candidates) {
    if (isSelectable(chosen, candidate.tokenType)) updates[candidate.variableId] = chosen;
  }
  return updates;
}

/** `Set all N … to…`, for the whole shown list or for one group. */
function setAllSelect(candidates: SubtypeCandidate[], label: string): HTMLSelectElement {
  const select = el("select") as HTMLSelectElement;
  select.appendChild(new Option(label, ""));
  select.appendChild(new Option("untagged", "untagged"));
  for (const subtype of NUMBER_SUBTYPES) select.appendChild(new Option(subtype, subtype));
  for (const subtype of STRING_SUBTYPES) select.appendChild(new Option(subtype, subtype));
  select.disabled = scanning || pendingBulk !== null;
  select.addEventListener("change", () => {
    const chosen = select.value as SubtypeSelection | "";
    select.value = "";
    if (chosen === "") return;
    bulkWrite(
      setAllMap(candidates, chosen),
      chosen,
      (count) => `Set ${count} variable${count === 1 ? "" : "s"} to ${chosen}?`,
      () => "You can change any of them afterwards, one at a time or in bulk.",
      (count) => `Set ${count}`
    );
  });
  return select;
}

function renderSubtypes(candidates: SubtypeCandidate[]): HTMLElement {
  const section = el("section");
  const unconfirmed = candidates.filter((candidate) => candidate.needsConfirmation);
  // "to confirm", matching the count box above it (§6.1): it names a job of the user's rather than
  // a defect state of a token.
  section.appendChild(
    el("h2", undefined, `Number & string types — ${unconfirmed.length} to confirm`)
  );

  if (candidates.length === 0) {
    section.appendChild(el("p", "empty", "No number or string variables in this file."));
    return section;
  }

  const shown = onlyUnconfirmed ? unconfirmed : candidates;

  // §5.4's paragraph, and half of §6.1's fix: the two things that make accepting a hundred guesses
  // a reasonable thing to do. Without it, `Confirm all 132` is a button nobody sane presses.
  if (unconfirmed.length > 0) {
    section.appendChild(
      el(
        "p",
        "empty",
        "These are guesses, not errors. Tokenvault read Figma's scopes to guess each one. Accepting them all is fine — you can change any token's type later from its detail panel."
      )
    );
  }

  const toolbar = el("div", "toolbar");

  const filterLabel = el("label");
  const filterBox = el("input");
  filterBox.type = "checkbox";
  filterBox.checked = onlyUnconfirmed;
  filterBox.addEventListener("change", () => {
    onlyUnconfirmed = filterBox.checked;
    pendingBulk = null;
    renderImport();
  });
  filterLabel.appendChild(filterBox);
  filterLabel.appendChild(document.createTextNode("Only unconfirmed"));
  toolbar.appendChild(filterLabel);

  // §5.2: the label carries the count, recomputed with the list. "Shown" is the product of a
  // checkbox the user set two interactions ago, and a mass write that won't say how many rows it
  // will touch is the one control on this tab that most needed to.
  toolbar.appendChild(setAllSelect(shown, `Set all ${shown.length} shown to…`));

  // §5.4 — the primary, with the count in its label. On a well-scoped file most guesses are right,
  // and the honest fast path is to take them and correct individuals from the detail panel.
  const confirmAll = button(`Confirm all ${unconfirmed.length} guesses`, "primary");
  confirmAll.disabled = scanning || unconfirmed.length === 0 || pendingBulk !== null;
  confirmAll.addEventListener("click", () => {
    bulkWrite(
      confirmMap(unconfirmed),
      null,
      (count) => `Confirm ${count} guess${count === 1 ? "" : "es"}?`,
      () => "Each one keeps the type Tokenvault guessed for it. You can change any of them later.",
      (count) => `Confirm ${count}`
    );
  });
  toolbar.appendChild(confirmAll);
  section.appendChild(toolbar);

  if (pendingBulk !== null) section.appendChild(renderBulkConfirm(pendingBulk));

  if (shown.length === 0) {
    // §5.5 — the queue has to visibly empty, and let you back in. `Only unconfirmed` is still
    // checked, and an unlabelled checkbox is not a way back.
    section.appendChild(
      el("p", undefined, "Every number and string variable has a type.")
    );
    section.appendChild(
      el("p", "empty", "You can change any of them from a token's detail panel.")
    );
    if (onlyUnconfirmed && candidates.length > 0) {
      const showAll = button(`Show all ${candidates.length}`);
      showAll.addEventListener("click", () => {
        onlyUnconfirmed = false;
        renderImport();
      });
      section.appendChild(showAll);
    }
    return section;
  }

  const groups = groupCandidates(shown);
  if (openGroups === null) {
    const first = defaultOpenGroup(groups);
    openGroups = new Set(first === null ? [] : [first]);
  }
  for (const group of groups) section.appendChild(renderGroup(group));
  return section;
}

/** §5.2's guard, reusing `git-sync.md` §10.4's strip — its second use, and the shape it was made for. */
function renderBulkConfirm(pending: NonNullable<typeof pendingBulk>): HTMLElement {
  const strip = el("div", "confirm-strip");
  strip.appendChild(el("div", undefined, pending.question));
  strip.appendChild(el("div", "empty", pending.consequence));

  const actions = el("div", "actions");
  // Cancel is the quieter of the two: nothing here is destructive, so backing out must be at least
  // as easy as going through.
  const cancel = button("Cancel");
  cancel.addEventListener("click", cancelBulk);
  actions.appendChild(cancel);
  actions.appendChild(el("span", "grow"));
  const go = button(pending.verb, "primary");
  go.addEventListener("click", () => {
    const updates: Record<string, SubtypeSelection | null> = {};
    if (pending.subtype === null) {
      const byId = new Map((payload?.candidates ?? []).map((one) => [one.variableId, one]));
      for (const id of pending.ids) {
        const candidate = byId.get(id);
        if (candidate?.subtype !== undefined) updates[id] = candidate.subtype;
      }
    } else {
      for (const id of pending.ids) updates[id] = pending.subtype;
    }
    commitBulk(updates, pending.subtype);
  });
  actions.appendChild(go);
  strip.appendChild(actions);
  return strip;
}

/**
 * One guess group — §5.3.
 *
 * A disclosure row, the same caret row `local-editor.md` §9 added for the tree, with a
 * `.badge`-weight count and two controls on it. Collapsed by default except the largest: a 132-row
 * wall is the thing being fixed, and opening one group shows the shape without rebuilding it.
 */
function renderGroup(group: SubtypeGroup): HTMLElement {
  const wrap = el("div", "group");
  const open = openGroups !== null && openGroups.has(group.key);

  const head = el("div", "row group-head");
  const caret = el("button", "caret-btn", `${open ? "▾" : "▸"} ${group.label}`);
  caret.addEventListener("click", () => {
    if (openGroups === null) openGroups = new Set();
    if (open) openGroups.delete(group.key);
    else openGroups.add(group.key);
    renderImport();
  });
  head.appendChild(caret);
  head.appendChild(el("span", "grow"));

  // The button counts what the click would actually change, not how big the group is: with the
  // `Only unconfirmed` filter off, a group can be mostly rows the user has already answered for.
  const pendingConfirm = confirmMap(group.candidates);
  const pendingConfirmCount = Object.keys(pendingConfirm).length;
  if (group.confirmable && pendingConfirmCount > 0) {
    const confirm = button(`Confirm ${pendingConfirmCount}`);
    confirm.disabled = scanning || pendingBulk !== null;
    confirm.addEventListener("click", () => {
      bulkWrite(
        pendingConfirm,
        null,
        (count) => `Confirm ${count} as ${String(group.subtype)}?`,
        (count) => `All ${count} keep the type Tokenvault guessed. You can change any of them later.`,
        (count) => `Confirm ${count}`
      );
    });
    head.appendChild(confirm);
  }
  // `no guess` gets the set-all only: there is nothing to confirm, and it sorts last because it is
  // the group that genuinely needs reading.
  head.appendChild(setAllSelect(group.candidates, `Set all ${group.candidates.length} to…`));
  wrap.appendChild(head);

  if (open) {
    for (const candidate of group.candidates) wrap.appendChild(renderCandidateRow(candidate));
  }
  return wrap;
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
