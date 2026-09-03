// Reading a committed token tree — the inbound contract, ADR-0006 §11.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Manifest } from "../src/tokens/types";
import { ExportInputError, readExportInput } from "../src/export/read";
import type { RepoFile } from "../src/export/read";

const manifest: Manifest = {
  version: 2,
  generatedBy: "tokenvault",
  tokenSetOrder: ["Base/Base", "Theme/Light"],
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
      ],
    },
  ],
  themes: [{ name: "Light", selectedTokenSets: ["Base/Base", "Theme/Light"] }],
};

function token(value: unknown): unknown {
  return { $type: "number", $value: value, $extensions: { "com.tokenvault": {} } };
}

function files(dir: string): RepoFile[] {
  return [
    { path: `${dir}/$manifest.json`, json: manifest },
    { path: `${dir}/base/base.json`, json: { core: { space: token(4) } } },
    { path: `${dir}/theme/light.json`, json: { brand: { size: token(8) } } },
  ];
}

test("the tree is read out of the configured folder, not a hardcoded `tokens/`", () => {
  // `cb086ee` cost one bug from exactly this assumption (ADR-0006 §3).
  const result = readExportInput(files("design-tokens"), "design-tokens");
  assert.deepEqual(
    result.tokens.map((entry) => `${entry.setId}:${entry.path}`),
    ["Base/Base:core.space", "Theme/Light:brand.size"]
  );
});

test("a trailing or leading slash on the folder means the same folder", () => {
  const result = readExportInput(files("design-tokens"), "/design-tokens/");
  assert.equal(result.tokens.length, 2);
});

test("tokens come back in tokenSetOrder, which is what last-wins depends on", () => {
  const result = readExportInput(files("tokens"), "tokens");
  assert.deepEqual(result.tokens.map((entry) => entry.setId), ["Base/Base", "Theme/Light"]);
});

test("files outside the folder are ignored entirely", () => {
  const extra = files("tokens").concat([
    { path: "package.json", json: { name: "not tokens" } },
    { path: "exports/css/light.css.json", json: {} },
  ]);
  assert.equal(readExportInput(extra, "tokens").tokens.length, 2);
});

test("the import report is skipped — ADR-0006 §5 never commits it, and it is not tokens", () => {
  const withReport = files("tokens").concat([
    { path: "tokens/$import-report.json", json: { entries: [] } },
  ]);
  const result = readExportInput(withReport, "tokens");
  assert.equal(result.tokens.length, 2);
  assert.deepEqual(result.unreferenced, []);
});

test("an unknown $-prefixed metadata file is skipped rather than flattened as tokens", () => {
  const withFuture = files("tokens").concat([{ path: "tokens/$future.json", json: { a: 1 } }]);
  assert.equal(readExportInput(withFuture, "tokens").tokens.length, 2);
});

test("a set file the manifest does not name is reported, not silently used", () => {
  const orphan = files("tokens").concat([
    { path: "tokens/theme/old-dark.json", json: { a: token(1) } },
  ]);
  const result = readExportInput(orphan, "tokens");
  assert.deepEqual(result.unreferenced, ["tokens/theme/old-dark.json"]);
  assert.equal(result.tokens.length, 2);
});

test("a missing manifest fails with a sentence that names where it looked", () => {
  assert.throws(
    () => readExportInput([{ path: "tokens/base/base.json", json: {} }], "tokens"),
    (error: Error) => error instanceof ExportInputError && /tokens\/\$manifest\.json/.test(error.message)
  );
});

test("a wrong tokensDir reads as a missing manifest rather than an empty build", () => {
  assert.throws(() => readExportInput(files("tokens"), "design"), ExportInputError);
});

test("a file that is not a manifest is refused by name", () => {
  assert.throws(
    () => readExportInput([{ path: "tokens/$manifest.json", json: { hello: true } }], "tokens"),
    (error: Error) => error instanceof ExportInputError && /not a Tokenvault manifest/.test(error.message)
  );
});

test("a token file that is not an object is refused", () => {
  const broken: RepoFile[] = [
    { path: "tokens/$manifest.json", json: manifest },
    { path: "tokens/base/base.json", json: [1, 2, 3] },
    { path: "tokens/theme/light.json", json: {} },
  ];
  assert.throws(() => readExportInput(broken, "tokens"), ExportInputError);
});
