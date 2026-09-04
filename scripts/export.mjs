// Runs the Style Dictionary export — `npm run build:tokens`.
//
// Same shape as `scripts/test.mjs`, and for the same reason: the export reuses `src/tokens/`, whose
// extensionless TypeScript imports Node cannot resolve on its own, so esbuild bundles the entry
// point first and Node runs the result. `packages: "external"` keeps `style-dictionary` resolved
// from `node_modules` at runtime rather than inlined, so its own dynamic requires still work.

import { build } from "esbuild";
import { spawn } from "node:child_process";

const outFile = "dist-export/cli.mjs";

await build({
  entryPoints: ["src/export/cli.ts"],
  bundle: true,
  outfile: outFile,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});

const child = spawn(process.execPath, [outFile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
