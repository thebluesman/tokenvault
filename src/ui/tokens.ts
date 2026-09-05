// The Tokens tab — the merged token browser. UX local-editor §4, §7, §8.
//
// One tree across every set, keyed by dotted path. A path defined in several sets is one row with
// a stacked value line per set (§4.2), which is why the tree is **variable-height** and why the
// virtualizer below works off a prefix-sum of measured-by-construction heights rather than a
// single row constant.
//
// Rough arithmetic on the Folio fixture: 1,316 tokens minus the 289 paths `Theme/Dark` duplicates
// from `Theme/Light` is about 1,027 rows, most of them one line. Rendering all of them is a
// visible stall on every filter keystroke, so only the window in view is in the DOM.

import type { GroupNode, TreeNode } from "../tokens/view";
import type { OverlayEntry, OverlayTarget } from "../tokens/overlay";
import type { TokenType } from "../tokens/types";
import type { Line, Row } from "./state";
import {
  deleteBlockers,
  dismissDrift,
  editBlockedReason,
  editValue,
  filters,
  getModel,
  resolutionFor,
  setActiveTheme,
  switchPageTheme,
  hiddenMatches,
  pathsUnder,
  revert,
  send,
  setCounts,
  typeCounts,
  visibleRows,
} from "./state";
import { openDeleteInFigma } from "./deleteFigma";
import { hasMixedTypes } from "../tokens/view";
import { previewOf } from "../tokens/preview";
import { parseHexColor, parseNumberValue, parseStringValue } from "../tokens/edit";
import { normalizePathKey } from "../tokens/paths";
import { button, clear, closePopover, copy, el, highlight, popover, toast } from "./dom";
import { applyLines, closeDetail, deleteButton, openDetail, runDelete } from "./detail";

const GLYPHS: Record<TokenType, string> = {
  color: "■",
  number: "#",
  boolean: "◑",
  string: "T",
  typography: "¶",
  shadow: "◍",
  grid: "▦",
};

const GROUP_HEIGHT = 24;
const SINGLE_HEIGHT = 24;
const NAME_LINE_HEIGHT = 20;
const VALUE_LINE_HEIGHT = 18;
/** Rows rendered above and below the viewport, so a fast scroll doesn't flash empty. */
const OVERSCAN = 6;

const filtersEl = document.getElementById("tokens-filters") as HTMLElement;
const noticesEl = document.getElementById("tokens-notices") as HTMLElement;
const scrollEl = document.getElementById("tokens-scroll") as HTMLElement;
const canvasEl = document.getElementById("tokens-canvas") as HTMLElement;

interface Placed {
  top: number;
  height: number;
  depth: number;
  group?: GroupNode;
  row?: Row;
}

let expanded = new Set<string>();
let expansionSeeded = false;
let placed: Placed[] = [];
let bannerDismissed = false;
let lastWindow = "";

export function initTokens(): void {
  scrollEl.addEventListener("scroll", () => paint(false));
  window.addEventListener("resize", () => paint(true));
}

/** Expansion resets on rescan — the tree may not have the same shape (§4.4). */
export function resetExpansion(): void {
  expanded = new Set();
  expansionSeeded = false;
  bannerDismissed = false;
}

export function renderTokens(): void {
  renderFilters();
  renderNotices();
  renderTree();
}

// ---------------------------------------------------------------------------
// Filters — §4.3, §4.6
// ---------------------------------------------------------------------------

function renderFilters(): void {
  clear(filtersEl);
  const model = getModel();

  const search = el("input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Filter tokens";
  search.value = filters.query;
  search.addEventListener("input", () => {
    filters.query = search.value;
    renderNotices();
    renderTree();
  });
  filtersEl.appendChild(search);

  const chips = el("div", "chips");

  // §8.1 — the theme chip goes **leftmost, in the filter row**, beside the other two lenses. Not
  // the header state slot: a theme is not a state, nothing about it needs you, and it never blocks
  // an operation. Not a fourth tab: with composition editing out of scope there is nothing to work
  // on. It is leftmost because it is the widest-reaching lens — the set filter changes *what is
  // listed*, the theme changes *what every listed value means*.
  const themeChip = el("button", "chip") as HTMLButtonElement;
  themeChip.textContent = `Theme: ${model.activeTheme?.name ?? "none"} ▾`;
  themeChip.title =
    model.activeTheme === null
      ? "This file's shape means Tokenvault couldn't work out any themes."
      : `Values resolve through ${model.activeTheme.name}.`;
  themeChip.addEventListener("click", () => popover(themeChip, buildThemePopover));
  chips.appendChild(themeChip);

  const setChip = el("button", filters.sets === null ? "chip" : "chip on") as HTMLButtonElement;
  setChip.textContent =
    filters.sets === null ? "All sets" : `${filters.sets.size} of ${model.sets.length} sets`;
  setChip.addEventListener("click", () => popover(setChip, buildSetPopover));
  chips.appendChild(setChip);

  const typeChip = el("button", filters.types === null ? "chip" : "chip on") as HTMLButtonElement;
  typeChip.textContent = filters.types === null ? "All types" : `${filters.types.size} types`;
  typeChip.addEventListener("click", () => popover(typeChip, buildTypePopover));
  chips.appendChild(typeChip);

  const flaggedCount = model.flagged;
  const flagChip = el("button", filters.flaggedOnly ? "chip warn on" : "chip") as HTMLButtonElement;
  flagChip.textContent = `⚑ ${flaggedCount} flagged`;
  flagChip.disabled = flaggedCount === 0;
  flagChip.addEventListener("click", () => {
    filters.flaggedOnly = !filters.flaggedOnly;
    renderTokens();
  });
  chips.appendChild(flagChip);

  // Deep-links back to the Import tab's confirm step rather than duplicating that control here —
  // it already works, and a second one could disagree with it (§4.6).
  const unconfirmed = el("button", "chip") as HTMLButtonElement;
  unconfirmed.textContent = `● ${model.unconfirmed} unconfirmed`;
  unconfirmed.disabled = model.unconfirmed === 0;
  unconfirmed.addEventListener("click", () => goToImport());
  chips.appendChild(unconfirmed);

  filtersEl.appendChild(chips);
}

let goToImport: () => void = () => undefined;

export function setImportNavigator(fn: () => void): void {
  goToImport = fn;
}

/**
 * The theme popover — §8.2. **A picker, not an editor.**
 *
 * Composition editing is out of scope (ADR-0007 §7b, Shyam's 2026-09-03 scope call), so there is no
 * `[ New theme ]`, no rename, no delete, and no set checkboxes. The set list is read-only and
 * showing it is the point: the one honest thing this control can do beyond picking is answer *what
 * am I actually resolving against*, in `selectedTokenSets` order, last-wins.
 *
 * Two things happen in this popover and they are separated by a rule, worded differently, and only
 * one of them is a button — because only one of them touches the file (§8.4, §11 resolution 1).
 */
function buildThemePopover(close: () => void): HTMLElement {
  const model = getModel();
  const wrap = el("div");

  // §8.5, resolution 2 — the chip stays present and explains itself. An absent control reads as
  // *unbuilt*, a disabled one reads as *broken*, and a present one that explains itself reads as
  // *known limitation*, which is the true one. Dropping this is a design deviation, not a scope trim.
  if (model.themes.length === 0) {
    wrap.appendChild(el("div", "group-label", "No themes for this file"));
    const many = model.multiModeCollections;
    wrap.appendChild(
      el(
        "div",
        "empty",
        `Tokenvault works themes out from Figma's collections and modes. This file has ${many.length} collection${many.length === 1 ? "" : "s"} with more than one mode, so there's more than one way to combine them — and picking one for you would quietly give you the wrong values.`
      )
    );
    wrap.appendChild(
      el("div", "empty", `Values below resolve through every set, in order, last one wins: ${model.sets.map((info) => info.code).join(" · ")}`)
    );
    wrap.appendChild(el("div", "empty", "Building a theme by hand isn't in this version."));
    const report = button("See the import report");
    report.addEventListener("click", () => {
      close();
      goToImport();
    });
    wrap.appendChild(report);
    return wrap;
  }

  for (const theme of model.themes) {
    const item = el("button", "item") as HTMLButtonElement;
    const active = model.activeTheme?.name === theme.name;
    item.appendChild(el("span", undefined, active ? "✓" : " "));
    const label = el("span", undefined, theme.name);
    label.style.flex = "1";
    item.appendChild(label);
    // A grey tag, not a state badge: it marks whichever theme the canvas is currently set to, and
    // it needs nothing from the user.
    if (model.themeOnCanvas === theme.name) item.appendChild(el("span", "count-right", "on canvas"));
    item.addEventListener("click", () => {
      close();
      // Picking a theme writes nothing anywhere — not the canvas, not the overlay, not the repo.
      setActiveTheme(theme.name);
    });
    wrap.appendChild(item);
  }

  const active = model.activeTheme;
  if (active === null) return wrap;

  if (model.themes.length === 1) {
    wrap.appendChild(
      el("div", "empty", "This file has one set of values; Tokenvault named it " + active.name + ".")
    );
  }

  const codes = new Map(model.sets.map((info) => [info.id, info.code] as const));
  wrap.appendChild(el("div", "group-label", `${active.name} resolves through, in order:`));
  wrap.appendChild(
    el("div", "empty", active.selectedTokenSets.map((id) => codes.get(id) ?? id).join(" · "))
  );

  // The bridge between the two lenses, and a button rather than an automatic coupling because
  // "show me every set but resolve as Dark" is a legitimate thing to want when hunting an
  // `⚑ unresolved` (§8.2).
  const only = button("Show only these sets");
  only.addEventListener("click", () => {
    filters.sets = new Set(active.selectedTokenSets);
    close();
    renderTokens();
  });
  wrap.appendChild(only);

  // §8.4 — the only thing in Phase 7 that modifies the Figma document, and everything about it is
  // designed not to be confused with picking a theme: a second, explicitly labelled tap, below a
  // rule, worded differently. It is not an apply and never opens the apply dialog; ⌘Z is the undo.
  wrap.appendChild(el("div", "group-label", " "));
  const switchButton = button(`Switch this page to ${active.name}`);
  if (themeMapsNothing(active.selectedTokenSets)) {
    switchButton.disabled = true;
    switchButton.title = "Nothing on this page follows these collections.";
  }
  switchButton.addEventListener("click", () => {
    close();
    switchPageTheme(active.name);
  });
  wrap.appendChild(switchButton);

  return wrap;
}

/** Whether a theme maps to any Figma mode at all — the disabled-with-a-reason case (§8.4). */
function themeMapsNothing(sets: string[]): boolean {
  const model = getModel();
  const variableSets = new Set(
    model.sets.filter((info) => info.source === "variables").map((info) => info.id)
  );
  return sets.every((set) => !variableSets.has(set));
}

function buildSetPopover(close: () => void): HTMLElement {
  const model = getModel();
  const counts = setCounts();
  const wrap = el("div");

  const all = el("button", "item") as HTMLButtonElement;
  all.textContent = filters.sets === null ? "✓ All sets" : "All sets";
  all.addEventListener("click", () => {
    filters.sets = null;
    close();
    renderTokens();
  });
  wrap.appendChild(all);

  let lastSource = "";
  for (const info of model.sets) {
    if (info.source !== lastSource) {
      wrap.appendChild(el("div", "group-label", info.source === "styles" ? "Styles" : "Variables"));
      lastSource = info.source;
    }
    const on = filters.sets === null || filters.sets.has(info.id);
    const item = el("button", "item") as HTMLButtonElement;
    item.appendChild(el("span", undefined, on ? "☑" : "☐"));
    const label = el("span", info.source === "styles" ? "setcode derived" : undefined, info.label);
    label.style.flex = "1";
    item.appendChild(label);
    item.appendChild(el("span", "count-right", String(counts.get(info.id) ?? 0)));
    item.addEventListener("click", () => {
      const next = new Set(filters.sets ?? model.sets.map((each) => each.id));
      if (next.has(info.id)) next.delete(info.id);
      else next.add(info.id);
      filters.sets = next.size === model.sets.length ? null : next;
      close();
      renderTokens();
    });
    wrap.appendChild(item);
  }
  return wrap;
}

function buildTypePopover(close: () => void): HTMLElement {
  const counts = typeCounts();
  const wrap = el("div");

  const all = el("button", "item") as HTMLButtonElement;
  all.textContent = filters.types === null ? "✓ All types" : "All types";
  all.addEventListener("click", () => {
    filters.types = null;
    close();
    renderTokens();
  });
  wrap.appendChild(all);

  for (const type of Array.from(counts.keys()).sort()) {
    const on = filters.types === null || filters.types.has(type);
    const item = el("button", "item") as HTMLButtonElement;
    item.appendChild(el("span", undefined, on ? "☑" : "☐"));
    const label = el("span", undefined, type);
    label.style.flex = "1";
    item.appendChild(label);
    item.appendChild(el("span", "count-right", String(counts.get(type) ?? 0)));
    item.addEventListener("click", () => {
      const next = new Set(filters.types ?? Array.from(counts.keys()));
      if (next.has(type)) next.delete(type);
      else next.add(type);
      filters.types = next.size === counts.size ? null : next;
      close();
      renderTokens();
    });
    wrap.appendChild(item);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Notices — the rescan summary, orphans, storage failures (§5.5, §8)
// ---------------------------------------------------------------------------

/**
 * The last apply that failed, until the next one — UX apply-and-drift §7.
 *
 * A failed apply used to be a toast and nothing else, which is the treatment for a success whose
 * result isn't on screen. §7 asks for an `.entry`, and the reason is that the failure is *actionable*
 * and the toast is gone in 1.8 seconds: the edits are still in the overlay and still in the tree, and
 * the user has to be able to read what refused them after the toast has passed.
 */
let applyFailure: { text: string; reason: string } | null = null;

export function setApplyFailure(failure: { text: string; reason: string } | null): void {
  applyFailure = failure;
  renderTokens();
}

function renderNotices(): void {
  clear(noticesEl);
  const model = getModel();

  const recovery = model.overlayRecovery;
  if (recovery !== undefined) {
    // UX `error-states.md` §4.2. Non-blocking on purpose: the tree, the scan, the repo and every
    // other feature are unaffected, and a modal over a working panel makes the user close the
    // plugin — the one action that helps least.
    // "Set aside", not "deleted" and not "saved": the blob is still in the sandbox's store under
    // another key, which is neither of those two things (§4.2).
    const box = el("div", "entry");
    box.appendChild(
      el(
        "span",
        "kind",
        recovery.outcome === "partial"
          ? "some local edits couldn't be read"
          : "local edits couldn't be read"
      )
    );
    box.appendChild(
      el(
        "div",
        undefined,
        recovery.outcome === "partial"
          ? `${recovery.kept} of ${recovery.kept + recovery.dropped} were recovered; ${recovery.dropped} ${recovery.dropped === 1 ? "was" : "were"} unreadable and ${recovery.dropped === 1 ? "has" : "have"} been set aside. The recovered edits are live and everything else works normally.`
          : "The stored data for this file is corrupt, so Tokenvault has started from a clean slate. Nothing in Figma or in the repo has changed, and the unreadable data has been set aside rather than deleted."
      )
    );
    if (recovery.raw !== null) {
      const actions = el("div", "toolbar");
      actions.style.marginTop = "6px";
      const rescue = button("Copy the unreadable data");
      rescue.addEventListener("click", () => copy(recovery.raw ?? "", "the unreadable data"));
      actions.appendChild(rescue);
      box.appendChild(actions);
    } else {
      box.appendChild(
        el(
          "div",
          "meta",
          "The unreadable data couldn't be set aside either — plugin storage refused the write."
        )
      );
    }
    noticesEl.appendChild(box);
  }

  if (applyFailure !== null) {
    const failure = applyFailure;
    const box = el("div", "entry");
    box.appendChild(el("span", "kind", "apply failed"));
    box.appendChild(el("div", undefined, `${failure.text} ${failure.reason}`));
    const actions = el("div", "toolbar");
    actions.style.marginTop = "6px";
    const dismiss = button("Dismiss");
    dismiss.addEventListener("click", () => setApplyFailure(null));
    actions.appendChild(dismiss);
    box.appendChild(actions);
    noticesEl.appendChild(box);
  }

  if (model.storageError !== undefined) {
    const box = el("div", "entry");
    box.appendChild(el("span", "kind", "storage full"));
    box.appendChild(
      el(
        "div",
        undefined,
        "Couldn't save your edits — plugin storage is full. Your changes are still in this session. Copy the tree as JSON before closing the panel."
      )
    );
    noticesEl.appendChild(box);
  }

  // Staleness is stated, not hidden (UX §6.1). The absence of `⚑ changed` badges has to read as
  // "we last checked 12 minutes ago", not as a live guarantee — the architecture makes no such
  // promise, and a stale "in sync" claim is worse than no claim.
  if (model.ready) {
    const line = el("div", "empty");
    line.style.marginBottom = "6px";
    line.appendChild(document.createTextNode(`${scannedAgo(model.scannedAt)} · `));
    const rescan = el("button", "toast-action", "Rescan");
    rescan.style.color = "var(--accent-text)";
    rescan.addEventListener("click", () => send({ type: "scan" }));
    line.appendChild(rescan);
    noticesEl.appendChild(line);
  }

  const merge = model.merge;
  if (merge !== undefined && !bannerDismissed && merge.conflicts + merge.orphaned + merge.drifted > 0) {
    const box = el("div", "entry");
    const parts = [
      `${merge.applied} edit${merge.applied === 1 ? "" : "s"} reapplied`,
      `${merge.drifted} changed in Figma`,
      `${merge.conflicts} conflict${merge.conflicts === 1 ? "" : "s"}`,
      `${merge.orphaned} orphaned`,
    ];
    box.appendChild(el("span", "kind", parts.join(" · ")));
    const actions = el("div", "toolbar");
    const review = button("Review");
    review.addEventListener("click", () => {
      // Filters the tree to exactly the rows that need a decision (§5.5). Resolution happens in
      // the tree, at leisure — there is no wizard and no per-token prompt during the scan.
      filters.flaggedOnly = true;
      filters.query = "";
      renderTokens();
    });
    const dismiss = button("Dismiss");
    dismiss.addEventListener("click", () => {
      bannerDismissed = true;
      renderNotices();
    });
    actions.appendChild(review);
    actions.appendChild(dismiss);
    box.appendChild(actions);
    noticesEl.appendChild(box);
  }

  if (model.orphans.length > 0) noticesEl.appendChild(renderOrphans(model.orphans));

  // Search runs after the set filter, so a filtered tree searches only what it's showing. When a
  // query has hits in sets the filter is hiding, say so rather than silently under-reporting
  // (§4.6).
  const hidden = filters.query.trim().length > 0 ? hiddenMatches() : { count: 0, sets: 0 };
  if (hidden.count > 0) {
    const note = el("div", "empty");
    note.appendChild(
      document.createTextNode(
        `${hidden.count} more in ${hidden.sets} hidden set${hidden.sets === 1 ? "" : "s"} — `
      )
    );
    const show = el("button", "toast-action", "show all sets");
    show.style.color = "var(--accent-text)";
    show.addEventListener("click", () => {
      filters.sets = null;
      renderTokens();
    });
    note.appendChild(show);
    noticesEl.appendChild(note);
  }
}

/**
 * Orphaned edits sit **outside** the tree, pinned under the banner (§5.5).
 *
 * The token they changed has no live path to sit at any more. Discarding is the only way to clear
 * one — an edit can't be reapplied to something that doesn't exist — so the copy hands the value
 * back first rather than making the user retype it from a screenshot.
 */
function renderOrphans(orphans: OverlayEntry[]): HTMLElement {
  const details = el("details", "file");
  details.appendChild(
    el("summary", undefined, `${orphans.length} orphaned edit${orphans.length === 1 ? "" : "s"}`)
  );

  for (const entry of orphans) {
    const box = el("div", "entry");
    box.appendChild(el("span", "kind", "⚠ orphaned-edit"));
    box.appendChild(el("div", "mono", `${entry.path} (was ${entry.set})`));
    box.appendChild(
      el(
        "div",
        undefined,
        `The ${entry.target.styleId !== undefined ? "Style" : "Variable"} this edit changed was deleted in Figma. Your value: ${describeValue(entry)}`
      )
    );
    const actions = el("div", "toolbar");
    const copyValue = button("Copy value");
    copyValue.addEventListener("click", () => copy(describeValue(entry), "the orphaned value"));
    const discard = button("Discard edit");
    discard.addEventListener("click", () => revert([entry.target], entry.op));
    actions.appendChild(copyValue);
    actions.appendChild(discard);
    box.appendChild(actions);
    details.appendChild(box);
  }

  return details;
}

/** "Scanned 12 minutes ago" — deliberately relative, because the point is the staleness. */
function scannedAgo(iso: string): string {
  if (iso === "") return "Not scanned yet";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Scanned earlier";
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return "Scanned just now";
  if (minutes === 1) return "Scanned 1 minute ago";
  if (minutes < 60) return `Scanned ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Scanned ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Scanned ${days} day${days === 1 ? "" : "s"} ago`;
}

function describeValue(entry: OverlayEntry): string {
  if (entry.value === undefined) return "(deleted)";
  return typeof entry.value === "object" ? JSON.stringify(entry.value) : String(entry.value);
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function renderTree(): void {
  const model = getModel();
  clear(canvasEl);
  placed = [];
  lastWindow = "";

  if (!model.ready) {
    canvasEl.appendChild(emptyState(model.overlay.entries.length));
    canvasEl.style.height = "auto";
    return;
  }

  const rows = visibleRows();
  if (rows.length === 0) {
    canvasEl.appendChild(noResults());
    canvasEl.style.height = "auto";
    return;
  }

  const byKey = new Map(rows.map((row) => [row.row.key, row] as const));
  const searching = filters.query.trim().length > 0;

  let top = 0;
  const place = (row: Row, depth: number): void => {
    const height =
      row.lines.length === 1
        ? SINGLE_HEIGHT
        : NAME_LINE_HEIGHT + VALUE_LINE_HEIGHT * row.lines.length;
    placed.push({ top, height, depth, row });
    top += height;
  };

  if (searching) {
    // Hierarchy stops being the point once you've typed: the tree flattens to a result list of
    // full dotted paths, group headers gone (§4.6).
    for (const row of rows) place(row, 0);
  } else {
    if (!expansionSeeded) {
      for (const node of model.tree) {
        if (node.kind === "group") expanded.add(node.path);
      }
      expansionSeeded = true;
    }
    const walk = (nodes: TreeNode[], depth: number): void => {
      for (const node of nodes) {
        if (node.kind === "token") {
          const row = byKey.get(normalizePathKey(node.path));
          if (row !== undefined) place(row, depth);
          continue;
        }
        const filtered = filterGroup(node, byKey);
        if (filtered === null) continue;
        placed.push({ top, height: GROUP_HEIGHT, depth, group: filtered });
        top += GROUP_HEIGHT;
        if (expanded.has(node.path)) walk(node.children, depth + 1);
      }
    };
    walk(model.tree, 0);
  }

  canvasEl.style.height = `${top}px`;
  // A filter that shrinks the tree can leave the scroll position past the end, which paints the
  // last few rows and nothing else. Reset rather than clamp: after a filter change, the top is
  // where the user wants to be anyway.
  if (scrollEl.scrollTop > Math.max(0, top - scrollEl.clientHeight)) scrollEl.scrollTop = 0;
  paint(true);
}

/**
 * A group's descendant path count under the current filters.
 *
 * Recomputed rather than read off `pathCount`: with a set or type filter on, the count baked into
 * the tree is the unfiltered one, and a group row claiming 287 while showing 4 is a lie the user
 * has no way to check.
 */
function filterGroup(node: GroupNode, byKey: Map<string, Row>): GroupNode | null {
  let count = 0;
  const walk = (nodes: TreeNode[]): void => {
    for (const child of nodes) {
      if (child.kind === "token") {
        if (byKey.has(normalizePathKey(child.path))) count += 1;
      } else {
        walk(child.children);
      }
    }
  };
  walk(node.children);
  if (count === 0) return null;
  return { ...node, pathCount: count };
}

function paint(force: boolean): void {
  if (placed.length === 0) return;
  const top = scrollEl.scrollTop;
  const bottom = top + scrollEl.clientHeight;

  const first = Math.max(0, lowerBound(top) - OVERSCAN);
  let last = first;
  while (last < placed.length && placed[last].top < bottom) last += 1;
  last = Math.min(placed.length, last + OVERSCAN);

  const signature = `${first}:${last}`;
  if (!force && signature === lastWindow) return;
  lastWindow = signature;

  clear(canvasEl);
  for (let index = first; index < last; index += 1) {
    const item = placed[index];
    const node = item.group !== undefined ? groupRow(item) : tokenRow(item);
    node.style.top = `${item.top}px`;
    node.style.height = `${item.height}px`;
    canvasEl.appendChild(node);
  }
}

/** First index whose row bottom is past `offset`. */
function lowerBound(offset: number): number {
  let low = 0;
  let high = placed.length - 1;
  let found = placed.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (placed[mid].top + placed[mid].height > offset) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

function indent(depth: number): string {
  return `${12 + depth * 10}px`;
}

function groupRow(item: Placed): HTMLElement {
  const group = item.group as GroupNode;
  const node = el("div", "tnode group");
  node.style.paddingLeft = indent(item.depth);

  const line = el("div", "tline head");
  const open = expanded.has(group.path);
  line.appendChild(el("span", "caret", open ? "▾" : "▸"));
  line.appendChild(el("span", "tname group-name", group.name));

  if (groupHasFlag(group)) line.appendChild(el("span", "badge needs", "⚑"));
  line.appendChild(el("span", "count-right", String(group.pathCount)));

  const menu = el("button", "menu-btn", "⋯");
  menu.title = "Group actions";
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    popover(menu, (close) => groupMenu(group, close));
  });
  line.appendChild(menu);

  node.appendChild(line);
  node.addEventListener("click", () => {
    if (expanded.has(group.path)) expanded.delete(group.path);
    else expanded.add(group.path);
    renderTree();
  });
  return node;
}

function groupHasFlag(group: GroupNode): boolean {
  const model = getModel();
  const prefix = `${normalizePathKey(group.path)}.`;
  for (const row of model.rows) {
    if (!row.row.key.startsWith(prefix)) continue;
    for (const line of row.lines) {
      if (line.flags.length > 0 || line.conflict !== undefined) return true;
    }
  }
  return false;
}

function groupMenu(group: GroupNode, close: () => void): HTMLElement {
  const wrap = el("div");
  const rows = pathsUnder(group.path);
  const lines: Line[] = [];
  for (const each of rows) lines.push(...each.lines);
  const paths = rows.map((row) => row.row.path);
  const block = deleteBlockers(paths);

  const del = el("button", "item") as HTMLButtonElement;
  del.textContent =
    block.count > 0
      ? `Delete ${group.name} — ${block.count} external reference${block.count === 1 ? "" : "s"}`
      : `Delete ${group.name} and its ${rows.length} token${rows.length === 1 ? "" : "s"}`;
  del.addEventListener("click", () => {
    close();
    // The label's count is from when the menu opened; `runDelete` re-checks at the moment of the
    // write, which is the check that decides (§7).
    runDelete(lines, paths, `${group.name} — ${rows.length} tokens`);
  });
  wrap.appendChild(del);

  if (lines.some((each) => each.edited)) {
    const apply = el("button", "item", `Apply ${group.name}`) as HTMLButtonElement;
    apply.addEventListener("click", () => {
      close();
      applyLines(lines, `Apply ${group.path}`);
    });
    wrap.insertBefore(apply, del);
  }

  wrap.appendChild(el("div", "divider"));
  const inFigma = el("button", "item danger", "Delete in Figma…") as HTMLButtonElement;
  inFigma.addEventListener("click", () => {
    close();
    openDeleteInFigma(lines, { navigate: revealPath, onClose: () => renderTokens() });
  });
  wrap.appendChild(inFigma);

  return wrap;
}

// ---------------------------------------------------------------------------
// Token rows — §4.2
// ---------------------------------------------------------------------------

function tokenRow(item: Placed): HTMLElement {
  const row = item.row as Row;
  const node = el("div", "tnode token");
  node.style.paddingLeft = indent(item.depth);
  const searching = filters.query.trim().length > 0;
  const leaf = searching ? row.row.path : row.row.segments[row.row.segments.length - 1];

  if (row.lines.length === 1) {
    // The majority case, and the one the merge must not make more expensive: one line, exactly
    // the row that existed before, plus a muted set code (§4.2).
    const line = row.lines[0];
    const container = el("div", "tline");
    container.appendChild(typeGlyph(line));
    const name = el("span", "tname");
    name.appendChild(highlight(leaf, filters.query.trim()));
    name.title = row.row.path;
    name.addEventListener("click", () => openDetail(row.row.key, line.entry.setId));
    container.appendChild(name);
    appendValue(container, line, row);
    container.appendChild(setCode(line));
    container.appendChild(rowMenu(row, line));
    node.appendChild(container);
    return node;
  }

  const head = el("div", "tline head");
  // When two sets disagree on `$type` the shared glyph drops and each value line carries its own
  // (§4.2). A visual signal that these are not really the same token — not an error we have a
  // vocabulary for, so no badge and no report kind.
  if (!hasMixedTypes(row.row)) head.appendChild(typeGlyph(row.lines[0]));
  const name = el("span", "tname");
  name.appendChild(highlight(leaf, filters.query.trim()));
  name.title = row.row.path;
  head.appendChild(name);
  head.appendChild(rowMenu(row));
  head.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".menu-btn") === null) openDetail(row.row.key);
  });
  node.appendChild(head);

  for (const line of row.lines) {
    const value = el("div", "vline");
    value.style.paddingLeft = "16px";
    value.appendChild(setCode(line));
    if (hasMixedTypes(row.row)) value.appendChild(typeGlyph(line));
    appendValue(value, line, row);
    value.appendChild(rowMenu(row, line));
    node.appendChild(value);
  }

  return node;
}

function typeGlyph(line: Line): HTMLElement {
  const glyph = el("span", "glyph", GLYPHS[line.entry.token.$type] ?? "•");
  glyph.title = line.entry.token.$type;
  return glyph;
}

function setCode(line: Line): HTMLElement {
  const code = el("span", line.set.source === "styles" ? "setcode derived" : "setcode", line.set.code);
  code.title = line.set.label;
  return code;
}

/**
 * The one colour chip in the token list: checkerboard base under a full-opacity fill. Literal and
 * reference values share it, so the two cannot drift apart into different treatments (§4.5).
 */
function colorSwatch(color: string): HTMLElement {
  const wrap = el("span", "swatch-wrap");
  wrap.appendChild(el("span", "swatch"));
  const fill = el("span", "swatch-fill");
  fill.style.background = color;
  wrap.appendChild(fill);
  return wrap;
}

function appendValue(container: HTMLElement, line: Line, row: Row): void {
  const resolution = resolutionFor(line);
  // A composite renders its **resolved** summary (UX §14.5): `Urbanist 20/24 · 500`, not the 140
  // characters of raw paths its `$value` holds. Members that don't resolve come through as `—`,
  // which `previewOf` produces from the substituted value rather than from a second rule here.
  const preview = previewOf(
    line.entry.token,
    resolution.kind === "composite" ? resolution.value : undefined
  );

  // §7.3b — a token on a loop carries `⚑ cycle` on its value line and its preview is `—`. No
  // number, no swatch, no stale value: a silently wrong number is strictly worse than a visible
  // error, and the whole point of a derived value is that it wasn't typed (§7.1).
  if (resolution.kind === "cycle") {
    const dash = el("span", "val readonly", "—");
    dash.title = "This token is part of a loop, so it has no value.";
    dash.addEventListener("click", (event) => {
      event.stopPropagation();
      openDetail(row.row.key, line.entry.setId);
    });
    container.appendChild(dash);
    container.appendChild(el("span", "badge needs", "⚑ cycle"));
    return;
  }

  if (preview.swatch !== undefined) {
    container.appendChild(colorSwatch(preview.swatch));
  } else if (preview.reference !== undefined && line.entry.token.$type === "color") {
    // `previewOf` is pure over the token, so a pointer never carries a `swatch` — the colour it
    // lands on only exists on the resolution, which is why this stays its own branch. What it is
    // *not* is a different swatch: a reference paints at full opacity with a solid ring, exactly
    // like a literal (§4.5, amended). The `↗` and the value text already say "pointer"; fading the
    // fill only made the ends of a scale — near-white, near-black — read as the wrong colour.
    if (typeof resolution.value === "string") {
      container.appendChild(colorSwatch(resolution.value));
    } else {
      // Nothing resolves, so there is no colour to show: the dashed outline is the whole mark.
      const wrap = el("span", "swatch-wrap");
      wrap.appendChild(el("span", "swatch outlined"));
      container.appendChild(wrap);
    }
  }

  // A token with no overlay target has nothing to key an edit on (ADR-0004 §2), so it reads as
  // read-only here and says why when clicked — the alternative is an input that accepts a value
  // and silently reverts it.
  const blocked = editBlockedReason(line);
  // A pointer or a formula is no longer read-only (§12 lifts local-editor §5.3), but it does not
  // edit *inline*: the picker, the resolve line and the four rules need the detail overlay's room.
  const readOnly = blocked !== null || preview.reference !== undefined || isComposite(line);
  const value = el(
    "span",
    `val${readOnly ? " readonly" : ""}${line.edited ? " edited" : ""}`,
    preview.text
  );
  value.title = blocked !== null ? blocked : readOnly ? preview.text : `${preview.text} — click to edit`;
  value.addEventListener("click", (event) => {
    event.stopPropagation();
    if (blocked !== null) toast(blocked);
    else if (readOnly) openDetail(row.row.key, line.entry.setId);
    else startInlineEdit(value, line);
  });
  container.appendChild(value);

  if (preview.reference !== undefined) {
    // Dangling means *in no set at all* — the import-side `dangling-reference` (ADR-0002
    // Amendment 1 §G). A target that exists but doesn't resolve in the active theme is
    // `⚑ unresolved` above, which is frequently the correct state of a correct token (§5.4).
    const dangling = !getModel().byPath.has(normalizePathKey(preview.reference));
    const glyph = el("span", dangling ? "badge needs" : "glyph", dangling ? "⚠" : "↗");
    glyph.title = dangling
      ? `Points at ${preview.reference}, which isn't in any set.`
      : `Points at ${preview.reference}`;
    container.appendChild(glyph);
  }

  // §6.3 — an expression reads as the string, with the computed number muted beneath it. Primary,
  // not the number: the tree is a view of the token *file*, and the file holds the string
  // (ADR-0007 §2). A tree showing `32` would be showing something that exists nowhere on disk.
  //
  // There is deliberately **no new glyph for an expression**, and the absence is the signal. What
  // an expression risks being mistaken for is a *link*, so the honest mark is the missing `↗`.
  // §14.5 — one trailing `↗` on a composite whose members point somewhere. No new glyph and no new
  // colour: `↗` already exists and already means *some part of this points elsewhere*. Which parts
  // is the overlay's answer, which is where composites have always been edited.
  if (preview.memberPointer === true) {
    const glyph = el("span", "glyph", "↗");
    glyph.title = "Some fields of this token point at other tokens. Open it to see which.";
    container.appendChild(glyph);
  }

  if (resolution.kind === "composite") {
    // §14.6 — the *member* is valueless, not the token, so the badge sits beside a preview that
    // still shows the four members that are fine. The header count is unchanged: it counts loops.
    const cycled = (resolution.members ?? []).filter((one) => one.resolution.kind === "cycle");
    const unresolved = (resolution.members ?? []).filter(
      (one) => one.resolution.kind === "unresolved"
    );
    if (cycled.length > 0) {
      const badge = el("span", "badge needs", "⚑ cycle");
      badge.title = `${cycled.map((one) => one.slot.label).join(", ")} ${cycled.length === 1 ? "is" : "are"} part of a loop, so ${cycled.length === 1 ? "it has" : "they have"} no value.`;
      container.appendChild(badge);
    } else if (unresolved.length > 0) {
      const badge = el("span", "badge needs", "⚑ unresolved");
      badge.title = `${unresolved.map((one) => one.slot.label).join(", ")} ${unresolved.length === 1 ? "points" : "point"} at something with no value in the active theme. Nothing is broken.`;
      container.appendChild(badge);
    }
  } else if (resolution.kind === "expression") {
    container.appendChild(el("span", "muted", `= ${String(resolution.value)}`));
  } else if (resolution.kind === "unresolved") {
    const badge = el("span", "badge needs", "⚑ unresolved");
    badge.title = `${resolution.target ?? "The target"} has no value in the active theme. Nothing is broken — this token just has no value while that theme is on.`;
    container.appendChild(badge);
  } else if (resolution.kind === "error") {
    const badge = el("span", "badge needs", "⚑ expression");
    badge.title = resolution.error?.message ?? "This expression can't be worked out.";
    container.appendChild(badge);
  }

  if (line.conflict !== undefined) container.appendChild(el("span", "badge needs", "⚑ conflict"));
  for (const flag of line.flags) {
    const badge = el("span", "badge needs", shortKind(flag.kind));
    badge.title = flag.message;
    container.appendChild(badge);
  }

  const extension = line.entry.token.$extensions?.["com.tokenvault"];
  if (extension?.subtype !== undefined) {
    const tag = el("span", extension.subtypeSource === "default" ? "badge needs" : "badge", extension.subtype);
    if (extension.subtypeSource === "default") tag.title = "Guessed. Confirm it on the Import tab.";
    container.appendChild(tag);
  }
}

function isComposite(line: Line): boolean {
  const type = line.entry.token.$type;
  return type === "typography" || type === "shadow" || type === "grid";
}

/**
 * The one lowercase word next to the flag.
 *
 * `⚑ changed`, `⚑ conflict`, `⚑ orphaned` share a mark and are told apart by a single word — which
 * is what makes one badge colour survive seven meanings (UX §6.2). Phase 5 adds three words and no
 * new glyph, no new colour, and no drift tab: a second attention mark would force the user to parse
 * two vocabularies at a glance in a 460px column, which is exactly the failure the single `⚑` was
 * designed to avoid.
 */
function shortKind(kind: string): string {
  if (kind === "partial-token") return "partial";
  if (kind === "dangling-reference") return "dangling";
  if (kind === "redundant-style") return "redundant";
  if (kind === "edit-conflict") return "conflict";
  if (kind === "orphaned-edit") return "orphaned";
  if (kind === "drift-value") return "changed";
  if (kind === "drift-added") return "added";
  if (kind === "drift-removed") return "removed";
  if (kind === "reference-cycle") return "cycle";
  if (kind === "expression-error") return "expression";
  if (kind === "unresolved-in-theme") return "unresolved";
  return kind;
}

/**
 * Inline editing on the value line (§5.1).
 *
 * Click the value, it becomes an input in place; Enter or blur commits, Escape reverts. On a
 * multi-set path each line edits **its own set's token** — editing `Dark` never touches `Light`,
 * which is the merged view's main payoff.
 */
function startInlineEdit(anchor: HTMLElement, line: Line): void {
  const token = line.entry.token;

  if (token.$type === "boolean") {
    const select = el("select", "inline-edit") as HTMLSelectElement;
    select.appendChild(new Option("true", "true"));
    select.appendChild(new Option("false", "false"));
    select.value = String(token.$value === true);
    anchor.replaceWith(select);
    select.focus();
    select.addEventListener("change", () => {
      const error = editValue(line, select.value === "true");
      if (error !== null) toast(error);
    });
    select.addEventListener("blur", () => renderTree());
    return;
  }

  const input = el("input", "inline-edit") as HTMLInputElement;
  input.type = "text";
  input.value = String(token.$value);
  anchor.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    if (!commit) {
      done = true;
      renderTree();
      return;
    }
    const parsed =
      token.$type === "color"
        ? parseHexColor(input.value)
        : token.$type === "number"
          ? parseNumberValue(input.value)
          : parseStringValue(input.value);
    if (!parsed.ok) {
      // The edit stays open and the value is not committed (§8) — losing what was typed to a
      // typo is worse than an amber field.
      input.classList.add("invalid");
      input.title = parsed.message;
      toast(parsed.message);
      return;
    }
    const error = editValue(line, parsed.value);
    if (error !== null) {
      input.classList.add("invalid");
      input.title = error;
      toast(error);
      return;
    }
    done = true;
    // An unchanged value records nothing, so no model change comes back to close the editor —
    // repaint here rather than leaving the row stuck as an input.
    renderTree();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function rowMenu(row: Row, line?: Line): HTMLElement {
  const menu = el("button", "menu-btn", "⋯");
  menu.title = line === undefined ? "Path actions" : `${line.set.code} actions`;
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    popover(menu, (close) => {
      const wrap = el("div");

      const edit = el("button", "item", "Edit") as HTMLButtonElement;
      edit.addEventListener("click", () => {
        close();
        openDetail(row.row.key, line?.entry.setId);
      });
      wrap.appendChild(edit);

      const lines = line === undefined ? row.lines : [line];

      // UX §5.3: the same dialog, differently pre-populated. A value line applies that one target;
      // a path name applies every set's target for that path.
      if (lines.some((each) => each.edited)) {
        const apply = el("button", "item", "Apply") as HTMLButtonElement;
        apply.addEventListener("click", () => {
          close();
          applyLines(lines, `Apply ${row.row.path}`);
        });
        wrap.appendChild(apply);
      }

      if (lines.some((each) => each.drift !== undefined)) {
        const accept = el("button", "item", "Take Figma's change") as HTMLButtonElement;
        accept.addEventListener("click", () => {
          close();
          const keys = lines
            .filter((each) => each.drift !== undefined && each.key !== null)
            .map((each) => each.key as string);
          dismissDrift(keys);
          toast("Accepted Figma's change.");
        });
        wrap.appendChild(accept);
      }

      if (lines.some((each) => each.edited)) {
        const revertItem = el("button", "item", "Revert to imported value") as HTMLButtonElement;
        revertItem.addEventListener("click", () => {
          close();
          const targets = lines
            .map((each) => each.target)
            .filter((target): target is OverlayTarget => target !== null);
          revert(targets);
          toast("Reverted to the imported value");
        });
        wrap.appendChild(revertItem);
      }

      const del = deleteButton(
        lines,
        line === undefined
          ? {
              action: `Delete from all ${row.lines.length} sets`,
              subject: `${row.row.path} from all ${row.lines.length} sets`,
            }
          : { action: `Delete in ${line.set.code}`, subject: `${row.row.path} in ${line.set.code}` }
      );
      del.className = "item";
      del.addEventListener("click", () => closePopover());
      wrap.appendChild(del);

      // Below a divider, red, with a trailing ellipsis — everything about it says "a different
      // kind of thing" so it can never be mis-tapped as the row above (UX §5.7).
      wrap.appendChild(el("div", "divider"));
      const inFigma = el("button", "item danger", "Delete in Figma…") as HTMLButtonElement;
      inFigma.addEventListener("click", () => {
        close();
        openDeleteInFigma(lines, { navigate: revealPath, onClose: () => renderTokens() });
      });
      wrap.appendChild(inFigma);

      return wrap;
    });
  });
  return menu;
}

// ---------------------------------------------------------------------------
// Navigation and empty states
// ---------------------------------------------------------------------------

/** Expands the ancestors of a path and scrolls it into view — the `Go to target` action (§5.3). */
export function revealPath(path: string): void {
  closeDetail();
  filters.query = "";
  filters.flaggedOnly = false;
  filters.sets = null;
  filters.types = null;

  const segments = path.split(".");
  for (let i = 1; i < segments.length; i += 1) expanded.add(segments.slice(0, i).join("."));
  expansionSeeded = true;
  renderTokens();

  const key = normalizePathKey(path);
  const index = placed.findIndex((item) => item.row?.row.key === key);
  if (index === -1) {
    toast(`${path} isn't in any set`);
    return;
  }
  scrollEl.scrollTop = Math.max(0, placed[index].top - 60);
  paint(true);
}

function emptyState(edits: number): HTMLElement {
  const wrap = el("div");
  wrap.style.padding = "16px 12px";
  if (edits > 0) {
    // Never let this read as "your edits are gone": the overlay is durable and the import is the
    // part that's re-derivable (ADR-0004 §1, UX §8).
    wrap.appendChild(el("p", undefined, "Scan the file to see your tokens."));
    wrap.appendChild(
      el(
        "p",
        "empty",
        `Your ${edits} local edit${edits === 1 ? " is" : "s are"} still here and will reapply after the scan.`
      )
    );
  } else {
    wrap.appendChild(el("p", undefined, "No tokens yet."));
    wrap.appendChild(
      el("p", "empty", "Scan the file on the Import tab to read its Variables and Styles.")
    );
  }
  const go = button("Go to Import", "primary");
  go.addEventListener("click", () => goToImport());
  wrap.appendChild(go);
  return wrap;
}

function noResults(): HTMLElement {
  const model = getModel();
  const wrap = el("div");
  wrap.style.padding = "16px 12px";
  const query = filters.query.trim();
  const hidden = hiddenMatches();

  if (model.rows.length === 0) {
    wrap.appendChild(el("p", undefined, "Nothing importable in this file."));
    wrap.appendChild(
      el("p", "empty", "No Variables or Styles mapped to a token — see the Import tab's report for what was skipped.")
    );
    return wrap;
  }

  if (query.length > 0) {
    if (hidden.count > 0) {
      wrap.appendChild(
        el("p", undefined, `No tokens match "${query}" in the ${filters.sets?.size ?? 0} sets you've selected.`)
      );
      const all = button("Search all sets");
      all.addEventListener("click", () => {
        filters.sets = null;
        renderTokens();
      });
      wrap.appendChild(all);
      return wrap;
    }
    wrap.appendChild(el("p", undefined, `No tokens match "${query}".`));
    wrap.appendChild(el("p", "empty", "Search covers token paths and descriptions."));
    return wrap;
  }

  if (filters.flaggedOnly) {
    wrap.appendChild(el("p", undefined, "Nothing flagged."));
  } else if (filters.sets !== null) {
    wrap.appendChild(el("p", undefined, "No tokens in the sets you've selected."));
  } else {
    wrap.appendChild(el("p", undefined, "No tokens match your filters."));
  }

  const reset = button("Clear filters");
  reset.addEventListener("click", () => {
    filters.sets = null;
    filters.types = null;
    filters.flaggedOnly = false;
    filters.query = "";
    renderTokens();
  });
  wrap.appendChild(reset);
  return wrap;
}

// The local-edits list moved to `changes.ts` in Phase 5.
//
// Phase 4's popover became the "Local" section of the Changes list (UX apply-and-drift §6.3),
// which grew a second and third section for drift and conflicts. Keeping the popover alongside it
// would have left two surfaces answering "what have I actually changed?" with two implementations
// that could disagree — and only one of them could offer Apply.
