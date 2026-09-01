import { test } from "node:test";
import assert from "node:assert/strict";

import { buildImport } from "../src/tokens/build";
import { stableStringify } from "../src/tokens/serialize";
import type { FileSnapshot, ReportEntry } from "../src/tokens/types";
import { IMPORTED_AT, alias, collection, fileAt, snapshot, tokenAt, variable } from "./helpers";

/** The worked example from ADR-0002. Two collections, one of them multi-mode, aliases across. */
function adrExample(): FileSnapshot {
  const core = collection("VariableCollectionId:1:1", "Core", [["1:0", "Value"]]);
  const theme = collection("VariableCollectionId:2:1", "Theme", [
    ["2:0", "Light"],
    ["2:1", "Dark"],
  ]);

  return snapshot(
    [theme, core],
    [
      variable("VariableID:1:10", "tv/ref/palette/blue-500", core.id, "COLOR", {
        "1:0": { r: 45 / 255, g: 127 / 255, b: 249 / 255 },
      }),
      variable("VariableID:1:11", "tv/ref/palette/white", core.id, "COLOR", {
        "1:0": { r: 1, g: 1, b: 1 },
      }),
      variable("VariableID:1:12", "tv/ref/palette/grey-900", core.id, "COLOR", {
        "1:0": { r: 0.1, g: 0.1, b: 0.1 },
      }),
      variable("VariableID:1:13", "tv/global/space/4", core.id, "FLOAT", { "1:0": 4 }),
      variable("VariableID:1:14", "tv/global/opacity/disabled", core.id, "FLOAT", { "1:0": 0.4 }, {
        scopes: ["OPACITY"],
      }),
      variable("VariableID:1:15", "tv/global/motion/duration-fast", core.id, "FLOAT", { "1:0": 150 }),
      variable("VariableID:2:10", "tv/color/bg/canvas", theme.id, "COLOR", {
        "2:0": alias("VariableID:1:11"),
        "2:1": alias("VariableID:1:12"),
      }),
      variable("VariableID:2:11", "tv/color/text/accent", theme.id, "COLOR", {
        "2:0": alias("VariableID:1:10"),
        "2:1": alias("VariableID:1:10"),
      }),
      variable("VariableID:2:12", "tv/flag/high-contrast", theme.id, "BOOLEAN", {
        "2:0": false,
        "2:1": true,
      }, { scopes: [] }),
    ]
  );
}

function build(input: FileSnapshot, userSubtypes: Record<string, never> | Record<string, any> = {}) {
  return buildImport(input, { userSubtypes, importedAt: IMPORTED_AT });
}

// ---------------------------------------------------------------------------
// File layout and paths
// ---------------------------------------------------------------------------

test("writes one file per (collection, mode) plus the manifest and report", () => {
  const result = build(adrExample());
  assert.deepEqual(
    result.files.map((file) => file.path),
    [
      "tokens/$import-report.json",
      "tokens/$manifest.json",
      "tokens/core/value.json",
      "tokens/theme/dark.json",
      "tokens/theme/light.json",
    ]
  );
});

test("a single-mode collection still gets a directory, so a second mode causes no rename churn", () => {
  const result = build(adrExample());
  assert.ok(result.files.some((file) => file.path === "tokens/core/value.json"));
});

test("every mode is read, not just the default", () => {
  const result = build(adrExample());
  const light = fileAt(result.files, "tokens/theme/light.json");
  const dark = fileAt(result.files, "tokens/theme/dark.json");

  assert.equal(tokenAt(light, "tv.flag.high-contrast")?.$value, false);
  assert.equal(tokenAt(dark, "tv.flag.high-contrast")?.$value, true);
  assert.equal(tokenAt(light, "tv.color.bg.canvas")?.$value, "{tv.ref.palette.white}");
  assert.equal(tokenAt(dark, "tv.color.bg.canvas")?.$value, "{tv.ref.palette.grey-900}");
});

test("the token path is the variable name, never prefixed with the collection", () => {
  const result = build(adrExample());
  const core = fileAt(result.files, "tokens/core/value.json");
  const light = fileAt(result.files, "tokens/theme/light.json");
  // Both files root at `tv` because both collections' variables are named that way.
  assert.ok(tokenAt(core, "tv.ref.palette.blue-500"));
  assert.ok(tokenAt(light, "tv.color.bg.canvas"));
  assert.equal(tokenAt(light, "Theme.tv.color.bg.canvas"), undefined);
});

// ---------------------------------------------------------------------------
// Types, values, aliases
// ---------------------------------------------------------------------------

test("$type and $value follow ADR §3's table", () => {
  const result = build(adrExample());
  const core = fileAt(result.files, "tokens/core/value.json");
  const light = fileAt(result.files, "tokens/theme/light.json");

  const color = tokenAt(core, "tv.ref.palette.blue-500");
  assert.equal(color?.$type, "color");
  assert.equal(color?.$value, "#2d7ff9");

  const number = tokenAt(core, "tv.global.space.4");
  assert.equal(number?.$type, "number");
  assert.equal(number?.$value, 4);

  const bool = tokenAt(light, "tv.flag.high-contrast");
  assert.equal(bool?.$type, "boolean");
  assert.equal(bool?.$value, false);
});

test("aliases are preserved as references, not resolved to raw values", () => {
  const result = build(adrExample());
  const light = fileAt(result.files, "tokens/theme/light.json");
  assert.equal(tokenAt(light, "tv.color.text.accent")?.$value, "{tv.ref.palette.blue-500}");
});

test("an alias to a library variable is named from aliasTargetNames rather than reported", () => {
  const local = collection("c1", "Local", [["m1", "Value"]]);
  const input = snapshot(
    [local],
    [variable("v1", "brand/primary", local.id, "COLOR", { m1: alias("VariableID:remote:1") })],
    { "VariableID:remote:1": "lib/palette/blue" }
  );

  const result = build(input);
  assert.equal(
    tokenAt(fileAt(result.files, "tokens/local/value.json"), "brand.primary")?.$value,
    "{lib.palette.blue}"
  );
  // Written, but flagged: the library's own tokens are not in this repo, so the reference has
  // nothing to resolve against here.
  const entry = entryFor(result.report.entries, "alias-target-external");
  assert.equal(entry.kind, "dangling-reference");
  assert.equal(entry.set, "Local/Value");
});

test("an unnameable alias target is flagged, not written as a bogus reference", () => {
  const local = collection("c1", "Local", [["m1", "Value"]]);
  const input = snapshot(
    [local],
    [variable("v1", "brand/primary", local.id, "COLOR", { m1: alias("VariableID:gone") })]
  );

  const result = build(input);
  assert.equal(tokenAt(fileAt(result.files, "tokens/local/value.json"), "brand.primary"), undefined);
  assert.equal(reasons(result.report.entries).includes("alias-target-unknown"), true);
});

test("every token carries its Figma provenance for re-import matching and drift detection", () => {
  const result = build(adrExample());
  const dark = fileAt(result.files, "tokens/theme/dark.json");
  const extension = tokenAt(dark, "tv.color.bg.canvas")?.$extensions["com.tokenvault"];

  assert.deepEqual(extension?.figma, {
    variableId: "VariableID:2:10",
    collectionId: "VariableCollectionId:2:1",
    modeId: "2:1",
    scopes: ["ALL_SCOPES"],
  });
});

// ---------------------------------------------------------------------------
// Subtypes
// ---------------------------------------------------------------------------

test("number subtypes are auto-detected, defaulted, or taken from a user tag", () => {
  const result = build(adrExample(), { "VariableID:1:15": "duration" });
  const core = fileAt(result.files, "tokens/core/value.json");

  const opacity = tokenAt(core, "tv.global.opacity.disabled")?.$extensions["com.tokenvault"];
  assert.equal(opacity?.subtype, "opacity");
  assert.equal(opacity?.subtypeSource, "auto");

  const space = tokenAt(core, "tv.global.space.4")?.$extensions["com.tokenvault"];
  assert.equal(space?.subtype, "spacing");
  assert.equal(space?.subtypeSource, "default");

  const duration = tokenAt(core, "tv.global.motion.duration-fast")?.$extensions["com.tokenvault"];
  assert.equal(duration?.subtype, "duration");
  assert.equal(duration?.subtypeSource, "user");
});

test("colours and booleans carry no subtype key at all", () => {
  const result = build(adrExample());
  const core = fileAt(result.files, "tokens/core/value.json");
  const extension = tokenAt(core, "tv.ref.palette.white")?.$extensions["com.tokenvault"];
  assert.equal(extension?.subtype, undefined);
  assert.equal(extension?.subtypeSource, undefined);
});

test("only the importer's own guesses block; auto-detected and user tags do not", () => {
  const result = build(adrExample(), { "VariableID:1:15": "duration" });
  const blocking = result.candidates.filter((candidate) => candidate.needsConfirmation);
  assert.deepEqual(blocking.map((candidate) => candidate.variableName), ["tv/global/space/4"]);
  assert.equal(result.counts.unconfirmedSubtypes, 1);
});

test("confirming a guess as-is flips it from default to user without changing the value", () => {
  const before = build(adrExample());
  const after = build(adrExample(), { "VariableID:1:13": "spacing", "VariableID:1:15": "duration" });

  const path = "tv.global.space.4";
  const beforeToken = tokenAt(fileAt(before.files, "tokens/core/value.json"), path);
  const afterToken = tokenAt(fileAt(after.files, "tokens/core/value.json"), path);

  assert.equal(beforeToken?.$extensions["com.tokenvault"].subtypeSource, "default");
  assert.equal(afterToken?.$extensions["com.tokenvault"].subtypeSource, "user");
  assert.equal(afterToken?.$value, beforeToken?.$value);
  assert.equal(after.counts.unconfirmedSubtypes, 0);
});

test("string variables are offered for tagging but never block the import", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const input = snapshot(
    [core],
    [variable("v1", "motion/ease-out", core.id, "STRING", { m1: "cubic-bezier(0,0,.2,1)" })]
  );

  const result = build(input);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].needsConfirmation, false);
  assert.equal(result.counts.unconfirmedSubtypes, 0);

  const tagged = build(input, { v1: "easing" });
  const extension = tokenAt(fileAt(tagged.files, "tokens/core/value.json"), "motion.ease-out")
    ?.$extensions["com.tokenvault"];
  assert.equal(extension?.subtype, "easing");
  assert.equal(extension?.subtypeSource, "user");
});

// ---------------------------------------------------------------------------
// Manifest and themes
// ---------------------------------------------------------------------------

test("the manifest records collections, modes and set files truthfully", () => {
  const result = build(adrExample());
  assert.deepEqual(result.manifest.tokenSetOrder, ["Core/Value", "Theme/Light", "Theme/Dark"]);
  assert.deepEqual(result.manifest.collections[0], {
    name: "Core",
    slug: "core",
    $figmaCollectionId: "VariableCollectionId:1:1",
    modes: [
      { name: "Value", slug: "value", set: "Core/Value", $figmaModeId: "1:0", file: "core/value.json" },
    ],
  });
});

test("one multi-mode collection yields one theme per mode, plus every single-mode set", () => {
  const result = build(adrExample());
  assert.deepEqual(result.manifest.themes, [
    { name: "Light", selectedTokenSets: ["Core/Value", "Theme/Light"] },
    { name: "Dark", selectedTokenSets: ["Core/Value", "Theme/Dark"] },
  ]);
});

test("two multi-mode collections generate no themes and file a report entry instead", () => {
  // ADR §6 — which combinations are real themes is a product question, not an inference.
  const a = collection("c1", "Alpha", [["a0", "One"], ["a1", "Two"]]);
  const b = collection("c2", "Beta", [["b0", "One"], ["b1", "Two"]]);
  const result = build(
    snapshot([a, b], [
      variable("v1", "alpha/x", a.id, "COLOR", { a0: { r: 0, g: 0, b: 0 }, a1: { r: 1, g: 1, b: 1 } }),
      variable("v2", "beta/y", b.id, "COLOR", { b0: { r: 0, g: 0, b: 0 }, b1: { r: 1, g: 1, b: 1 } }),
    ])
  );

  assert.deepEqual(result.manifest.themes, []);
  const entry = entryFor(result.report.entries, "ambiguous");
  assert.equal(entry.kind, "theme-composition");
  // File-scoped, so no participants and no contested path (Amendment 1 §C).
  assert.equal(entry.participants, undefined);
  assert.equal(entry.path, undefined);
});

test("no multi-mode collection synthesises a single Default theme over every set", () => {
  // Amendment 1 §D — one possible composition is not a guess; only the name is invented.
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const extra = collection("c2", "Extra", [["m2", "Value"]]);
  const result = build(
    snapshot([core, extra], [
      variable("v1", "a/b", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "c/d", extra.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    ])
  );

  assert.deepEqual(result.manifest.themes, [
    { name: "Default", selectedTokenSets: ["Core/Value", "Extra/Value"] },
  ]);
  const entry = entryFor(result.report.entries, "synthesized-default");
  assert.equal(entry.kind, "theme-composition");
  assert.match(entry.message, /safe to rename/);
});

test("a file with no collections at all gets no theme and says so", () => {
  const result = build(snapshot([], []));
  assert.deepEqual(result.manifest.themes, []);
  assert.equal(entryFor(result.report.entries, "no-collections").kind, "theme-composition");
});

// ---------------------------------------------------------------------------
// Collisions (ADR §5)
// ---------------------------------------------------------------------------

function reasons(entries: ReportEntry[]): string[] {
  return entries.map((entry) => entry.reason);
}

function entryFor(entries: ReportEntry[], reason: string): ReportEntry {
  const found = entries.find((entry) => entry.reason === reason);
  assert.ok(found, `expected a report entry with reason "${reason}", got: ${reasons(entries).join(", ")}`);
  return found;
}

test("a case-only clash inside one set keeps the first and reports every participant", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [
      variable("v2", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v1", "color/Brand", core.id, "COLOR", { m1: { r: 1, g: 1, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "same-set-case");
  assert.equal(entry.kind, "collision");
  assert.equal(entry.path, "color.Brand");
  assert.deepEqual(entry.participants?.map((p) => [p.variableId, p.outcome]), [
    ["v1", "written"],
    ["v2", "skipped"],
  ]);

  // Winner written, loser neither written nor renamed.
  const tree = fileAt(result.files, "tokens/core/value.json");
  assert.equal(tokenAt(tree, "color.Brand")?.$value, "#ffffff");
  assert.equal(tokenAt(tree, "color.brand"), undefined);
  assert.equal(result.counts.tokens, 1);
});

test("a token/group clash is reported and the group side is dropped, never mangled", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [
      variable("v1", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand/primary", core.id, "COLOR", { m1: { r: 1, g: 1, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "token-group");
  assert.equal(entry.path, "color.brand");
  assert.deepEqual(entry.participants?.map((p) => [p.variableId, p.outcome]), [
    ["v1", "written"],
    ["v2", "skipped"],
  ]);

  const tree = fileAt(result.files, "tokens/core/value.json");
  assert.equal(tokenAt(tree, "color.brand")?.$value, "#000000");
  assert.equal(tokenAt(tree, "color.brand.primary"), undefined);
});

test("the same path from two collections is a cross-set clash, not an override", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const extra = collection("c2", "Extra", [["m2", "Value"]]);
  const result = build(
    snapshot([core, extra], [
      variable("v1", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand", extra.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "cross-set");
  assert.deepEqual(entry.participants?.map((p) => [p.collectionName, p.outcome]), [
    ["Core", "written"],
    ["Extra", "skipped"],
  ]);

  // The loser is dropped from its own file too — a token that exists in one theme and not
  // another would be worse than a reported non-write.
  assert.ok(tokenAt(fileAt(result.files, "tokens/core/value.json"), "color.brand"));
  assert.equal(tokenAt(fileAt(result.files, "tokens/extra/value.json"), "color.brand"), undefined);
});

test("a collision loser is excluded from every mode file of its collection", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const theme = collection("c2", "Theme", [["t0", "Light"], ["t1", "Dark"]]);
  const result = build(
    snapshot([core, theme], [
      variable("v1", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand", theme.id, "COLOR", {
        t0: { r: 1, g: 1, b: 1 },
        t1: { r: 0.5, g: 0.5, b: 0.5 },
      }),
    ])
  );

  assert.equal(tokenAt(fileAt(result.files, "tokens/theme/light.json"), "color.brand"), undefined);
  assert.equal(tokenAt(fileAt(result.files, "tokens/theme/dark.json"), "color.brand"), undefined);
});

test("with no signal to separate them, name order decides and says so", () => {
  const zeta = collection("c1", "Zeta", [["m1", "Value"]]);
  const alpha = collection("c2", "Alpha", [["m2", "Value"]]);
  const result = build(
    snapshot([zeta, alpha], [
      variable("v1", "a/b", zeta.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "a/b", alpha.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "cross-set");
  assert.equal(entry.winnerRule, "name-order");
  assert.equal(entry.participants?.[0].collectionName, "Alpha");
});

test("collections whose names slug to the same directory do not overwrite each other", () => {
  const a = collection("c1", "Core", [["m1", "Value"]]);
  const b = collection("c2", "core!", [["m2", "Value"]]);
  const result = build(
    snapshot([a, b], [
      variable("v1", "a/b", a.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "c/d", b.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "set-slug");
  assert.equal(entry.kind, "collision");
  assert.equal(result.files.filter((file) => file.path.startsWith("tokens/core/")).length, 1);
  assert.equal(tokenAt(fileAt(result.files, "tokens/core/value.json"), "c.d"), undefined);
});

test("a token aliasing a collision loser is still written, and flagged as dangling", () => {
  // Amendment 1 §G: the reference is real in Figma and resolves the moment the clash is
  // renamed, so excluding the referring token would cascade for no benefit.
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const extra = collection("c2", "Extra", [["m2", "Value"]]);
  const result = build(
    snapshot([core, extra], [
      variable("v1", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand", extra.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
      // Two referrers to Extra's, one to Core's — so Core's loses and v4 is left dangling.
      variable("v3", "extra/useA", extra.id, "COLOR", { m2: alias("v2") }),
      variable("v4", "extra/useB", extra.id, "COLOR", { m2: alias("v2") }),
      variable("v5", "core/use", core.id, "COLOR", { m1: alias("v1") }),
    ])
  );

  const entry = entryFor(result.report.entries, "alias-target-skipped");
  assert.equal(entry.kind, "dangling-reference");

  // The referring token is written, reference intact.
  assert.equal(
    tokenAt(fileAt(result.files, "tokens/core/value.json"), "core.use")?.$value,
    "{color.brand}"
  );
});

// ---------------------------------------------------------------------------
// Unmappable values and unsupported types
// ---------------------------------------------------------------------------

test("Figma resolved types outside the Phase 2 schema are reported, not guessed at", () => {
  // EASING and TIMING postdate ADR §3's four-type table.
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [
      variable("v1", "motion/ease", core.id, "EASING", { m1: null }),
      variable("v2", "motion/duration", core.id, "TIMING", { m1: 200 }),
    ])
  );

  const kinds = result.report.entries.map((entry) => entry.kind);
  assert.deepEqual(kinds.filter((kind) => kind === "unsupported-type").length, 2);
  assert.equal(result.counts.tokens, 0);
});

test("a value whose shape contradicts its resolved type is reported, not coerced", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [variable("v1", "a/b", core.id, "COLOR", { m1: 42 })])
  );
  assert.equal(entryFor(result.report.entries, "type-mismatch").kind, "unmappable-value");
  assert.equal(result.counts.tokens, 0);
});

test("a mode with no value for a variable is reported per set, not filled in", () => {
  const theme = collection("c1", "Theme", [["t0", "Light"], ["t1", "Dark"]]);
  const result = build(
    snapshot([theme], [variable("v1", "a/b", theme.id, "COLOR", { t0: { r: 0, g: 0, b: 0 } })])
  );

  const entry = entryFor(result.report.entries, "missing-mode-value");
  assert.equal(entry.set, "Theme/Dark");
  assert.ok(tokenAt(fileAt(result.files, "tokens/theme/light.json"), "a.b"));
  assert.equal(tokenAt(fileAt(result.files, "tokens/theme/dark.json"), "a.b"), undefined);
});

test("a variable whose name produces no path is reported rather than dropped", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(snapshot([core], [variable("v1", "///", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } })]));
  assert.equal(entryFor(result.report.entries, "empty-path").kind, "unmappable-value");
});

test("the report counts what was written and what was flagged", () => {
  const result = build(adrExample(), { "VariableID:1:15": "duration" });
  assert.equal(result.report.counts.tokens, 12);
  assert.equal(result.report.counts.unconfirmedSubtypes, 1);
  assert.equal(result.report.counts.flagged, result.report.entries.length);
  assert.equal(result.report.figmaFileKey, "testfilekey");
  assert.equal(result.report.importedAt, IMPORTED_AT);
});

// ---------------------------------------------------------------------------
// Determinism (ADR §7)
// ---------------------------------------------------------------------------

function serializeAll(input: FileSnapshot, userSubtypes: Record<string, any> = {}): string {
  return buildImport(input, { userSubtypes, importedAt: IMPORTED_AT })
    .files.map((file) => `--- ${file.path}\n${stableStringify(file.content)}`)
    .join("");
}

test("re-running import against an unchanged file is byte-identical", () => {
  assert.equal(serializeAll(adrExample()), serializeAll(adrExample()));
});

test("output does not depend on the order Figma hands back collections or variables", () => {
  const forward = adrExample();
  const shuffled: FileSnapshot = {
    ...forward,
    collections: forward.collections.slice().reverse(),
    variables: forward.variables.slice().reverse(),
  };
  assert.equal(serializeAll(forward), serializeAll(shuffled));
});

test("serialized token files sort every key alphabetically, $extensions before $type", () => {
  const result = build(adrExample());
  const core = result.files.find((file) => file.path === "tokens/core/value.json");
  const json = stableStringify(core?.content);

  const leaf = json.slice(json.indexOf('"disabled"'));
  assert.ok(leaf.indexOf('"$extensions"') < leaf.indexOf('"$type"'));
  assert.ok(leaf.indexOf('"$type"') < leaf.indexOf('"$value"'));
  assert.ok(json.endsWith("\n"));
});

test("report entries are sorted, so a rerun diffs cleanly", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const input = snapshot([core], [
    variable("v3", "z/z", core.id, "EASING", { m1: null }),
    variable("v1", "color/Brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
    variable("v2", "color/brand", core.id, "COLOR", { m1: { r: 1, g: 1, b: 1 } }),
  ]);

  const first = build(input).report.entries;
  const reversed = build({ ...input, variables: input.variables.slice().reverse() }).report.entries;
  assert.deepEqual(first, reversed);
});

// ---------------------------------------------------------------------------
// Winner selection — Amendment 1 §F (blast radius, not alphabetical order)
// ---------------------------------------------------------------------------

test("the most-referenced participant wins, even when it sorts last alphabetically", () => {
  // The case the amendment exists for: under the superseded "collection name first" rule Alpha
  // would win and take Zeta's two referrers down with it.
  const alpha = collection("c1", "Alpha", [["m1", "Value"]]);
  const zeta = collection("c2", "Zeta", [["m2", "Value"]]);
  const result = build(
    snapshot([alpha, zeta], [
      variable("v1", "color/brand", alpha.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand", zeta.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
      variable("v3", "zeta/a", zeta.id, "COLOR", { m2: alias("v2") }),
      variable("v4", "zeta/b", zeta.id, "COLOR", { m2: alias("v2") }),
    ])
  );

  const entry = entryFor(result.report.entries, "cross-set");
  assert.equal(entry.winnerRule, "alias-references");
  assert.deepEqual(entry.participants?.map((p) => [p.collectionName, p.outcome]), [
    ["Alpha", "skipped"],
    ["Zeta", "written"],
  ]);

  assert.ok(tokenAt(fileAt(result.files, "tokens/zeta/value.json"), "color.brand"));
  assert.equal(tokenAt(fileAt(result.files, "tokens/alpha/value.json"), "color.brand"), undefined);
});

test("a variable aliasing the same target in several modes counts as one referrer", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const theme = collection("c2", "Theme", [["t0", "Light"], ["t1", "Dark"]]);
  const result = build(
    snapshot([core, theme], [
      // Two genuinely distinct referrers for Core's, one double-mode referrer for Theme's.
      variable("v1", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand", theme.id, "COLOR", { t0: { r: 1, g: 1, b: 1 }, t1: { r: 0, g: 0, b: 0 } }),
      variable("v3", "core/a", core.id, "COLOR", { m1: alias("v1") }),
      variable("v4", "core/b", core.id, "COLOR", { m1: alias("v1") }),
      variable("v5", "theme/a", theme.id, "COLOR", { t0: alias("v2"), t1: alias("v2") }),
    ])
  );

  const entry = entryFor(result.report.entries, "cross-set");
  assert.equal(entry.winnerRule, "alias-references");
  assert.equal(entry.participants?.find((p) => p.outcome === "written")?.collectionName, "Core");
});

test("with aliases tied, the collection owning more of the surrounding namespace wins", () => {
  const alpha = collection("c1", "Alpha", [["m1", "Value"]]);
  const zeta = collection("c2", "Zeta", [["m2", "Value"]]);
  const result = build(
    snapshot([alpha, zeta], [
      variable("v1", "ui/color/brand", alpha.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "ui/color/brand", zeta.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
      // Zeta owns the rest of `ui.color`, so it is the more likely home for the token.
      variable("v3", "ui/color/accent", zeta.id, "COLOR", { m2: { r: 1, g: 0, b: 0 } }),
      variable("v4", "ui/color/muted", zeta.id, "COLOR", { m2: { r: 0, g: 1, b: 0 } }),
      // Alpha has variables, but nowhere near the contested path.
      variable("v5", "spacing/small", alpha.id, "COLOR", { m1: { r: 0, g: 0, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "cross-set");
  assert.equal(entry.winnerRule, "namespace-majority");
  assert.equal(entry.participants?.find((p) => p.outcome === "written")?.collectionName, "Zeta");
});

test("winnerRule is recorded on same-set-case and token-group collisions too", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [
      variable("v1", "color/Brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand", core.id, "COLOR", { m1: { r: 1, g: 1, b: 1 } }),
      variable("v3", "size/token", core.id, "COLOR", { m1: { r: 0, g: 0, b: 1 } }),
      variable("v4", "size/token/nested", core.id, "COLOR", { m1: { r: 0, g: 1, b: 0 } }),
    ])
  );

  assert.equal(entryFor(result.report.entries, "same-set-case").winnerRule, "name-order");
  assert.equal(entryFor(result.report.entries, "token-group").winnerRule, "name-order");
});

test("a referenced token beats an unreferenced one inside a token/group clash", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [
      variable("v1", "color/brand", core.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "color/brand/primary", core.id, "COLOR", { m1: { r: 1, g: 1, b: 1 } }),
      variable("v3", "use/it", core.id, "COLOR", { m1: alias("v2") }),
    ])
  );

  const entry = entryFor(result.report.entries, "token-group");
  assert.equal(entry.winnerRule, "alias-references");
  // The nested token is referenced, so the bare `color.brand` is the one dropped.
  const tree = fileAt(result.files, "tokens/core/value.json");
  assert.ok(tokenAt(tree, "color.brand.primary"));
  assert.equal(tokenAt(tree, "color.brand"), undefined);
});

test("a slug clash is won by the collection with more variables", () => {
  const big = collection("c1", "Core", [["m1", "Value"]]);
  const small = collection("c2", "core!", [["m2", "Value"]]);
  const result = build(
    snapshot([small, big], [
      variable("v1", "a/b", big.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "a/c", big.id, "COLOR", { m1: { r: 0, g: 0, b: 1 } }),
      variable("v3", "z/z", small.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    ])
  );

  const entry = entryFor(result.report.entries, "set-slug");
  assert.equal(entry.winnerRule, "variable-count");
  assert.equal(entry.participants?.find((p) => p.outcome === "written")?.collectionName, "Core");
  // Participants carry collection identity only — the contest is between collections (§E).
  assert.deepEqual(entry.participants?.map((p) => p.variableId), ["", ""]);
});

test("an evenly matched slug clash falls back to name order", () => {
  const a = collection("c1", "Core", [["m1", "Value"]]);
  const b = collection("c2", "core!", [["m2", "Value"]]);
  const result = build(
    snapshot([a, b], [
      variable("v1", "a/b", a.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
      variable("v2", "z/z", b.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    ])
  );
  assert.equal(entryFor(result.report.entries, "set-slug").winnerRule, "name-order");
});

test("winner selection does not depend on the order Figma returns variables", () => {
  const alpha = collection("c1", "Alpha", [["m1", "Value"]]);
  const zeta = collection("c2", "Zeta", [["m2", "Value"]]);
  const input = snapshot([alpha, zeta], [
    variable("v1", "color/brand", alpha.id, "COLOR", { m1: { r: 0, g: 0, b: 0 } }),
    variable("v2", "color/brand", zeta.id, "COLOR", { m2: { r: 1, g: 1, b: 1 } }),
    variable("v3", "zeta/a", zeta.id, "COLOR", { m2: alias("v2") }),
  ]);

  assert.equal(serializeAll(input), serializeAll({ ...input, variables: input.variables.slice().reverse() }));
});

// ---------------------------------------------------------------------------
// Per-mode reference resolution
// ---------------------------------------------------------------------------

test("a reference dangles only in the mode where its target has no value", () => {
  // The target exists overall, so a whole-file "was this written anywhere" check misses it.
  const theme = collection("c1", "Theme", [["t0", "Light"], ["t1", "Dark"]]);
  const result = build(
    snapshot([theme], [
      variable("v1", "core/a", theme.id, "COLOR", { t0: { r: 0, g: 0, b: 0 } }),
      variable("v2", "use/it", theme.id, "COLOR", { t0: alias("v1"), t1: alias("v1") }),
    ])
  );

  const dangling = result.report.entries.filter((entry) => entry.kind === "dangling-reference");
  assert.deepEqual(dangling.map((entry) => entry.set), ["Theme/Dark"]);
  assert.equal(dangling[0].reason, "alias-target-missing-in-mode");

  // The referring token is written in both modes — the reference is what Figma points at.
  assert.equal(tokenAt(fileAt(result.files, "tokens/theme/light.json"), "use.it")?.$value, "{core.a}");
  assert.equal(tokenAt(fileAt(result.files, "tokens/theme/dark.json"), "use.it")?.$value, "{core.a}");
});

test("a fully-resolvable reference produces no dangling entry in any mode", () => {
  const theme = collection("c1", "Theme", [["t0", "Light"], ["t1", "Dark"]]);
  const result = build(
    snapshot([theme], [
      variable("v1", "core/a", theme.id, "COLOR", { t0: { r: 0, g: 0, b: 0 }, t1: { r: 1, g: 1, b: 1 } }),
      variable("v2", "use/it", theme.id, "COLOR", { t0: alias("v1"), t1: alias("v1") }),
    ])
  );
  assert.equal(result.report.entries.some((entry) => entry.kind === "dangling-reference"), false);
});

test("a cross-collection mode gap names the sets with the hole rather than blaming this one", () => {
  const theme = collection("c1", "Theme", [["t0", "Light"], ["t1", "Dark"]]);
  const core = collection("c2", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([theme, core], [
      variable("v1", "core/a", theme.id, "COLOR", { t0: { r: 0, g: 0, b: 0 } }),
      variable("v2", "use/it", core.id, "COLOR", { m1: alias("v1") }),
    ])
  );

  const entry = entryFor(result.report.entries, "alias-target-missing-in-mode");
  assert.equal(entry.set, "Core/Value");
  assert.match(entry.message, /Theme\/Dark/);
});

test("a target with no usable value in any mode is reported as skipped, not missing-in-mode", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const result = build(
    snapshot([core], [
      variable("v1", "core/a", core.id, "COLOR", {}),
      variable("v2", "use/it", core.id, "COLOR", { m1: alias("v1") }),
    ])
  );
  assert.equal(entryFor(result.report.entries, "alias-target-skipped").kind, "dangling-reference");
});

// ---------------------------------------------------------------------------
// Subtype clearing
// ---------------------------------------------------------------------------

test("choosing untagged writes no subtype but records that a human chose it", () => {
  const core = collection("c1", "Core", [["m1", "Value"]]);
  const input = snapshot([core], [
    variable("v1", "motion/fast", core.id, "FLOAT", { m1: 150 }, { scopes: ["OPACITY"] }),
  ]);

  const result = build(input, { v1: "untagged" });
  const extension = tokenAt(fileAt(result.files, "tokens/core/value.json"), "motion.fast")
    ?.$extensions["com.tokenvault"];

  assert.equal(extension?.subtype, undefined);
  assert.equal(extension?.subtypeSource, "user");
  // Confirmed by a human, so it no longer blocks.
  assert.equal(result.counts.unconfirmedSubtypes, 0);
  assert.equal(result.candidates[0].needsConfirmation, false);
});

// ---------------------------------------------------------------------------
// Namespace tally hygiene
// ---------------------------------------------------------------------------

test("variables already dropped by an earlier pass do not pad the namespace tally", () => {
  // Aye has two variables under `ui.color`, but they are a case-only clash, so only one
  // survives. Counting the dropped one would tie the tally at 2-2 and hand the token/group
  // contest to Aye on name order; counting only survivors gives Bee the namespace majority.
  const aye = collection("c1", "Aye", [["m1", "Value"]]);
  const bee = collection("c2", "Bee", [["m2", "Value"]]);
  const black = { r: 0, g: 0, b: 0 };

  const result = build(
    snapshot([aye, bee], [
      variable("v1", "ui/color/brand", aye.id, "COLOR", { m1: black }),
      variable("v2", "ui/color/brand/primary", bee.id, "COLOR", { m2: black }),
      variable("v3", "ui/color/X", aye.id, "COLOR", { m1: black }),
      variable("v4", "ui/color/x", aye.id, "COLOR", { m1: black }),
      variable("v5", "ui/color/y", bee.id, "COLOR", { m2: black }),
      variable("v6", "ui/color/z", bee.id, "COLOR", { m2: black }),
    ])
  );

  const entry = entryFor(result.report.entries, "token-group");
  assert.equal(entry.winnerRule, "namespace-majority");
  assert.equal(entry.participants?.find((p) => p.outcome === "written")?.collectionName, "Bee");

  assert.ok(tokenAt(fileAt(result.files, "tokens/bee/value.json"), "ui.color.brand.primary"));
  assert.equal(tokenAt(fileAt(result.files, "tokens/aye/value.json"), "ui.color.brand"), undefined);
});
