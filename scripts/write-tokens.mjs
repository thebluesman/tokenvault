// Writes the token tree copied out of the plugin UI ("Copy whole tree as JSON") to disk.
//
// Phase 2 has no git sync — that is Phase 6 — so this is the bridge between the plugin's
// in-memory output and a real directory, used to produce the committed fixture.
//
//   pbpaste > /tmp/tree.json && node scripts/write-tokens.mjs /tmp/tree.json [outDir]
//
// The input is a map of repo-relative path → parsed JSON content. Files are re-serialized with
// the same deterministic rules the plugin uses, so writing a tree twice is a no-op in git.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function stableStringify(value, indent = "") {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + "  ";
    return "[\n" + value.map((item) => inner + stableStringify(item, inner)).join(",\n") + "\n" + indent + "]";
  }

  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    if (keys.length === 0) return "{}";
    const inner = indent + "  ";
    return (
      "{\n" +
      keys.map((key) => inner + JSON.stringify(key) + ": " + stableStringify(value[key], inner)).join(",\n") +
      "\n" +
      indent +
      "}"
    );
  }

  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  return JSON.stringify(value);
}

const [, , inputPath, outDirArg] = process.argv;

if (!inputPath) {
  console.error("usage: node scripts/write-tokens.mjs <tree.json> [outDir]");
  process.exit(1);
}

const outDir = resolve(outDirArg ?? ".");
const tree = JSON.parse(readFileSync(inputPath, "utf8"));

let count = 0;
for (const relativePath of Object.keys(tree).sort()) {
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, stableStringify(tree[relativePath]) + "\n");
  console.log(target);
  count += 1;
}

console.log(`\nWrote ${count} file${count === 1 ? "" : "s"} to ${outDir}`);
