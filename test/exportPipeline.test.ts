// The pipeline end to end — CSS output, determinism, and the output-location rule.
//
// These exercise Style Dictionary, but they are not tests *of* Style Dictionary: what is asserted
// is the contract this project makes to consumers — a stable path, a clock-free header, no
// `[object Object]` where a composite was, and nothing written where Phase 6's drift check looks.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest } from "../src/tokens/types";
import type { RepoFile } from "../src/export/read";
import { ExportConfigError, assertOutsideTokensDir, cssOutputPath, runExport } from "../src/export/pipeline";
import { shadowToCss } from "../src/export/css";
import { inTokensDir } from "../src/git/paths";

const manifest: Manifest = {
  version: 2,
  generatedBy: "tokenvault",
  tokenSetOrder: ["Base/Base", "Theme/Light", "Theme/Dark"],
  collections: [
    {
      name: "Base",
      slug: "base",
      $figmaCollectionId: "C:base",
      modes: [
        { name: "Base", slug: "base", set: "Base/Base", $figmaModeId: "M:base", file: "base/base.json" },
      ],
    },
    {
      name: "Theme",
      slug: "theme",
      $figmaCollectionId: "C:theme",
      modes: [
        { name: "Light", slug: "light", set: "Theme/Light", $figmaModeId: "M:light", file: "theme/light.json" },
        { name: "Dark", slug: "dark", set: "Theme/Dark", $figmaModeId: "M:dark", file: "theme/dark.json" },
      ],
    },
  ],
  themes: [
    { name: "Light", selectedTokenSets: ["Base/Base", "Theme/Light"] },
    { name: "Dark", selectedTokenSets: ["Base/Base", "Theme/Dark"] },
  ],
};

function token(type: string, value: unknown): unknown {
  return { $type: type, $value: value, $extensions: { "com.tokenvault": { figma: {} } } };
}

const FILES: RepoFile[] = [
  { path: "tokens/$manifest.json", json: manifest },
  {
    path: "tokens/base/base.json",
    json: {
      core: {
        space: { "4": token("number", 4), "8": token("number", "{core.space.4} * 2") },
        radius: token("number", "{core.space.4}"),
      },
    },
  },
  {
    path: "tokens/theme/light.json",
    json: { color: { bg: token("color", "#ffffff"), fg: token("color", "#111111") } },
  },
  {
    path: "tokens/theme/dark.json",
    json: { color: { bg: token("color", "#000000"), fg: token("color", "#eeeeee") } },
  },
];

const OPTIONS = { tokensDir: "tokens", outDir: "exports" };

// ---------------------------------------------------------------------------
// Output location — the load-bearing one
// ---------------------------------------------------------------------------

test("nothing is written where Phase 6's drift check looks", () => {
  // ADR-0006 §3, §4: sync is a blob SHA per file under `tokensDir`. A generated file in there would
  // be read as repo-side drift on the next status check, and every token file would misread as
  // diverged. Asserted with `git/paths.ts`'s own predicate, so the two can't drift apart.
  return runExport(FILES, OPTIONS).then((run) => {
    for (const output of run.outputs) {
      assert.equal(inTokensDir(output.path, "tokens"), false, `${output.path} is inside tokensDir`);
    }
  });
});

test("an output folder inside the token folder is refused before anything is built", () => {
  assert.throws(() => assertOutsideTokensDir("tokens/dist", "tokens"), ExportConfigError);
  assert.throws(() => assertOutsideTokensDir("tokens", "tokens"), ExportConfigError);
  assert.throws(() => assertOutsideTokensDir("", "tokens"), ExportConfigError);
});

test("a token folder at the repo root leaves nowhere safe to write, and says so", () => {
  assert.throws(
    () => assertOutsideTokensDir("exports", ""),
    (error: Error) => error instanceof ExportConfigError && /repository root/.test(error.message)
  );
});

test("a folder that merely shares a prefix is fine", () => {
  // `tokens-dist` is not inside `tokens`.
  assertOutsideTokensDir("tokens-dist", "tokens");
});

test("output paths are stable and namespaced by target", () => {
  assert.equal(cssOutputPath("exports", "light"), "exports/css/light.css");
  assert.equal(cssOutputPath("exports/", "light"), "exports/css/light.css");
});

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

test("one file per theme, named by the theme", async () => {
  const run = await runExport(FILES, OPTIONS);
  assert.deepEqual(run.outputs.map((output) => output.path), [
    "exports/css/light.css",
    "exports/css/dark.css",
  ]);
  assert.deepEqual(run.diagnostics, []);
});

test("each theme resolves through its own stack", async () => {
  const run = await runExport(FILES, OPTIONS);
  const [light, dark] = run.outputs;
  assert.match(light.content, /--color-bg: #ffffff;/);
  assert.match(dark.content, /--color-bg: #000000;/);
});

test("a reference is emitted as the value it resolves to", async () => {
  const [light] = (await runExport(FILES, OPTIONS)).outputs;
  assert.match(light.content, /--core-radius: 4;/);
});

test("an expression is emitted as its computed number, never as its source string", async () => {
  const [light] = (await runExport(FILES, OPTIONS)).outputs;
  assert.match(light.content, /--core-space-8: 8;/);
  assert.equal(/\* 2/.test(light.content), false);
});

test("numbers stay unitless — the token carries no unit and the export invents none", async () => {
  const [light] = (await runExport(FILES, OPTIONS)).outputs;
  assert.equal(/--core-space-4: 4px/.test(light.content), false);
  assert.match(light.content, /--core-space-4: 4;/);
});

test("the header says the file is generated and carries no clock", async () => {
  const [light] = (await runExport(FILES, OPTIONS)).outputs;
  assert.match(light.content, /Generated by Tokenvault\. Do not edit directly\./);
  assert.match(light.content, /Theme: Light/);
  // A timestamp is the one thing that would make every rebuild a diff (ADR-0002 §7).
  assert.equal(/\d{4}-\d{2}-\d{2}|GMT|UTC/.test(light.content), false);
});

test("the same input produces byte-identical output", async () => {
  const first = await runExport(FILES, OPTIONS);
  const second = await runExport(FILES.slice().reverse(), OPTIONS);
  assert.deepEqual(
    first.outputs.map((output) => output.content),
    second.outputs.map((output) => output.content)
  );
});

// ---------------------------------------------------------------------------
// Composite values
// ---------------------------------------------------------------------------

test("a shadow becomes a box-shadow value, not [object Object]", async () => {
  const shadow = {
    blur: { unit: "px", value: 4 },
    color: "#00000033",
    inset: false,
    offsetX: { unit: "px", value: 0 },
    offsetY: { unit: "px", value: 2 },
    spread: { unit: "px", value: 0 },
  };
  const files = FILES.concat([
    { path: "tokens/styles/effect.json", json: { elevation: { low: token("shadow", shadow) } } },
  ]);
  const withStyles: Manifest = {
    ...manifest,
    tokenSetOrder: manifest.tokenSetOrder.concat(["Styles/Effect"]),
    styleSets: [
      { file: "styles/effect.json", kind: "EFFECT", name: "Effect", set: "Styles/Effect", slug: "effect" },
    ],
    themes: manifest.themes.map((theme) => ({
      ...theme,
      selectedTokenSets: theme.selectedTokenSets.concat(["Styles/Effect"]),
    })),
  };
  const run = await runExport(
    files.map((file) => (file.path.endsWith("$manifest.json") ? { ...file, json: withStyles } : file)),
    OPTIONS
  );
  assert.match(run.outputs[0].content, /--elevation-low: 0px 2px 4px 0px #00000033;/);
});

test("an inset shadow keeps the keyword, in CSS's own order", () => {
  assert.equal(
    shadowToCss({
      blur: { unit: "px", value: 1 },
      color: "#000000",
      inset: true,
      offsetX: { unit: "px", value: 0 },
      offsetY: { unit: "px", value: 0 },
      spread: { unit: "px", value: 2 },
    }),
    "inset 0px 0px 1px 2px #000000"
  );
});

test("typography and grid are skipped and counted, not emitted as objects", async () => {
  const typography = {
    fontFamily: "Inter",
    fontSize: { unit: "px", value: 16 },
    fontWeight: 400,
    letterSpacing: { unit: "px", value: 0 },
  };
  const withText: Manifest = {
    ...manifest,
    tokenSetOrder: manifest.tokenSetOrder.concat(["Styles/Text"]),
    styleSets: [
      { file: "styles/text.json", kind: "TEXT", name: "Text", set: "Styles/Text", slug: "text" },
    ],
    themes: manifest.themes.map((theme) => ({
      ...theme,
      selectedTokenSets: theme.selectedTokenSets.concat(["Styles/Text"]),
    })),
  };
  const files = FILES.map((file) =>
    file.path.endsWith("$manifest.json") ? { ...file, json: withText } : file
  ).concat([
    { path: "tokens/styles/text.json", json: { type: { body: token("typography", typography) } } },
  ]);

  const run = await runExport(files, OPTIONS);
  assert.equal(/object Object/.test(run.outputs[0].content), false);
  assert.equal(/--type-body/.test(run.outputs[0].content), false);
  assert.deepEqual(run.themes[0].skipped.map((entry) => entry.path), ["type.body"]);
});

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

test("a cycle is reported against the theme it appears in, and no value is invented", async () => {
  const broken = FILES.map((file) =>
    file.path === "tokens/base/base.json"
      ? {
          path: file.path,
          json: { a: token("number", "{b} + 1"), b: token("number", "{a} * 2") },
        }
      : file
  );
  const run = await runExport(broken, OPTIONS);
  assert.ok(run.diagnostics.length >= 2);
  assert.ok(run.diagnostics.every((one) => one.kind === "reference-cycle"));
  assert.deepEqual([...new Set(run.diagnostics.map((one) => one.theme))], ["Light", "Dark"]);
  assert.equal(/--a:|--b:/.test(run.outputs[0].content), false);
});

test("a manifest with no themes still produces one stylesheet", async () => {
  const files = FILES.map((file) =>
    file.path.endsWith("$manifest.json") ? { ...file, json: { ...manifest, themes: [] } } : file
  );
  const run = await runExport(files, OPTIONS);
  assert.deepEqual(run.outputs.map((output) => output.path), ["exports/css/default.css"]);
  // Every set, in order, last one wins — so the dark values win the collided paths.
  assert.match(run.outputs[0].content, /--color-bg: #000000;/);
});
