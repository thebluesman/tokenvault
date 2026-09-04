// Reading a committed token tree back into the shapes the rest of the export uses.
//
// Pure — it is handed already-parsed JSON, so it can be unit-tested without a filesystem and the
// Node entry point stays a thin shell around it (issue #17: the pipeline is ordinary Node code,
// separate from the plugin bundle).
//
// The inbound contract is ADR-0006 §11's: a `$manifest.json` plus one JSON file per set, under a
// **configurable** folder. `tokensDir` is a user setting stored in `tokenvault:github` (ADR-0006
// §3) and `cb086ee` already cost one bug from treating it as the constant `tokens/`, so every path
// here goes through `git/paths.ts`'s translation rather than through a literal prefix.

import type { Manifest, TokenGroup } from "../tokens/types";
import type { FlatToken } from "../tokens/view";
import { flattenImport } from "../tokens/view";
import { fromRepoPath, IMPORT_REPORT_PATH, normalizeTokensDir } from "../git/paths";

/** One file as it sits in the repo: a path relative to the repo root, and its parsed body. */
export interface RepoFile {
  path: string;
  json: unknown;
}

export interface ReadResult {
  manifest: Manifest;
  tokens: FlatToken[];
  /** Build-prefixed (`tokens/…`) trees, for callers that want the files rather than the tokens. */
  trees: Map<string, TokenGroup>;
  /**
   * Files inside the folder that the manifest does not account for.
   *
   * Named, not ignored: a set file left behind by a rename is invisible to the build but visible in
   * the repo, and a reader comparing the two deserves to be told which of them the build used.
   */
  unreferenced: string[];
}

export class ExportInputError extends Error {}

/** The manifest's repo path for a given folder — `tokens/$manifest.json` by default. */
export const MANIFEST_BUILD_PATH = "tokens/$manifest.json";

/**
 * Turns the repo's token files into a manifest plus a flat token list.
 *
 * Throws rather than returning a result type, deliberately and only here: a missing or malformed
 * manifest is not a token-level diagnostic the build can report and continue past — there is no
 * build to continue. Everything that *is* per-token comes back as an `ExportDiagnostic` instead.
 */
export function readExportInput(files: RepoFile[], tokensDir: string): ReadResult {
  const trees = new Map<string, TokenGroup>();
  let manifest: Manifest | null = null;
  const buildPaths: string[] = [];

  for (const file of files) {
    const buildPath = fromRepoPath(file.path, tokensDir);
    if (buildPath === null) continue;
    if (buildPath === IMPORT_REPORT_PATH) continue;

    if (buildPath === MANIFEST_BUILD_PATH) {
      manifest = asManifest(file.json, file.path);
      continue;
    }
    // Anything else `$`-prefixed is metadata this version does not know about. Skipping it beats
    // guessing: a future `$`-file added by a newer plugin must not be flattened into tokens.
    if (buildPath.startsWith("tokens/$")) continue;

    if (typeof file.json !== "object" || file.json === null || Array.isArray(file.json)) {
      throw new ExportInputError(`${file.path} is not a token file — expected a JSON object.`);
    }
    trees.set(buildPath, file.json as TokenGroup);
    buildPaths.push(buildPath);
  }

  if (manifest === null) {
    const dir = normalizeTokensDir(tokensDir);
    const where = dir.length === 0 ? "$manifest.json" : `${dir}/$manifest.json`;
    throw new ExportInputError(
      `No manifest at ${where}. The export reads the manifest to enumerate themes, so there is nothing to build.`
    );
  }

  const used = new Set(
    manifest.collections
      .flatMap((collection) => collection.modes.map((mode) => `tokens/${mode.file}`))
      .concat((manifest.styleSets ?? []).map((set) => `tokens/${set.file}`))
  );
  const unreferenced = buildPaths.filter((path) => !used.has(path)).sort();

  return { manifest, tokens: flattenImport(trees, manifest), trees, unreferenced };
}

/**
 * Enough of a manifest check to fail with a sentence rather than a `TypeError` three modules later.
 *
 * Not a schema validator: the manifest is written by this project's own build (ADR-0002 §6), so the
 * realistic failure is *"that file is not a manifest"* — a truncated push, a wrong `tokensDir` — not
 * a subtly wrong field.
 */
function asManifest(json: unknown, path: string): Manifest {
  const candidate = json as Partial<Manifest> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !Array.isArray(candidate.tokenSetOrder) ||
    !Array.isArray(candidate.collections) ||
    !Array.isArray(candidate.themes)
  ) {
    throw new ExportInputError(
      `${path} is not a Tokenvault manifest — expected tokenSetOrder, collections and themes.`
    );
  }
  return candidate as Manifest;
}
