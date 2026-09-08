// The token card's layout decisions — UX `edit-view-redesign.md`.
//
// Everything here is a *decision* the card makes about itself: what a field is called, whether two
// members share a line, whether the Figma disclosure opens itself, what a Figma scope enum reads as
// in English. None of it touches the DOM, which is the point — the card's shape is testable without
// a running panel, and `detail.ts` stays the file that only assembles nodes.
//
// Two rules this module is the keeper of:
//
//   1. **Labels are display strings, never schema keys** (§5.5). `memberLabel` answers the *label*
//      question and nothing else. Copy *about* the JSON — rule 2's refusal, `refuseSubKeyReference`,
//      §14.7's disagreement line, the `boundVariables` rows — keeps the key in mono and must never
//      be routed through this map, or the two drift and the copy starts naming a field the file
//      does not have.
//   2. **Scope humanising is a transform, not a table** (§6.3). An enum Figma adds next year still
//      has to render legibly, so there is no lookup to fall out of date.

import type { ShadowValue } from "../tokens/types";
import type { Resolution } from "../tokens/resolve";

/**
 * The human label for a composite member — §5.5, §8.
 *
 * One map across all three composites, because the keys don't collide and a per-type map would be
 * three places to forget. An unknown key falls back to a mechanical de-camelling rather than to the
 * raw key, so a schema addition reads as English on the day it lands.
 */
const MEMBER_LABELS: Record<string, string> = {
  fontFamily: "Font family",
  fontWeight: "Font weight",
  fontSize: "Font size",
  letterSpacing: "Letter spacing",
  lineHeight: "Line height",
  offsetX: "Offset X",
  offsetY: "Offset Y",
  blur: "Blur",
  spread: "Spread",
  color: "Color",
  inset: "Inset",
  pattern: "Pattern",
  count: "Count",
  alignment: "Alignment",
  gutter: "Gutter size",
  offset: "Offset",
  sectionSize: "Section size",
};

export function memberLabel(key: string): string {
  const known = MEMBER_LABELS[key];
  if (known !== undefined) return known;
  return sentence(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());
}

/**
 * The value field's label for a scalar — the `$type`, sentence-cased (§4.2).
 *
 * `Hex` is gone: the hex expectation is carried by the refusal copy at the moment a bad value is
 * committed, which is where the user is actually looking (§4.2).
 */
export function valueLabel(type: string): string {
  return sentence(type);
}

/**
 * `ALL_FILLS` → `All fills` — §6.3.
 *
 * Mechanical: lowercase, underscores to spaces, capitalise the first letter. No lookup table, so an
 * unknown future scope still renders as words rather than as an enum.
 */
export function humanizeScope(scope: string): string {
  return sentence(scope.trim().toLowerCase().replace(/_+/g, " "));
}

/** The `Scopes` line's text, or `null` when the token has none — absence is not rendered (§6.3). */
export function scopesLine(scopes: string[] | undefined): string | null {
  if (scopes === undefined) return null;
  const humanised = scopes.map(humanizeScope).filter((scope) => scope.length > 0);
  return humanised.length === 0 ? null : humanised.join(", ");
}

function sentence(text: string): string {
  if (text.length === 0) return text;
  return text[0].toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// The Figma disclosure — §6
// ---------------------------------------------------------------------------

/** What the disclosure's always-visible summary says, after the `Figma ·` prefix (§6.1). */
export interface FigmaProvenance {
  variableId?: string;
  modeId?: string;
  styleId?: string;
  styleType?: string;
  scopes?: string[];
  fontStyle?: string;
  boundVariables?: Record<string, unknown>;
  text?: Record<string, unknown>;
}

/**
 * The Source line, promoted into the summary row so collapsing never hides provenance (§6.1).
 *
 * `null` means there is no provenance at all, and §8's empty-state rule then omits the whole
 * section rather than rendering a disclosure with nothing behind it.
 */
export function figmaSummary(figma: FigmaProvenance, setLabel: string): string | null {
  if (figma.variableId !== undefined) return `Variable · ${setLabel}`;
  if (figma.styleId !== undefined) return `Style · ${figma.styleType ?? "?"}`;
  return null;
}

/** Whether the section has anything at all to show — §8's last empty state. */
export function hasFigmaSection(figma: FigmaProvenance): boolean {
  if (figma.variableId !== undefined || figma.styleId !== undefined) return true;
  if (Object.keys(figma.boundVariables ?? {}).length > 0) return true;
  return Object.keys(figma.text ?? {}).length > 0;
}

/**
 * Collapsed by default — expanded exactly when it explains a field above it (§6.2).
 *
 * Not "expanded when there is a lot in it": a token with eleven `text` extras and no bindings
 * explains nothing about its own value, and opening on it is the always-expanded default the
 * reference ships and §6.2 rejects.
 */
export function autoExpandFigma(input: { bound: boolean; disagreement: boolean }): boolean {
  return input.bound || input.disagreement;
}

// ---------------------------------------------------------------------------
// §5.6 — two-up member pairing and layer collapsing
// ---------------------------------------------------------------------------

/**
 * Which members share a line — §5.6.
 *
 * A static layout rule with exactly one condition: consecutive members pair two-up, and **a pair
 * unpairs the moment either member holds a non-literal value**, because a dotted path needs the
 * whole width. Nothing here knows what a shadow is; it takes the ordered keys and asks the caller
 * which of them point or compute.
 */
export function pairMembers(keys: string[], nonLiteral: (key: string) => boolean): string[][] {
  const rows: string[][] = [];
  for (let at = 0; at < keys.length; at += 2) {
    const pair = keys.slice(at, at + 2);
    if (pair.length === 2 && !nonLiteral(pair[0]) && !nonLiteral(pair[1])) {
      rows.push(pair);
      continue;
    }
    for (const key of pair) rows.push([key]);
  }
  return rows;
}

/**
 * Which shadow layers start collapsed — §5.6.
 *
 * One or two layers: everything expanded, because two stacked layers is a shadow you are reading as
 * a whole. Three or more: layer 1 stays expanded and the rest fold to their `.subhead`, which is
 * where the height actually goes.
 */
export function collapsedLayers(count: number): number[] {
  if (count < 3) return [];
  const collapsed: number[] = [];
  for (let index = 1; index < count; index += 1) collapsed.push(index);
  return collapsed;
}

/** One collapsed layer's summary: the value its preview reads from, and whether it hides a loop. */
export interface CollapsedLayer {
  /** The layer with every member that resolves substituted — what `previewOf` should be shown. */
  value: ShadowValue;
  /** At least one member is on a reference loop, so the fold has to say so (§7.1). */
  cycle: boolean;
}

/**
 * What a **collapsed** shadow layer's one-line summary is built from — §5.6, and §7.1's invariant.
 *
 * The fold is a size decision, never a truth decision. A layer whose `color` points at a token, or
 * whose `blur` is on a loop, has to say so from the collapsed row: building the preview from the raw
 * `$value` instead showed `{semantic.shadow.color} 0 2 4` where the resolved colour was known one
 * scope away, and — worse — hid a cycle behind a fold until the layer was manually expanded, which
 * is precisely the "never silently" half of `references-math-themes.md` §7.1.
 *
 * A cycled member keeps its **raw string** rather than gaining a substituted value: §7.1's no-value
 * rule reaches down here intact, so the summary shows the expression and the flag, never a zero.
 */
export function collapsedLayer(
  shadow: ShadowValue,
  resolutionOf: (field: string) => Resolution | undefined
): CollapsedLayer {
  const value: ShadowValue = { ...shadow };
  let cycle = false;

  for (const field of ["color", "offsetX", "offsetY", "blur", "spread"] as const) {
    const resolution = resolutionOf(field);
    if (resolution === undefined) continue;
    if (resolution.kind === "cycle") {
      cycle = true;
      continue;
    }
    if (resolution.value === undefined) continue;
    (value as unknown as Record<string, unknown>)[field] = resolution.value;
  }

  return { value, cycle };
}
