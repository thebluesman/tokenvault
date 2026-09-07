// The one value field, and the pieces that hang off it — UX references-math-themes §4, §5, §6, §7.
//
// Phases 4, 5 and 6 all shipped the same sentence in different words: *the panel renders a
// reference, badges it, and refuses to edit it.* This module deletes that sentence.
//
// The load-bearing decision is §4.1's: **there is no reference / literal / expression toggle.** A
// mode switch would ask the user to classify a value before typing it, when the parser classifies
// it perfectly well afterwards — and a UI toggle would be a second, hand-maintained classifier that
// can disagree with `references.ts` + `expr.ts`. It also breaks the commonest real edit: pasting a
// path over a hex value, which under a toggle is *switch mode, then paste*.
//
// Four components live here, and three of them are shared by more than one caller:
//
//   - the committing field itself, with the four authoring rules on commit (§5);
//   - the path picker, on `{`, with its three groups (§4.2);
//   - the resolve line — `= 32 · applies as a number, not a link` (§6.2);
//   - the cycle block, one component with three callers (§7.2).

import type { FlatToken } from "../tokens/view";
import type { Cycle } from "../tokens/graph";
import type { AuthorOutcome, ResolveContext } from "../tokens/resolve";
import type { Line } from "./state";
import { checkAuthoredValue, resolveValue, referencePathsOf } from "../tokens/resolve";
import { cycleFromCandidate, describeCycle, graphNodeKey } from "../tokens/graph";
import { looksLikeExpression, noOpReferenceIn, valueShape } from "../tokens/expr";
import { isReference, referenceTarget } from "../tokens/references";
import type { MemberAccepts, MemberType } from "../tokens/members";
import { normalizePathKey } from "../tokens/paths";
import { getModel } from "./state";
import { previewOf, truncateReference } from "../tokens/preview";
import { button, el, swatch } from "./dom";

// ---------------------------------------------------------------------------
// The resolve line — §6.2
// ---------------------------------------------------------------------------

/**
 * One muted line beneath the field, for **every** non-literal value.
 *
 * The phase's smallest component, doing most of its work. Two halves, both deliberate:
 *
 *   - **the number**, because without it the user is doing arithmetic in their head to check the
 *     tool's arithmetic;
 *   - **the clause after the middot**, which is where the live-link difference lives — a reference
 *     says what it follows, an expression says what it doesn't. Stated as a plain fact in grey
 *     rather than as a warning in amber, because neither needs the user to do anything.
 *
 * Absent for a literal, and absent while an expression is incomplete: a half-typed value is not an
 * error yet (§5, §6.2).
 */
export function resolveLine(raw: string, type: string, context: ResolveContext): HTMLElement | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const shape = valueShape({ $type: type as never, $value: trimmed as never });
  if (shape === "literal") return null;

  const resolved = resolveValue({ $type: type as never, $value: trimmed as never }, context);
  const line = el("div", "resolve-line");

  if (resolved.kind === "reference") {
    line.appendChild(el("span", undefined, `= ${describeResolved(resolved.value)}`));
    line.appendChild(
      el("span", "muted", ` · follows ${resolved.target ?? ""} in Figma`)
    );
    return line;
  }

  if (resolved.kind === "expression") {
    line.appendChild(el("span", undefined, `= ${describeResolved(resolved.value)}`));
    line.appendChild(el("span", "muted", " · applies as a number, not a link"));
    return line;
  }

  if (resolved.kind === "unresolved") {
    line.appendChild(
      el("span", "muted", `${resolved.target ?? "That token"} has no value in the active theme.`)
    );
    return line;
  }

  // A parse or evaluation failure while typing is not yet an error the user needs shouting at —
  // §5's rule that validation fires on commit, not per keystroke. The line simply goes quiet.
  return null;
}

function describeResolved(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // A composite member's target is frequently a dimension, and `{"unit":"px","value":20}` is a
  // worse answer than `20px` to *what does this come out as* (§14.1 — a member field is an ordinary
  // value field, so its resolve line has to read like one).
  if (value !== null && typeof value === "object") {
    const record = value as { unit?: unknown; value?: unknown };
    if (typeof record.value === "number" && typeof record.unit === "string") {
      return `${record.value}${record.unit}`;
    }
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// The cycle block — §7.2. One component, three callers.
// ---------------------------------------------------------------------------

export interface CycleBlockOptions {
  /** Marks the row the user just typed, at authoring time (§7.3a). */
  candidateEdge?: { fromPath: string; toPath: string };
  /** Navigates to a token. Every path in the block is a tap target (§7.2). */
  navigate?: (path: string) => void;
}

/**
 * The loop, rendered.
 *
 * Two sentences, and both are load-bearing. The first explains why every value in the loop is
 * blank, which pre-empts *"but `space.b` used to be 8"*. The second is the fix, and it deliberately
 * says *any one*, because the user's instinct will be to look for the culprit.
 *
 * It does not truncate. A loop is normally 2–4 long, and the case where it is 15 long is exactly
 * the case where the user needs the whole thing.
 */
export function cycleBlock(
  cycle: Cycle,
  context: ResolveContext,
  options: CycleBlockOptions = {}
): HTMLElement {
  const box = el("div", "entry cycle-block");
  box.appendChild(el("span", "kind", "⚑ These tokens point in a loop"));

  const steps = describeCycle(context.graph, cycle);
  const list = el("div", "cycle-steps");

  for (const step of steps) {
    const row = el("div", "cycle-step");
    row.appendChild(pathTarget(step.from.path, options.navigate));
    row.appendChild(el("span", "muted", "→"));
    row.appendChild(pathTarget(step.to.path, options.navigate));
    // The `↵` marks the closing edge, which is the one piece of information that makes three lines
    // read as a loop rather than a chain. A shape cue, not a target — there is nothing to do to it.
    if (step.closing) row.appendChild(el("span", "muted", "↵"));
    if (
      options.candidateEdge !== undefined &&
      normalizePathKey(step.from.path) === normalizePathKey(options.candidateEdge.fromPath) &&
      normalizePathKey(step.to.path) === normalizePathKey(options.candidateEdge.toPath)
    ) {
      row.appendChild(el("span", "muted", "(what you just typed)"));
    }
    list.appendChild(row);
  }

  // A self-reference renders identically with one row — same block, same copy, no special case.
  box.appendChild(list);
  box.appendChild(
    el(
      "div",
      "empty",
      "Nothing in the loop has a value, because each one is waiting on the next. Editing any one of them breaks it."
    )
  );
  return box;
}

function pathTarget(path: string, navigate?: (target: string) => void): HTMLElement {
  if (navigate === undefined) return el("span", undefined, path);
  const link = button(path, "toast-action");
  link.style.color = "var(--accent-text)";
  link.addEventListener("click", () => navigate(path));
  return link;
}

// ---------------------------------------------------------------------------
// The path picker — §4.2
// ---------------------------------------------------------------------------

interface PickerRow {
  path: string;
  preview: string;
  swatch?: string;
  type: string;
}

interface PickerGroups {
  usable: PickerRow[];
  wrongType: PickerRow[];
  wouldLoop: PickerRow[];
}

/**
 * Three groups, and the incompatible one is **shown rather than filtered out**.
 *
 * Hiding a path the user knows exists produces *"why can't I find my token"*, which is a worse five
 * seconds than seeing it greyed with its type beside it. The greyed rows are not selectable, so
 * rule 2 never has to fire from the picker — only from a pasted or typed path.
 *
 * The third group is computed with the **editor-scoped** cycle check over the edited token's
 * reachable set (ADR-0007 §3), which is what makes it affordable per keystroke at 1,316 tokens —
 * and it turns the most confusing refusal in the phase into a thing you simply can't tap.
 */
export function pickerGroups(
  entry: FlatToken,
  query: string,
  context: ResolveContext,
  accepted: Set<string>
): PickerGroups {
  const needle = query.trim().toLowerCase();
  const from = graphNodeKey(entry.setId, entry.path);
  const groups: PickerGroups = { usable: [], wrongType: [], wouldLoop: [] };
  const seen = new Set<string>();

  for (const [key, anywhere] of context.everywhere) {
    if (seen.has(key)) continue;
    // The active theme's answer where it has one. `everywhere` keeps one token per path and which
    // one is iteration order, so a path two sets define with different `$type`s would otherwise be
    // grouped and previewed as whichever set was scanned first — independent of what the theme the
    // user is looking at actually resolves it to (ADR-0007 §3).
    const target = context.stack.get(key) ?? anywhere;
    // Substring over the full dotted path, case-insensitive — Phase 4 §4.6's rule, not a second
    // one. Paths this structured make fuzzy matching noise.
    if (needle.length > 0 && target.path.toLowerCase().indexOf(needle) === -1) continue;
    seen.add(key);

    const resolved = resolveValue(target.token, context);
    // The resolution is already in hand one line up, so the picker's composite rows read
    // `Urbanist 20/24 · 500` like every other surface rather than `Urbanist —/24 · 500` for a member
    // that resolves perfectly well. `previewOf`'s no-context contract is for callers that genuinely
    // have none — a diff, a fixture — and this is not one of them.
    const preview = previewOf(target.token, resolved.kind === "composite" ? resolved.value : undefined);
    const row: PickerRow = {
      path: target.path,
      preview:
        resolved.kind === "expression" || resolved.kind === "reference"
          ? describeResolved(resolved.value)
          : preview.text,
      swatch: preview.swatch,
      type: target.token.$type,
    };

    if (cycleFromCandidate(context.graph, from, [target.path]) !== null) {
      groups.wouldLoop.push(row);
      continue;
    }
    // Mirrors `checkAuthoredValue`'s rule 2 exactly, including its out-of-stack branch, so the
    // picker never offers a path the field would then refuse and never greys out one it would take.
    const types =
      context.stack.has(key)
        ? new Set([target.token.$type])
        : context.everywhereTypes.get(key) ?? new Set([target.token.$type]);
    // A set rather than one type, because a composite member can take more than one: `fontWeight` is
    // `number | string` (§14.2), so both are "can be used here" and rule 2 fires for the rest.
    const compatible = Array.from(types).some((one) => accepted.has(one));
    if (compatible) groups.usable.push(row);
    else groups.wrongType.push(row);

    if (groups.usable.length + groups.wrongType.length + groups.wouldLoop.length >= 60) break;
  }

  return groups;
}

/** The picker popover's body. Escape closes it without closing the field (§4.2). */
export function buildPicker(
  entry: FlatToken,
  query: string,
  accepted: Set<string>,
  choose: (path: string) => void
): HTMLElement {
  const model = getModel();
  const groups = pickerGroups(entry, query, model.resolve, accepted);
  const wanted = listAccepted(accepted);
  const wrap = el("div");

  if (groups.usable.length + groups.wrongType.length + groups.wouldLoop.length === 0) {
    wrap.appendChild(
      el("div", "empty", `No token path matches "${query.trim()}". Search covers every set.`)
    );
    return wrap;
  }

  if (groups.usable.length === 0 && groups.wrongType.length > 0) {
    wrap.appendChild(
      el(
        "div",
        "empty",
        `Nothing of type ${wanted} matches "${query.trim()}". The paths below are other types and can't be used here.`
      )
    );
  }

  appendGroup(wrap, `${wanted} — can be used here`, groups.usable, choose);
  appendGroup(wrap, "other types — can't be used here", groups.wrongType, undefined);
  appendGroup(wrap, "would make a loop", groups.wouldLoop, undefined);

  // Values resolve against the active theme, and the picker says so when there is more than one —
  // otherwise "which `spacing.4` is this?" has a silent answer (§4.2).
  if (model.themes.length > 1 && model.activeTheme !== null) {
    wrap.appendChild(el("div", "empty", `Values shown for ${model.activeTheme.name}.`));
  }
  return wrap;
}

/** `number`, `number or string` — the picker's own name for what this field takes. */
function listAccepted(accepted: Set<string>): string {
  const names = Array.from(accepted).sort();
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function appendGroup(
  wrap: HTMLElement,
  label: string,
  rows: PickerRow[],
  choose: ((path: string) => void) | undefined
): void {
  if (rows.length === 0) return;
  wrap.appendChild(el("div", "group-label", label));
  for (const row of rows) {
    const item = el("button", choose === undefined ? "item disabled" : "item") as HTMLButtonElement;
    if (choose === undefined) item.disabled = true;
    const name = el("span", undefined, truncateReference(row.path, 30));
    name.style.flex = "1";
    item.appendChild(name);
    if (row.swatch !== undefined) item.appendChild(swatch(row.swatch, false));
    item.appendChild(el("span", "count-right", row.preview));
    // `mousedown` is suppressed so the field never loses focus to the picker: a blur would run the
    // field's commit against the half-typed path the user is in the middle of replacing.
    item.addEventListener("mousedown", (event) => event.preventDefault());
    if (choose !== undefined) item.addEventListener("click", () => choose(row.path));
    wrap.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Committing — §5's four rules
// ---------------------------------------------------------------------------

/**
 * Runs ADR-0007 §5's four rules and, when they pass, commits through the caller's own writer.
 *
 * All four run **before** the overlay entry is written, which is what makes three of them refusals
 * rather than after-the-fact badges. The one that warns commits first and explains second, because
 * the user just did a legitimate thing and nothing needs them (§5.4).
 */
export function authorValue(
  line: Line,
  raw: string,
  member?: { key: string; type: MemberType; accepts: MemberAccepts }
): AuthorOutcome {
  const model = getModel();
  return checkAuthoredValue({
    entry: line.entry,
    raw,
    context: model.resolve,
    themeStacks: model.themeStacks,
    // §14.4: the same four rules, with rule 2 reading the **member's** type. Passing the spec down
    // rather than re-checking here is what keeps one rule set for scalars and members alike.
    member,
  });
}

/** True when the raw text is a pointer or a formula rather than a literal for the type's own parser. */
export function isNonLiteral(raw: string, type: string): boolean {
  // `isReference` is a `value is string` guard, so it has to be asked without narrowing the local.
  if (isReference(raw.trim())) return true;
  if (type !== "number") return false;
  // Asked of the grammar itself rather than of a regex here. A hand-rolled heuristic beside
  // `expr.ts` is a second classifier that can disagree with the parser it routes to, which is what
  // ADR-0007 §1 and UX §4.1 both refuse — one grammar, one definition of what an expression is.
  return looksLikeExpression(raw);
}

/**
 * The no-op nudge — UX §6.5, and the one place the editor steers toward a reference.
 *
 * It **offers**; it does not refuse and does not rewrite. The user may be mid-edit toward `* 1.5`,
 * and a tool that silently normalises what you typed is one you stop trusting with the things it
 * doesn't understand.
 */
export function noOpSwap(raw: string): string | null {
  return noOpReferenceIn(raw.trim());
}

/** `Use the resolved value instead` (§4.3) — worded as a choice, not as vandalism. */
export function resolvedLiteralFor(line: Line): string | null {
  const model = getModel();
  const resolved = resolveValue(line.entry.token, model.resolve);
  if (resolved.value === undefined) return null;
  if (typeof resolved.value === "number" || typeof resolved.value === "string") {
    return String(resolved.value);
  }
  return null;
}

/** The pointer a value carries, for the `↗ Go to target` affordance that survives from Phase 4. */
export function pointerTarget(raw: unknown): string | null {
  return referenceTarget(raw);
}

/** Every path a candidate value names — used to mark the closing edge in the block (§7.3a). */
export function candidatePaths(raw: string): string[] {
  return referencePathsOf(raw);
}
