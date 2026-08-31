// Runs the unit tests.
//
// Node's built-in test runner cannot resolve the extensionless TypeScript imports the source
// uses, so esbuild bundles each `test/*.test.ts` into `dist-test/` first and `node --test` runs
// the result. Keeps the toolchain at zero extra dependencies (PRD §8).

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";

const testDir = "test";
const outDir = "dist-test";

const entryPoints = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `${testDir}/${name}`);

if (entryPoints.length === 0) {
  console.error("No test files found in test/");
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

await build({
  entryPoints,
  bundle: true,
  outdir: outDir,
  platform: "node",
  format: "esm",
  target: "node20",
  // Keep node: builtins external so `node:test` and `node:assert` resolve at runtime.
  packages: "external",
  // The repo has no "type": "module", so ESM output must carry the .mjs extension to be parsed
  // as ESM rather than CommonJS.
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});

const built = entryPoints.map((entry) => `${outDir}/${entry.slice(testDir.length + 1).replace(/\.ts$/, ".mjs")}`);

const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...built], {
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));
