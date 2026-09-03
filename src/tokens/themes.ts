// Themes — ADR-0007 §7(a) and §7(c), read-only.
//
// Pure. Turns the manifest's `themes[]` into the set stack resolution runs against, and into the
// list of (collection, mode) pairs a canvas switch would set. Nothing here creates, renames or
// composes a theme: **composition editing is out of Phase 7** (ADR-0007 §7b, Shyam's scope call
// 2026-09-03), so there is no override store and no merge path, and adding one is a decision to
// amend that ADR rather than a feature to slip in.
//
// The one thing this module is careful about is *saying so when it can't help*. A file with two or
// more multi-mode collections gets no derived themes at all (ADR-0002 §6's undischarged
// `theme-composition` / `ambiguous` deferral), and UX §8.5 is explicit that the control stays
// present and explains itself rather than disappearing. `themeState` returns that case as a state
// with a reason attached, not as an empty list the UI has to interpret.

import type { Manifest, ManifestTheme } from "./types";
import type { FlatToken } from "./view";

// ---------------------------------------------------------------------------
// The themes a file has
// ---------------------------------------------------------------------------

export interface EffectiveTheme {
  name: string;
  /** In `selectedTokenSets` order, which is the order that decides the answer (ADR-0002 §1). */
  selectedTokenSets: string[];
}

/**
 * The manifest's themes, filtered to the sets that actually exist in this build.
 *
 * A pulled `$manifest.json` (ADR-0006 §5) can name a set this file no longer has. Dropping it from
 * the stack rather than failing the theme is the same partial-plus-named rule §7c applies to the
 * canvas switch: a theme with one stale set is still a usable theme.
 */
export function effectiveThemes(manifest: Manifest): EffectiveTheme[] {
  const known = new Set(manifest.tokenSetOrder);
  return manifest.themes.map((theme) => ({
    name: theme.name,
    selectedTokenSets: theme.selectedTokenSets.filter((set) => known.has(set)),
  }));
}

/** Sets a theme names that this build has no record of — the honest half of the filter above. */
export function unknownSets(manifest: Manifest, theme: ManifestTheme | EffectiveTheme): string[] {
  const known = new Set(manifest.tokenSetOrder);
  return theme.selectedTokenSets.filter((set) => !known.has(set));
}

// ---------------------------------------------------------------------------
// Which theme is active
// ---------------------------------------------------------------------------

export interface ThemeState {
  themes: EffectiveTheme[];
  /** `null` only when the file has no themes at all — UX §8.5's `Theme: none`. */
  active: EffectiveTheme | null;
  /**
   * Set when the stored name was gone and we fell back to the first theme.
   *
   * Never silent: ADR-0007 §7a is explicit that resolving against a stack the user did not choose
   * would change every displayed value with no explanation. UX §8.3 renders this as a toast.
   */
  fellBackFrom?: string;
}

/**
 * The active theme for a stored name.
 *
 * Default is the first theme in the manifest, **including** ADR-0002 Amendment 1 §D's synthesised
 * `Default` — which is why the single-theme and no-multi-mode-collection cases need no special
 * handling here and render as ordinary pickers (UX §8.5's last paragraph).
 */
export function themeState(manifest: Manifest, stored: string | null): ThemeState {
  const themes = effectiveThemes(manifest);
  if (themes.length === 0) return { themes, active: null };

  if (stored !== null) {
    for (const theme of themes) {
      if (theme.name === stored) return { themes, active: theme };
    }
    return { themes, active: themes[0], fellBackFrom: stored };
  }

  return { themes, active: themes[0] };
}

/**
 * The set stack an active theme resolves through, in order, last-wins (ADR-0002 §1).
 *
 * `null` — no themes at all — resolves through **every** set in `tokenSetOrder`, which is what
 * UX §8.5's explanation panel promises in so many words: *"Values below resolve through every set,
 * in order, last one wins."* That is the honest fallback for a file whose shape defeated theme
 * derivation; refusing to resolve anything would make references and expressions unusable in it.
 */
export function themeSetStack(manifest: Manifest, active: EffectiveTheme | null): string[] {
  return active === null ? manifest.tokenSetOrder.slice() : active.selectedTokenSets.slice();
}

/**
 * The tokens the active theme resolves against, in stack order.
 *
 * Order is the point: `buildReferenceGraph` with `resolution: "last"` reads this list and the last
 * set to define a path wins, which is ADR-0002 §1's rule made operational. A token in a set the
 * theme does not select is simply not here — that is what makes `unresolved-in-theme` a real state
 * rather than a synthetic one.
 */
export function tokensInStack(tokens: FlatToken[], stack: string[]): FlatToken[] {
  const rank = new Map<string, number>();
  stack.forEach((set, index) => rank.set(set, index));

  const inStack = tokens.filter((entry) => rank.has(entry.setId));
  // A stable sort by stack position, preserving each set's own internal order.
  return inStack
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (rank.get(a.entry.setId) as number) - (rank.get(b.entry.setId) as number) ||
        a.index - b.index
    )
    .map((wrapped) => wrapped.entry);
}

// ---------------------------------------------------------------------------
// Live canvas switching — ADR-0007 §7(c)
// ---------------------------------------------------------------------------

/** One collection to put into one mode. Plain data; `src/figma/modes.ts` performs it. */
export interface ModeTarget {
  collectionId: string;
  collectionName: string;
  modeId: string;
  modeName: string;
  /** The token set this pair came from, so a partial report can name it. */
  set: string;
}

export interface ThemeModePlan {
  targets: ModeTarget[];
  /**
   * Sets the theme names that map to no Figma mode, **excluding style-backed ones**.
   *
   * Figma Styles have no mode concept, so a styles set is expected-unmappable rather than a
   * failure (ADR-0007 §7c). Reporting it every time is how you teach someone to stop reading the
   * toast, so it never reaches this list.
   */
  unmapped: string[];
}

/**
 * The (collection, mode) pairs a theme switch would set — no new data (ADR-0007 §7c).
 *
 * Every mode entry already carries `$figmaCollectionId` / `$figmaModeId` back-references
 * (ADR-0002 §6), so a theme's `selectedTokenSets` already *is* this list; the work is a lookup.
 *
 * **One mode per collection.** A theme naming two modes of the same collection is incoherent — a
 * node can hold one explicit mode per collection — so the last one in `selectedTokenSets` wins,
 * matching the same last-wins rule the resolver uses for values.
 */
export function themeModePlan(manifest: Manifest, theme: EffectiveTheme | null): ThemeModePlan {
  if (theme === null) return { targets: [], unmapped: [] };

  const styleSets = new Set((manifest.styleSets ?? []).map((set) => set.set));
  const byCollection = new Map<string, ModeTarget>();
  const unmapped: string[] = [];

  for (const set of theme.selectedTokenSets) {
    if (styleSets.has(set)) continue;

    let found: ModeTarget | null = null;
    for (const collection of manifest.collections) {
      for (const mode of collection.modes) {
        if (mode.set !== set) continue;
        found = {
          collectionId: collection.$figmaCollectionId,
          collectionName: collection.name,
          modeId: mode.$figmaModeId,
          modeName: mode.name,
          set,
        };
        break;
      }
      if (found !== null) break;
    }

    if (found === null || found.collectionId.length === 0 || found.modeId.length === 0) {
      // A hand-composed set from a pulled manifest, or one whose back-references didn't survive.
      // Named, never silently dropped, and never a reason to refuse the whole switch.
      unmapped.push(set);
      continue;
    }
    byCollection.set(found.collectionId, found);
  }

  return { targets: Array.from(byCollection.values()), unmapped };
}

/**
 * Which theme the canvas is currently showing, from a node's explicit modes — UX §8.2's `on canvas`.
 *
 * A theme matches when **every** collection it maps is currently set to that theme's mode. A
 * partial match is not a match: showing `on canvas` beside a theme two of whose three collections
 * are set elsewhere would be a claim about the canvas that is false.
 *
 * `null` when nothing matches, which is the ordinary state on a page nobody has switched.
 */
export function themeOnCanvas(
  manifest: Manifest,
  themes: EffectiveTheme[],
  explicitModes: Record<string, string>
): string | null {
  for (const theme of themes) {
    const plan = themeModePlan(manifest, theme);
    if (plan.targets.length === 0) continue;
    let matches = true;
    for (const target of plan.targets) {
      if (explicitModes[target.collectionId] !== target.modeId) {
        matches = false;
        break;
      }
    }
    if (matches) return theme.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Why a file has no themes — UX §8.5
// ---------------------------------------------------------------------------

/** Collections with more than one mode: the count UX §8.5's copy names back to the user. */
export function multiModeCollections(manifest: Manifest): string[] {
  return manifest.collections
    .filter((collection) => collection.modes.length > 1)
    .map((collection) => collection.name);
}
