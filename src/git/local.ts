// The exact bytes a push would write — ADR-0006 §5.
//
// Push commits `build(scan) + overlay`, whole files, serialized through `stableStringify`. That is
// the same tree the Tokens tab renders, but it has to be produced *as bytes* rather than as a model,
// because the blob SHA of those bytes is the entire change-detection design (§4). Any difference
// between what this emits and what `api.ts` uploads would make "in sync" a coin flip.
//
// So this module is deliberately a thin composition of two things that already exist —
// `applyOverlayToFiles` (ADR-0004) and `stableStringify` (ADR-0002 §7) — and adds nothing of its
// own except the two boundary rules the ADR names:
//
//   - `$import-report.json` is dropped **here**, at the push boundary, not filtered in the UI
//     (§5, UX §14). It should be impossible for it to reach a diff list by any route.
//   - build-shaped paths (`tokens/…`) become repo-shaped paths (`design/…`) exactly once, here,
//     so nothing downstream has to remember which shape it is holding.

import type { EditOverlay } from "../tokens/overlay";
import type { TokenFileOutput, TokenGroup } from "../tokens/types";
import { applyOverlayToFiles } from "../tokens/overlay";
import { stableStringify } from "../tokens/serialize";
import { isExcluded } from "./diff";
import { toRepoPath } from "./paths";

/** One generated file as the panel already holds it: a build-shaped path and its serialized JSON. */
export interface LocalFile {
  path: string;
  json: string;
}

/**
 * Repo-relative path → the bytes a push would write for it.
 *
 * The input is the *pristine* import's serialized files, exactly as they crossed `postMessage`;
 * the overlay is laid on here rather than being baked in upstream, so the same payload serves the
 * tree, the apply plan and the push without three copies of "which tree is this?".
 */
export function localTree(
  files: LocalFile[],
  overlay: EditOverlay,
  tokensDir: string
): Map<string, string> {
  const parsed: TokenFileOutput[] = [];
  for (const file of files) {
    if (isExcluded(file.path)) continue;
    parsed.push({ path: file.path, content: JSON.parse(file.json) as TokenGroup });
  }

  const out = new Map<string, string>();
  for (const file of applyOverlayToFiles(parsed, overlay)) {
    // Re-serialized rather than passed through, because the overlay may have changed the content
    // and because a byte-identical form is the only thing a blob SHA can be computed against. For
    // an unedited file this reproduces the input string exactly — that is ADR-0002 §7's guarantee,
    // and `test/gitLocal.test.ts` pins it rather than trusting it.
    out.set(toRepoPath(file.path, tokensDir), stableStringify(file.content));
  }
  return out;
}

/** The parsed local trees, keyed by **build**-shaped path — what the token-level diff compares. */
export function localTrees(files: LocalFile[], overlay: EditOverlay): Map<string, TokenGroup> {
  const parsed: TokenFileOutput[] = [];
  for (const file of files) {
    if (isExcluded(file.path)) continue;
    parsed.push({ path: file.path, content: JSON.parse(file.json) as TokenGroup });
  }

  const trees = new Map<string, TokenGroup>();
  for (const file of applyOverlayToFiles(parsed, overlay)) {
    trees.set(file.path, file.content as TokenGroup);
  }
  return trees;
}
