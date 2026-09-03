// Explicit variable modes — ADR-0007 §7(c). The only module that sets one.
//
// Same one-impure-edge boundary as `scan.ts`, `scanStyles.ts` and `apply.ts`: `themes.ts` decides
// which (collection, mode) pairs a theme means, and this file does nothing but perform them.
//
// **This is a view operation, not an apply** (§7c). It writes no token values, does not go through
// `ApplyPlan`, does not use the apply preview, and never touches the overlay. Routing it through
// the apply confirmation would train users to click through a dialog that guards nothing.
//
// It is still a document mutation — explicit modes live on nodes and pages, not in plugin state —
// so it is bracketed with `commitUndo` on both sides and is its own undo step. There is no
// plugin-side undo: ⌘Z is the undo, as it is for every other document mutation (UX §8.4).
//
// --- API facts, verified against `@figma/plugin-typings` 1.99 at build time, not assumed ---
//
//   - `setExplicitVariableModeForCollection` lives on `ExplicitVariableModesMixin`, which
//     `PageNode` and `SceneNodeMixin` both extend. The two-argument form taking a
//     `VariableCollection` object is current; the `(collectionId, modeId)` string overload is
//     deprecated and throws under `"documentAccess": "dynamic-page"`, so this module resolves the
//     collection object first and never passes an id.
//   - **`DocumentNode` does NOT extend that mixin.** There is no document-root equivalent, so the
//     "switch the whole document" option in ADR-0007 open question 1 is not available at all — it
//     would have to be a loop over every page, which is a different, much larger operation. That
//     settles the question in favour of the current page, which is what UX §8.4 assumed and what
//     the button's own label ("Switch this page to Light") says.
//   - `figma.commitUndo` is guarded exactly as `apply.ts` guards it, and for the same reason: it is
//     absent from some Figma script runtimes, and an unguarded call would abort the switch before
//     it happened. Losing it costs the isolation of the undo step, not the undo.

import type { ModeTarget } from "../tokens/themes";

export interface ModeSwitchOutcome {
  /** Collections actually put into the requested mode. */
  switched: string[];
  /**
   * Collections that could not be switched, with Figma's own reason.
   *
   * Named rather than counted: partial mapping is reported, never silent (§7c), and "2 sets have
   * no Figma mode" is only useful if it says which.
   */
  failed: Array<{ collectionName: string; message: string }>;
}

/** `apply.ts`'s guard, repeated rather than shared: importing across the boundary for one
 * try/catch would make this module depend on the write executor it deliberately isn't part of. */
function commitUndoStep(): void {
  try {
    figma.commitUndo();
  } catch {
    // Absent in some runtimes. The switch still lands in undo history, just grouped with whatever
    // preceded it — a coarser step, not a lost one.
  }
}

/**
 * Puts the current page into a theme's modes.
 *
 * Every collection the theme *can* map is switched and every one it could not is named. A single
 * unmappable collection never refuses the whole switch — that would make a hand-composed theme
 * arriving from a pulled `$manifest.json` permanently unswitchable (§7c).
 */
export async function switchPageToModes(targets: ModeTarget[]): Promise<ModeSwitchOutcome> {
  const outcome: ModeSwitchOutcome = { switched: [], failed: [] };
  if (targets.length === 0) return outcome;

  commitUndoStep();

  for (const target of targets) {
    try {
      const collection = await figma.variables.getVariableCollectionByIdAsync(target.collectionId);
      if (collection === null) {
        outcome.failed.push({
          collectionName: target.collectionName,
          message: "That collection isn't in this file any more.",
        });
        continue;
      }
      figma.currentPage.setExplicitVariableModeForCollection(collection, target.modeId);
      outcome.switched.push(target.collectionName);
    } catch (error) {
      outcome.failed.push({
        collectionName: target.collectionName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  commitUndoStep();
  return outcome;
}

/**
 * The current page's explicit modes, for UX §8.2's `on canvas` tag.
 *
 * A read, so it stays out of the switch path entirely. `explicitVariableModes` is a plain
 * `collectionId → modeId` record and is the only thing `themeOnCanvas` needs.
 */
export function currentPageModes(): Record<string, string> {
  const modes = figma.currentPage.explicitVariableModes;
  const out: Record<string, string> = {};
  for (const collectionId of Object.keys(modes)) out[collectionId] = modes[collectionId];
  return out;
}
