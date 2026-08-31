// Builds the Figma plugin: bundles src/code.ts -> dist/code.js, and bundles
// src/ui/main.ts, inlining it into src/ui/index.html -> dist/ui.html.
// Figma requires the UI as a single HTML file with no external script/asset references.

import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });

async function buildCode() {
  const options = {
    entryPoints: ["src/code.ts"],
    bundle: true,
    outfile: "dist/code.js",
    target: "es2017",
    logLevel: "info",
  };
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}

async function buildUi() {
  const options = {
    entryPoints: ["src/ui/main.ts"],
    bundle: true,
    write: false,
    target: "es2017",
    logLevel: "info",
  };

  const writeInlinedHtml = (result) => {
    const js = result.outputFiles[0].text;
    const template = readFileSync("src/ui/index.html", "utf8");
    const html = template.replace(
      /<script>[\s\S]*?<\/script>/,
      `<script>${js}</script>`
    );
    writeFileSync("dist/ui.html", html);
  };

  if (watch) {
    const ctx = await context({
      ...options,
      plugins: [
        {
          name: "inline-ui-html",
          setup(b) {
            b.onEnd((result) => {
              if (result.outputFiles) writeInlinedHtml(result);
            });
          },
        },
      ],
    });
    await ctx.watch();
  } else {
    const result = await build(options);
    writeInlinedHtml(result);
  }
}

await Promise.all([buildCode(), buildUi()]);

if (watch) {
  console.log("Watching for changes...");
}
