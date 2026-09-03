// `npm run build:tokens` — the Node entry point.
//
// A shell: read the token folder, run `pipeline.ts`, write what it returns, print what happened.
// Everything worth testing lives in the modules it calls, so this file has no logic to get wrong
// beyond argument handling and the write.
//
// **Diagnostics fail the build and nothing is written.** Issue #17 leaves "fail or warn" open;
// failing is the only answer that keeps ADR-0007 §3's rule intact on this side of the boundary — a
// cycle produces no value at all, never a zero and never the last good number. A build that emitted
// a stylesheet with a hole in it, or with `{core.space.4}` sitting in it as a literal, would be a
// consumer's bug report tomorrow rather than ours today.

import { readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { RepoFile } from "./read";
import { ExportInputError } from "./read";
import { ExportConfigError, runExport } from "./pipeline";

export const DEFAULT_TOKENS_DIR = "tokens";
export const DEFAULT_OUT_DIR = "exports";

interface Args {
  tokensDir: string;
  outDir: string;
  /** Build and compare against what is on disk, writing nothing. For a CI "is this stale?" gate. */
  check: boolean;
  root: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    tokensDir: DEFAULT_TOKENS_DIR,
    outDir: DEFAULT_OUT_DIR,
    check: false,
    root: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--check") {
      args.check = true;
    } else if (flag === "--tokens-dir") {
      args.tokensDir = required(argv, (i += 1), "--tokens-dir");
    } else if (flag === "--out") {
      args.outDir = required(argv, (i += 1), "--out");
    } else if (flag === "--root") {
      args.root = required(argv, (i += 1), "--root");
    } else {
      throw new ExportConfigError(`Unknown option "${flag}".`);
    }
  }
  return args;
}

function required(argv: string[], at: number, flag: string): string {
  const value = argv[at];
  if (value === undefined || value.startsWith("--")) {
    throw new ExportConfigError(`${flag} needs a value.`);
  }
  return value;
}

/** Every `.json` file under the token folder, as repo-relative paths with parsed bodies. */
function readTokenFiles(root: string, tokensDir: string): RepoFile[] {
  const base = join(root, tokensDir);
  let entries: string[];
  try {
    entries = walk(base);
  } catch {
    throw new ExportInputError(
      `No token folder at "${tokensDir}". Pass --tokens-dir if the plugin is configured to push somewhere else.`
    );
  }

  return entries
    .filter((path) => path.endsWith(".json"))
    .sort()
    .map((path) => {
      const repoPath = relative(root, path).split(sep).join("/");
      const text = readFileSync(path, "utf8");
      try {
        return { path: repoPath, json: JSON.parse(text) as unknown };
      } catch (error) {
        throw new ExportInputError(`${repoPath} is not valid JSON: ${(error as Error).message}`);
      }
    });
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/** Generated `.css` files no theme claims any more — a renamed or deleted theme leaves one behind. */
function staleOutputs(root: string, outDir: string, keep: Set<string>): string[] {
  const cssDir = join(root, outDir, "css");
  try {
    if (!statSync(cssDir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(cssDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => `${outDir}/css/${name}`)
    .filter((path) => !keep.has(path))
    .sort();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const files = readTokenFiles(args.root, args.tokensDir);
  const run = await runExport(files, { tokensDir: args.tokensDir, outDir: args.outDir });

  for (const path of run.unreferenced) {
    console.warn(`note: ${path} is not named by the manifest, so nothing was built from it.`);
  }

  if (run.diagnostics.length > 0) {
    console.error(`\n${run.diagnostics.length} problem(s) — nothing was written.\n`);
    for (const diagnostic of run.diagnostics) {
      console.error(`  [${diagnostic.kind}] ${diagnostic.theme}: ${diagnostic.message}`);
    }
    console.error("");
    return 1;
  }

  const keep = new Set(run.outputs.map((output) => output.path));
  const stale = staleOutputs(args.root, args.outDir, keep);

  if (args.check) {
    const changed: string[] = [];
    for (const output of run.outputs) {
      let current: string | null = null;
      try {
        current = readFileSync(join(args.root, output.path), "utf8");
      } catch {
        current = null;
      }
      if (current !== output.content) changed.push(output.path);
    }
    const drift = changed.concat(stale.map((path) => `${path} (stale)`));
    if (drift.length > 0) {
      console.error("Generated CSS is out of date. Run `npm run build:tokens` and commit:");
      for (const path of drift) console.error(`  ${path}`);
      return 1;
    }
    console.log("Generated CSS is up to date.");
    return 0;
  }

  for (const output of run.outputs) {
    const target = join(args.root, output.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output.content);
  }
  for (const path of stale) rmSync(join(args.root, path), { force: true });

  for (const summary of run.themes) {
    const skipped =
      summary.skipped.length === 0 ? "" : `, ${summary.skipped.length} skipped (no CSS form)`;
    console.log(
      `${summary.theme.name} → ${summary.outputPath} (${summary.emitted} properties${skipped})`
    );
    for (const set of summary.theme.unknownSets) {
      console.warn(`  note: theme "${summary.theme.name}" names set "${set}", which is not in this tree.`);
    }
  }
  for (const path of stale) console.log(`removed ${path} (no theme builds to it any more)`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof ExportInputError || error instanceof ExportConfigError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  });
