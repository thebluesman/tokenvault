// Export pipeline visibility — issue #25, `user-journeys.md` §13b gaps 7–9.
//
// Three things carry the whole feature and all three are easy to get subtly wrong, so they are
// where the tests concentrate:
//
//   1. The `paths:` scan. A false *"your build never runs"* is worse than silence, because it sends
//      the user to edit a workflow that was correct — so every shape the scanner doesn't recognise
//      has to come back `unknown`, and that is asserted as hard as the shapes it does recognise.
//   2. The glob matcher, including GitHub's negation rule (last matching pattern wins) and the fact
//      that a single `*` does not cross a `/`.
//   3. The log parse that joins CI's *"the build failed"* to the plugin's *"this token is on a
//      loop"* — the two halves gap 9 says are each correct and never meet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildDetail,
  buildState,
  describeBuild,
  buildFailureLines,
  describeBuildFailure,
  describeMismatch,
  failingJobId,
  failingStep,
  filterCoverage,
  globToRegExp,
  isExportWorkflow,
  matchesFilter,
  parseBuildLog,
  parseOutDir,
  parsePushPaths,
  rankWorkflowCandidates,
  selectRun,
  workflowFilePaths,
  type WorkflowRunSummary,
} from "../src/git/pipeline";
import { buildImport } from "../src/tokens/build";
import { IMPORTED_AT, collection, snapshot, variable } from "./helpers";

const WORKFLOW = readFileSync(
  join(process.cwd(), ".github/workflows/export-tokens.yml"),
  "utf8"
);

function run(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 1,
    path: ".github/workflows/export-tokens.yml",
    name: "Export tokens",
    status: "completed",
    conclusion: "success",
    headSha: "abc",
    createdAt: "2026-09-04T10:00:00Z",
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    runNumber: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The real workflow file — the one this repo actually ships
// ---------------------------------------------------------------------------

test("this repo's own export workflow is recognised, and by what it runs", () => {
  assert.equal(isExportWorkflow(WORKFLOW), true);
  // Not by its filename or its `name:` — a repo may call it anything.
  assert.equal(isExportWorkflow("name: Export tokens\njobs:\n  build:\n    steps: []\n"), false);
});

test("the real workflow's paths filter is read, and it covers the default token folder", () => {
  const paths = parsePushPaths(WORKFLOW);
  assert.equal(paths.kind, "filtered");
  assert.deepEqual(paths.kind === "filtered" ? paths.globs : [], [
    "tokens/**",
    ".github/workflows/export-tokens.yml",
    "src/export/**",
  ]);

  const coverage = filterCoverage(paths, ["tokens/$manifest.json", "tokens/theme/light.json"]);
  assert.equal(coverage.covered, "yes");
  assert.equal(describeMismatch("tokens", coverage, []), null);
});

test("the real workflow's output folder is read, for the link to the generated files", () => {
  assert.equal(parseOutDir(WORKFLOW), "exports");
  assert.equal(parseOutDir("jobs:\n  build:\n    steps: []\n"), null);
});

test("a renamed token folder is caught as a build that never runs — gap 8", () => {
  const paths = parsePushPaths(WORKFLOW);
  const coverage = filterCoverage(paths, ["design-tokens/$manifest.json", "design-tokens/core.json"]);
  assert.equal(coverage.covered, "no");

  const globs = paths.kind === "filtered" ? paths.globs : [];
  const warning = describeMismatch("design-tokens", coverage, globs) ?? "";
  // The consequence, not just the fact — the half that was missing everywhere this was warned
  // before is what makes it actionable.
  assert.match(warning, /design-tokens\//);
  assert.match(warning, /no run at all/);
  assert.match(warning, /paths: filter/);
});

test("a folder only partly covered is a partial mismatch, not a clean bill of health", () => {
  const paths = parsePushPaths("on:\n  push:\n    paths:\n      - 'tokens/*.json'\n");
  const coverage = filterCoverage(paths, ["tokens/core.json", "tokens/theme/light.json"]);
  assert.equal(coverage.covered, "partial");
  assert.deepEqual(coverage.unmatched, ["tokens/theme/light.json"]);
  assert.match(describeMismatch("tokens", coverage, ["tokens/*.json"]) ?? "", /Some of what/);
});

// ---------------------------------------------------------------------------
// The `paths:` scan
// ---------------------------------------------------------------------------

test("a push trigger with no filter runs on everything", () => {
  assert.deepEqual(parsePushPaths("on:\n  push:\n    branches: [main]\n"), { kind: "all" });
  assert.deepEqual(parsePushPaths("on: push\n"), { kind: "all" });
  assert.deepEqual(parsePushPaths("on: [push, workflow_dispatch]\n"), { kind: "all" });
});

test("a flow-style paths list is read too", () => {
  assert.deepEqual(parsePushPaths('on:\n  push:\n    paths: ["tokens/**", "src/export/**"]\n'), {
    kind: "filtered",
    globs: ["tokens/**", "src/export/**"],
  });
});

test("paths-ignore inverts the question rather than being mistaken for paths", () => {
  const paths = parsePushPaths("on:\n  push:\n    paths-ignore:\n      - 'docs/**'\n");
  assert.deepEqual(paths, { kind: "ignore", globs: ["docs/**"] });
  assert.equal(filterCoverage(paths, ["tokens/core.json"]).covered, "yes");
  assert.equal(filterCoverage(paths, ["docs/x.md"]).covered, "no");
});

test("a workflow with no push trigger reports a filter nothing matches", () => {
  const paths = parsePushPaths("on:\n  workflow_dispatch:\n");
  assert.deepEqual(paths, { kind: "filtered", globs: [] });
  const coverage = filterCoverage(paths, ["tokens/core.json"]);
  assert.equal(coverage.covered, "no");
  assert.match(describeMismatch("tokens", coverage, []) ?? "", /no push filter/);
});

test("an unfamiliar shape says unknown rather than warning wrongly", () => {
  // The rule this file exists to protect: silence beats a confident wrong warning.
  for (const yaml of [
    "jobs:\n  build:\n    steps: []\n", // no `on:` at all
    "on:\n  push: {branches: [main]}\n", // inline mapping this scanner won't walk
    "on:\n  push:\n    paths:\n      tokens: yes\n", // a mapping where a sequence was expected
    "on: schedule\n",
  ]) {
    assert.deepEqual(parsePushPaths(yaml), { kind: "unknown" }, yaml);
  }
  assert.equal(filterCoverage({ kind: "unknown" }, ["tokens/core.json"]).covered, "unknown");
  assert.equal(describeMismatch("tokens", { covered: "unknown", unmatched: [] }, []), null);
});

test("comments never become globs", () => {
  const paths = parsePushPaths(
    "on:\n  push:\n    # the folder is duplicated here, GitHub forbids expressions\n    paths:\n      - 'tokens/**' # and here\n"
  );
  assert.deepEqual(paths, { kind: "filtered", globs: ["tokens/**"] });
});

test("a paths: key inside another job isn't mistaken for the push filter", () => {
  const yaml =
    "on:\n  push:\n    branches: [main]\njobs:\n  build:\n    steps:\n      - uses: dorny/paths-filter@v3\n        with:\n          paths:\n            - 'nothing/**'\n";
  assert.deepEqual(parsePushPaths(yaml), { kind: "all" });
});

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

test("a single star does not cross a slash; a double star does", () => {
  assert.equal(globToRegExp("tokens/*.json").test("tokens/core.json"), true);
  assert.equal(globToRegExp("tokens/*.json").test("tokens/theme/light.json"), false);
  assert.equal(globToRegExp("tokens/**").test("tokens/theme/light.json"), true);
  assert.equal(globToRegExp("tokens/**/*.json").test("tokens/core.json"), true);
  assert.equal(globToRegExp("tokens/?.json").test("tokens/a.json"), true);
  assert.equal(globToRegExp("tokens/?.json").test("tokens/ab.json"), false);
});

test("a glob's regex characters stay literal", () => {
  assert.equal(globToRegExp("tokens/a.b.json").test("tokens/aXbXjson"), false);
  assert.equal(globToRegExp("tokens/a+b.json").test("tokens/a+b.json"), true);
});

test("negation follows GitHub's rule — the last matching pattern wins", () => {
  const globs = ["tokens/**", "!tokens/private/**"];
  assert.equal(matchesFilter(globs, "tokens/core.json"), true);
  assert.equal(matchesFilter(globs, "tokens/private/x.json"), false);
  // Re-included by a later positive, which is the whole point of "last wins".
  assert.equal(matchesFilter([...globs, "tokens/private/keep.json"], "tokens/private/keep.json"), true);
  // A list of nothing but negations matches nothing.
  assert.equal(matchesFilter(["!tokens/**"], "tokens/core.json"), false);
});

test("with nothing to push, coverage is unknown rather than a guess", () => {
  assert.equal(filterCoverage({ kind: "filtered", globs: ["tokens/**"] }, []).covered, "unknown");
});

test("the paths the build actually writes are nested, so a flat guess would answer wrongly", () => {
  // The candidate list the panel checks a filter against comes from the last scan. Before a scan
  // there is none, and standing in a plausible-looking flat filename for it is what this asserts
  // against: `build.ts` writes `<tokensDir>/<collection>/<mode>.json`, never `<tokensDir>/x.json`,
  // so a single-level filter that a flat guess satisfies the real files would never match.
  const core = collection("VariableCollectionId:1:1", "Core", [["1:0", "Value"]]);
  const written = buildImport(snapshot([core], [variable("VariableID:1:10", "space/4", core.id, "FLOAT", { "1:0": 4 })]), {
    userSubtypes: {},
    importedAt: IMPORTED_AT,
  })
    .files.map((file) => file.path)
    .filter((path) => !path.endsWith("$import-report.json"));

  const single = parsePushPaths("on:\n  push:\n    paths:\n      - 'tokens/*.json'\n");
  // The fabricated fallback this used to carry.
  assert.equal(filterCoverage(single, ["tokens/$manifest.json", "tokens/core.json"]).covered, "yes");
  // What the build really produces, against the same filter.
  assert.equal(filterCoverage(single, written).covered, "partial");
  assert.deepEqual(filterCoverage(single, written).unmatched, ["tokens/core/value.json"]);
  // And with no scan yet there is no candidate list at all, so the honest answer is the only one.
  assert.equal(filterCoverage(single, []).covered, "unknown");
  assert.equal(describeMismatch("tokens", filterCoverage(single, []), ["tokens/*.json"]), null);
});

// ---------------------------------------------------------------------------
// Build state — gap 7
// ---------------------------------------------------------------------------

test("no workflow, never run, and failed are three different answers", () => {
  const none = buildState({ workflowPath: null, run: null });
  const never = buildState({ workflowPath: ".github/workflows/export-tokens.yml", run: null });
  const failed = buildState({
    workflowPath: ".github/workflows/export-tokens.yml",
    run: run({ conclusion: "failure" }),
  });

  assert.equal(none.kind, "no-workflow");
  assert.equal(never.kind, "never-run");
  assert.equal(failed.kind, "failed");

  // The acceptance criterion, stated as a property: no two of them read the same on screen.
  const said = [none, never, failed].map((state) => describeBuild(state, "main"));
  assert.equal(new Set(said).size, 3);
  assert.match(said[1], /hasn't run on main yet/);
  assert.match(buildDetail(none, "main"), /Add the export workflow/);
});

test("an incomplete run is running, whatever it is queued behind", () => {
  assert.equal(buildState({ workflowPath: "w", run: run({ status: "queued", conclusion: null }) }).kind, "running");
  assert.equal(
    buildState({ workflowPath: "w", run: run({ status: "in_progress", conclusion: null }) }).kind,
    "running"
  );
});

test("a conclusion that is neither success nor failure gets our words, not GitHub's enum", () => {
  const state = buildState({ workflowPath: "w", run: run({ conclusion: "timed_out" }) });
  assert.equal(state.kind, "inconclusive");
  const said = describeBuild(state, "main");
  assert.match(said, /timed out/);
  assert.equal(/timed_out/.test(said), false);
});

test("the failed API read is its own state, and it never claims there was no build", () => {
  const said = describeBuild({ kind: "unknown", run: null }, "main");
  assert.match(said, /Couldn't read/);
  assert.match(buildDetail({ kind: "unknown", run: null }, "main"), /couldn't ask/);
});

test("the newest run of the export workflow wins, and other workflows are ignored", () => {
  const runs = [
    run({ id: 1, createdAt: "2026-09-01T10:00:00Z", runNumber: 1 }),
    run({ id: 2, path: ".github/workflows/tests.yml", createdAt: "2026-09-05T10:00:00Z", runNumber: 9 }),
    run({ id: 3, createdAt: "2026-09-04T10:00:00Z", runNumber: 4 }),
  ];
  assert.equal(selectRun(runs, ".github/workflows/export-tokens.yml")?.id, 3);
  assert.equal(selectRun([], ".github/workflows/export-tokens.yml"), null);
});

test("two runs in the same second fall back to the run number", () => {
  const runs = [
    run({ id: 1, createdAt: "2026-09-04T10:00:00Z", runNumber: 7 }),
    run({ id: 2, createdAt: "2026-09-04T10:00:00Z", runNumber: 8 }),
  ];
  assert.equal(selectRun(runs, null)?.id, 2);
});

// ---------------------------------------------------------------------------
// Finding the workflow file
// ---------------------------------------------------------------------------

test("workflow files are found, and only actual workflow files", () => {
  const paths = workflowFilePaths([
    ".github/workflows/export-tokens.yml",
    ".github/workflows/tests.yaml",
    ".github/workflows/nested/thing.yml",
    ".github/dependabot.yml",
    "tokens/core.json",
  ]);
  assert.deepEqual(paths, [".github/workflows/export-tokens.yml", ".github/workflows/tests.yaml"]);
});

test("the workflow the latest run came from is read first, so the usual case costs one blob", () => {
  const all = [
    ".github/workflows/a.yml",
    ".github/workflows/export-tokens.yml",
    ".github/workflows/tests.yml",
  ];
  assert.equal(rankWorkflowCandidates(all, ".github/workflows/tests.yml")[0], ".github/workflows/tests.yml");
  // With no runs to learn from, a name that mentions tokens or export is the next best guess.
  assert.equal(rankWorkflowCandidates(all, null)[0], ".github/workflows/export-tokens.yml");
});

// ---------------------------------------------------------------------------
// The CI log — gap 9
// ---------------------------------------------------------------------------

const LOG = [
  "2026-09-04T12:00:01.1234567Z ##[group]Run npm run build:tokens",
  "2026-09-04T12:00:02.1234567Z ",
  "2026-09-04T12:00:02.2234567Z 2 problem(s) — nothing was written.",
  "2026-09-04T12:00:02.3234567Z ",
  '2026-09-04T12:00:02.4234567Z   [reference-cycle] Light: "color.brand" is on a reference loop (color.brand → color.accent → color.brand), so it has no value to export.',
  '2026-09-04T12:00:02.5234567Z   [dangling-reference] Dark: "space.lg" references "space.base", which theme "Dark" does not define.',
  "2026-09-04T12:00:03.1234567Z ##[error]Process completed with exit code 1.",
].join("\n");

test("the build's own diagnostics are recovered from the log, timestamps and all", () => {
  const diagnostics = parseBuildLog(LOG);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].kind, "reference-cycle");
  assert.equal(diagnostics[0].theme, "Light");
  assert.equal(diagnostics[0].path, "color.brand");
  // The loop, in the same notation the editor and the apply dialog already render.
  assert.equal(diagnostics[0].loop, "color.brand → color.accent → color.brand");
  assert.equal(diagnostics[1].kind, "dangling-reference");
  assert.equal(diagnostics[1].loop, null);
});

test("only lines in our own format are extracted — a log is never read wholesale", () => {
  const noise = [
    "2026-09-04T12:00:01Z ##[error]Process completed with exit code 1.",
    "2026-09-04T12:00:01Z Authorization: Bearer ghp_notatoken",
    "2026-09-04T12:00:01Z npm ERR! code ELIFECYCLE",
    "2026-09-04T12:00:01Z [not-a-kind] Light: something",
  ].join("\n");
  assert.deepEqual(parseBuildLog(noise), []);
});

test("a log full of diagnostics is capped rather than rendered in full", () => {
  const line = '  [expression-error] Light: "a.b" could not be evaluated: bad operand';
  assert.equal(parseBuildLog(Array(50).fill(line).join("\n")).length, 10);
  assert.equal(parseBuildLog(Array(50).fill(line).join("\n"), 3).length, 3);
});

test("a very long message is truncated, so nothing unbounded reaches the panel", () => {
  const long = `  [expression-error] Light: "${"x".repeat(600)}"`;
  assert.equal(parseBuildLog(long)[0].message.length, 300);
});

test("a cycle failure says cycle, not 'the build failed'", () => {
  const diagnostics = parseBuildLog(LOG);
  const said = describeBuildFailure({ diagnostics, step: "Build tokens" });
  assert.match(said, /reference cycle/);
  assert.match(said, /color\.brand/);
  assert.match(said, /Light/);
  // ADR-0007 §3's promise, restated where the user meets the consequence.
  assert.match(said, /Nothing was written/);
});

test("more than one cycle is counted rather than listed one by one", () => {
  const diagnostics = parseBuildLog(
    [
      '  [reference-cycle] Light: "a" is on a reference loop (a → b → a), so it has no value to export.',
      '  [reference-cycle] Light: "b" is on a reference loop (b → a → b), so it has no value to export.',
    ].join("\n")
  );
  assert.match(describeBuildFailure({ diagnostics, step: null }), /2 tokens on loops/);
});

test("a non-cycle failure is described without borrowing the cycle's words", () => {
  const diagnostics = parseBuildLog(
    '  [dangling-reference] Dark: "space.lg" references "space.base", which theme "Dark" does not define.'
  );
  const said = describeBuildFailure({ diagnostics, step: "Build tokens" });
  assert.match(said, /dangling-reference/);
  assert.equal(/reference cycle/.test(said), false);
});

test("a failure with no readable log still says something true", () => {
  assert.match(
    describeBuildFailure({ diagnostics: [], step: "Build tokens" }),
    /failed at the "Build tokens" step/
  );
  assert.match(
    describeBuildFailure({ diagnostics: [], step: null }),
    /couldn't read why/
  );
});

test("an unreadable log is said once, not twice in two wordings", () => {
  // The jobs read itself failed: no diagnostics, no step, and `describeBuildFailure` bottoms out
  // at its own "couldn't read why", which is the log-unavailable sentence with less in it.
  const lines = buildFailureLines({ diagnostics: [], step: null }, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /couldn't read the build log/);
  assert.equal(/couldn't read why/.test(lines.join(" ")), false);
});

test("a readable reason still carries the log note alongside it", () => {
  // The log was unreadable but the jobs list answered, so the step name is real information the
  // note does not repeat — both lines earn their place.
  const lines = buildFailureLines({ diagnostics: [], step: "Build tokens" }, true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /failed at the "Build tokens" step/);
  assert.match(lines[1], /Actions: read/);

  // Nothing to apologise for when the log was read.
  const read = buildFailureLines({ diagnostics: parseBuildLog(LOG), step: "Build tokens" }, false);
  assert.equal(read.length, 1);
  assert.match(read[0], /reference cycle/);
});

test("the failing job and step are picked out of the run's jobs", () => {
  const jobs = [
    {
      id: 10,
      name: "export",
      conclusion: "success" as string | null,
      steps: [{ name: "Set up job", conclusion: "success" as string | null }],
    },
    {
      id: 11,
      name: "export",
      conclusion: "failure" as string | null,
      steps: [
        { name: "npm ci", conclusion: "success" as string | null },
        { name: "Build tokens", conclusion: "failure" as string | null },
      ],
    },
  ];
  assert.equal(failingStep(jobs), "Build tokens");
  assert.equal(failingJobId(jobs), 11);
  assert.equal(failingStep([jobs[0]]), null);
  assert.equal(failingJobId([jobs[0]]), null);
});
