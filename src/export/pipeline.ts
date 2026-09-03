// The export pipeline, end to end — issue #17.
//
// Filesystem-free on purpose: it takes already-read files and returns the files it wants written,
// so the whole pipeline is testable and `cli.ts` is a shell that does I/O and prints. The only
// impurity is Style Dictionary itself, which is async.
//
// Order, and why it is this order (issue #17's open question, settled here and in ADR terms by
// ADR-0007 §4): **theme → references → expressions.** Themes come first because an expression's
// operands resolve through the active theme's set stack, so the same expression is a different
// number per theme; references come next because an expression can be built out of them; and
// expressions are flattened last, into the tree the transform engine actually sees. That is the
// order `plan.ts` already applies on the Figma side, and having the export invent a second order
// would mean the CSS and the Figma file could disagree about the same token.

import type { ExportDiagnostic, ExportToken } from "./flatten";
import { flattenTheme, toStyleDictionaryTokens } from "./flatten";
import type { ExportTheme } from "./themes";
import { exportThemes } from "./themes";
import type { RepoFile } from "./read";
import { readExportInput } from "./read";
import { buildCss, partitionForCss } from "./css";

export interface ExportOptions {
  /** The configured folder the token tree lives in (ADR-0006 §3). Not assumed to be `tokens`. */
  tokensDir: string;
  /**
   * Where generated files go — **outside `tokensDir`, always**.
   *
   * Load-bearing rather than cosmetic: Phase 6 tracks sync as a blob SHA per file under
   * `tokensDir` (ADR-0006 §3, §4), so a generated file written inside it would be read on the next
   * status check as repo-side drift the user never made. `assertOutsideTokensDir` enforces it.
   */
  outDir: string;
}

/** One file the build wants written, relative to the repo root. */
export interface ExportOutput {
  path: string;
  content: string;
}

export interface ThemeSummary {
  theme: ExportTheme;
  /** Custom properties actually emitted. */
  emitted: number;
  /** Tokens dropped because CSS has no single-value form for their type. */
  skipped: ExportToken[];
  outputPath: string;
}

export interface ExportRun {
  outputs: ExportOutput[];
  themes: ThemeSummary[];
  diagnostics: ExportDiagnostic[];
  /** Files under `tokensDir` the manifest never names. Informational. */
  unreferenced: string[];
}

export class ExportConfigError extends Error {}

/** `exports` → `exports/css/light.css`. One subdirectory per target, so a second target can land. */
export function cssOutputPath(outDir: string, slug: string): string {
  const dir = outDir.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return dir.length === 0 ? `css/${slug}.css` : `${dir}/css/${slug}.css`;
}

/**
 * Refuses an output folder that would land inside the tracked token folder.
 *
 * A check rather than a convention, because the failure it prevents is invisible: the build would
 * succeed, the CI commit would succeed, and the *plugin* would report every token file as diverged
 * on the next status check with nothing pointing back at this setting.
 */
export function assertOutsideTokensDir(outDir: string, tokensDir: string): void {
  const normalize = (raw: string): string => raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const out = normalize(outDir);
  const tokens = normalize(tokensDir);

  if (tokens.length === 0) {
    throw new ExportConfigError(
      "The token folder is the repository root, so there is nowhere outside it to write generated files. Move the tokens into a folder first."
    );
  }
  if (out.length === 0 || out === tokens || out.startsWith(`${tokens}/`)) {
    throw new ExportConfigError(
      `The output folder "${outDir}" is inside the token folder "${tokensDir}". Generated files there would be read as repo-side drift on the next sync check (ADR-0006 §4). Choose a folder outside it.`
    );
  }
}

export async function runExport(files: RepoFile[], options: ExportOptions): Promise<ExportRun> {
  assertOutsideTokensDir(options.outDir, options.tokensDir);

  const input = readExportInput(files, options.tokensDir);
  const themes = exportThemes(input.manifest);

  const outputs: ExportOutput[] = [];
  const summaries: ThemeSummary[] = [];
  const diagnostics: ExportDiagnostic[] = [];

  for (const theme of themes) {
    const flattened = flattenTheme(input.tokens, theme);
    diagnostics.push(...flattened.diagnostics);

    const partition = partitionForCss(flattened.tokens);
    const tree = toStyleDictionaryTokens(partition.emit, theme.name);
    diagnostics.push(...tree.diagnostics);

    const conflicted = new Set(
      tree.diagnostics.filter((one) => one.kind === "path-conflict").map((one) => one.path)
    );
    const css = await buildCss(tree.tokens, { themeName: theme.name });
    const outputPath = cssOutputPath(options.outDir, theme.slug);

    outputs.push({ path: outputPath, content: css });
    summaries.push({
      theme,
      emitted: partition.emit.length - conflicted.size,
      skipped: partition.skipped,
      outputPath,
    });
  }

  return { outputs, themes: summaries, diagnostics, unreferenced: input.unreferenced };
}
