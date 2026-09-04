// Which builds the export runs — PRD §6.6, issue #17.
//
// One Style Dictionary build per theme in `$manifest.json`, enumerated rather than configured:
// adding a theme in Figma and pushing it has to be enough to get it built, so nothing downstream
// may carry a hand-maintained theme list.
//
// Two cases this module exists to keep honest:
//
//   1. **A manifest with no themes still gets a build.** ADR-0002 Amendment 1 §D normally
//      synthesises a `Default` theme, but a file with two or more multi-mode collections gets none
//      at all (`theme-composition`). `themeSetStack(manifest, null)` already answers what that file
//      resolves through — every set in `tokenSetOrder`, in order — and the export uses the same
//      answer rather than refusing to emit anything for a perfectly ordinary token tree.
//   2. **Slugs are file names and must not collide.** Two themes named `Brand A` and `Brand/A`
//      slug identically, and the second silently overwriting the first would be a build that
//      quietly emits one theme fewer than it reports.

import type { Manifest } from "../tokens/types";
import { effectiveThemes, themeSetStack, unknownSets } from "../tokens/themes";
import { slugify } from "../tokens/paths";

export interface ExportTheme {
  /** The theme's name as authored, for build output and diagnostics. */
  name: string;
  /** File-name form, unique across the returned list. */
  slug: string;
  /** In `selectedTokenSets` order — last-wins (ADR-0002 §1). */
  selectedTokenSets: string[];
  /** Sets the theme names that this tree has no record of, dropped from the stack above. */
  unknownSets: string[];
  /**
   * True when the manifest named no themes and this is the whole-tree fallback build.
   *
   * Reported rather than hidden: a consumer seeing one `default.css` should be able to find out
   * whether that is a one-theme file or a file whose themes could not be derived (UX §8.5).
   */
  synthesized: boolean;
}

/** The name and slug the fallback build uses when the manifest names no themes. */
export const DEFAULT_THEME_NAME = "Default";

export function exportThemes(manifest: Manifest): ExportTheme[] {
  const themes = effectiveThemes(manifest);

  const built: ExportTheme[] =
    themes.length === 0
      ? [
          {
            name: DEFAULT_THEME_NAME,
            slug: slugify(DEFAULT_THEME_NAME),
            selectedTokenSets: themeSetStack(manifest, null),
            unknownSets: [],
            synthesized: true,
          },
        ]
      : themes.map((theme, index) => ({
          name: theme.name,
          slug: slugify(theme.name),
          selectedTokenSets: theme.selectedTokenSets.slice(),
          // `effectiveThemes` returns the manifest's themes 1:1 and in order, with each stack
          // filtered — so the unfiltered stack this one came from is the manifest entry at the
          // same index, and asking it what got dropped is a lookup, not a search by name (two
          // themes may share a name).
          unknownSets: unknownSets(manifest, manifest.themes[index]),
          synthesized: false,
        }));

  return disambiguate(built);
}

/**
 * Suffixes colliding slugs `-2`, `-3`, … in enumeration order.
 *
 * Order-stable rather than clever: the same manifest must produce the same file names on every
 * run, or a rebuild churns the diff (ADR-0002 §7's determinism promise, extended to file names).
 */
function disambiguate(themes: ExportTheme[]): ExportTheme[] {
  const seen = new Map<string, number>();
  return themes.map((theme) => {
    const count = seen.get(theme.slug) ?? 0;
    seen.set(theme.slug, count + 1);
    return count === 0 ? theme : { ...theme, slug: `${theme.slug}-${count + 1}` };
  });
}
