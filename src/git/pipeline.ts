// What happened after the push — issue #25, PRD §6.6, §9.10.
//
// Three questions the panel could not answer until now, and `user-journeys.md` §13b calls them
// three symptoms of one missing surface:
//
//   1. Did the export build run, and what did it say?
//   2. Does the workflow's `paths:` filter actually contain the folder Settings pushes to? GitHub
//      forbids expressions in `paths:`, so the folder is written twice and a mismatch is a build
//      that **silently never runs** — no failed run to notice, nothing red anywhere.
//   3. When the build failed, did it fail on a *reference cycle* — the one failure the plugin
//      already has a whole vocabulary for (ADR-0007 §3) — or on something else?
//
// Everything here is pure: it takes API payloads that `api.ts` already reduced, plus the text of a
// workflow file and of a job log, and returns states and sentences. No `fetch`, no DOM, so all of
// it is unit-testable, which is where the three fiddly parts live — the `paths:` scan, the glob
// matcher, and the log parse.
//
// **Read-only, always.** Nothing in this phase triggers, re-runs or cancels a build, and nothing
// rewrites a workflow file to fix a mismatch. A mismatch is *warned*, never repaired: the fix is a
// commit to the repo, and the panel is not the place a workflow gets edited from.

export const WORKFLOW_DIR = ".github/workflows/";

/** The `npm run` script the export workflow invokes — how a workflow is recognised as *ours*. */
const BUILD_SCRIPT = "build:tokens";

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

/** One `GET /actions/runs` entry, reduced to what the panel reasons about. */
export interface WorkflowRunSummary {
  id: number;
  /** The workflow file this run came from, e.g. `.github/workflows/export-tokens.yml`. */
  path: string;
  name: string;
  /** `queued` | `in_progress` | `completed` | GitHub's newer waiting states. */
  status: string;
  /** `success` | `failure` | `cancelled` | `timed_out` | … — `null` until the run completes. */
  conclusion: string | null;
  headSha: string;
  createdAt: string;
  htmlUrl: string;
  runNumber: number;
}

export interface WorkflowJobSummary {
  id: number;
  name: string;
  conclusion: string | null;
  steps: Array<{ name: string; conclusion: string | null }>;
}

/**
 * The state of the export build, as the panel talks about it.
 *
 * `no-workflow`, `never-run` and `failed` are three different things and the acceptance criteria
 * ask for all three to be distinguishable: a repo with no export workflow at all is a setup that
 * was never finished, a workflow that has never run on this branch is a setup that is finished and
 * simply hasn't been triggered, and a failed run is a build that ran and said no. Collapsing any
 * two of them into "no build yet" is the exact ambiguity this ticket exists to remove.
 */
export type BuildStateKind =
  | "no-workflow"
  | "never-run"
  | "running"
  | "success"
  | "failed"
  | "inconclusive"
  /** The Actions read itself didn't land. Not a build state — an absence of one. */
  | "unknown";

export interface BuildState {
  kind: BuildStateKind;
  run: WorkflowRunSummary | null;
}

/**
 * The newest run of the export workflow on this branch.
 *
 * Sorted here rather than trusted from GitHub: the list endpoint is documented newest-first, but a
 * status line that silently depends on somebody else's sort order is a bug waiting for the day
 * they change it. `createdAt` first, run number as the tiebreak for two runs in the same second.
 */
export function selectRun(
  runs: WorkflowRunSummary[],
  workflowPath: string | null
): WorkflowRunSummary | null {
  const candidates =
    workflowPath === null ? runs.slice() : runs.filter((run) => run.path === workflowPath);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const at = Date.parse(a.createdAt);
    const bt = Date.parse(b.createdAt);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
    return b.runNumber - a.runNumber;
  });
  return candidates[0];
}

export function buildState(options: {
  /** Null when no workflow in the repo builds tokens. */
  workflowPath: string | null;
  run: WorkflowRunSummary | null;
}): BuildState {
  if (options.workflowPath === null) return { kind: "no-workflow", run: null };
  const run = options.run;
  if (run === null) return { kind: "never-run", run: null };
  if (run.status !== "completed") return { kind: "running", run };
  if (run.conclusion === "success") return { kind: "success", run };
  if (run.conclusion === "failure") return { kind: "failed", run };
  return { kind: "inconclusive", run };
}

/** The one-line headline for a state — the panel's own words, never GitHub's (ADR-0006 §10). */
export function describeBuild(state: BuildState, branch: string): string {
  switch (state.kind) {
    case "no-workflow":
      return "No export workflow in this repo.";
    case "never-run":
      return `The export workflow hasn't run on ${branch} yet.`;
    case "running":
      return "Export build running…";
    case "success":
      return "Export build passed.";
    case "failed":
      return "Export build failed.";
    case "inconclusive":
      return `Export build ${conclusionWord(state.run?.conclusion ?? null)}.`;
    default:
      return "Couldn't read this repo's builds.";
  }
}

/** The second line: why the state matters, or what to do about it. Empty when it needs none. */
export function buildDetail(state: BuildState, branch: string): string {
  switch (state.kind) {
    case "no-workflow":
      return "Nothing rebuilds the exported CSS when you push. Add the export workflow to the repo to turn it on.";
    case "never-run":
      return "Push a token change, and it will build from then on.";
    case "failed":
      return `Your tokens are on ${branch}, but the generated files were not rebuilt.`;
    case "inconclusive":
      return "The generated files may not match what's on the branch.";
    case "unknown":
      return "The build may be fine — Tokenvault just couldn't ask. Nothing about your tokens is affected.";
    default:
      return "";
  }
}

function conclusionWord(conclusion: string | null): string {
  // A small, closed vocabulary of our own. GitHub's raw enum (`timed_out`, `action_required`) is
  // not a sentence, and passing it through would put their words on our screen.
  switch (conclusion) {
    case "cancelled":
      return "was cancelled";
    case "timed_out":
      return "timed out";
    case "skipped":
      return "was skipped";
    case "action_required":
      return "needs someone to approve it";
    case "stale":
      return "went stale";
    case "neutral":
      return "finished without a verdict";
    default:
      return "didn't finish";
  }
}

// ---------------------------------------------------------------------------
// Finding the export workflow
// ---------------------------------------------------------------------------

/** Every workflow file in a repo tree, at most `limit` of them. */
export function workflowFilePaths(treePaths: string[], limit = 10): string[] {
  return treePaths
    .filter(
      (path) =>
        path.startsWith(WORKFLOW_DIR) &&
        (path.endsWith(".yml") || path.endsWith(".yaml")) &&
        path.indexOf("/", WORKFLOW_DIR.length) === -1
    )
    .sort()
    .slice(0, limit);
}

/**
 * The order to read those files in, so the usual case costs one blob.
 *
 * The workflow the latest run came from is the strongest hint there is; a name that mentions the
 * export or tokens is the next. Everything else follows, because a repo is allowed to name its
 * workflow anything and the *content* is what decides (`isExportWorkflow`).
 */
export function rankWorkflowCandidates(paths: string[], latestRunPath: string | null): string[] {
  const score = (path: string): number => {
    if (latestRunPath !== null && path === latestRunPath) return 0;
    const name = path.slice(WORKFLOW_DIR.length).toLowerCase();
    if (name.includes("export") || name.includes("token")) return 1;
    return 2;
  };
  return paths.slice().sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}

/** Whether a workflow file is the one that builds tokens — by what it runs, not what it's called. */
export function isExportWorkflow(yaml: string): boolean {
  return stripComments(yaml).includes(BUILD_SCRIPT);
}

/**
 * The folder the workflow writes generated files to, if it says so plainly.
 *
 * Read only so the panel can offer a link to it. `null` means "don't offer the link" rather than
 * "assume `exports/`": a link to a folder that doesn't exist is worse than no link.
 */
export function parseOutDir(yaml: string): string | null {
  const match = /^\s*OUT_DIR:\s*(.+?)\s*$/m.exec(stripComments(yaml));
  if (match === null) return null;
  const value = unquote(match[1]);
  return value.length === 0 ? null : value.replace(/^\/+/, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// The `paths:` filter — gap 8
// ---------------------------------------------------------------------------

export type PushPaths =
  /** Every push to the branch triggers it: no `paths:` filter at all. */
  | { kind: "all" }
  | { kind: "filtered"; globs: string[] }
  | { kind: "ignore"; globs: string[] }
  /** The file is shaped in a way this scanner won't guess at. Say nothing rather than warn wrongly. */
  | { kind: "unknown" };

/**
 * `on.push.paths`, by an indentation scan rather than a YAML parser.
 *
 * A real YAML parser is a dependency, and PRD §8's zero-cost constraint is about recurring spend
 * rather than bundle size — but a parser is also the wrong tool for a question this narrow. What
 * matters far more than completeness is that an unfamiliar shape returns `unknown`: **a false
 * "your build never runs" is worse than silence**, because it sends the user to edit a workflow
 * that was correct. Every branch below that isn't certain returns `unknown`.
 */
export function parsePushPaths(yaml: string): PushPaths {
  const lines = stripComments(yaml).split(/\r?\n/);

  const onAt = lines.findIndex((line) => /^(on|"on"|'on'):/.test(line));
  if (onAt === -1) return { kind: "unknown" };

  const onInline = lines[onAt].slice(lines[onAt].indexOf(":") + 1).trim();
  if (onInline.length > 0) {
    // `on: push` or `on: [push, workflow_dispatch]` — a trigger with no filter of any kind.
    return /push/.test(onInline) ? { kind: "all" } : { kind: "unknown" };
  }

  const onBlock = blockAfter(lines, onAt);
  const pushAt = findKey(lines, onBlock, "push");
  // No `push:` trigger at all means a token push triggers nothing — which is the same practical
  // outcome as a filter that excludes the folder, and is reported the same way.
  if (pushAt === -1) return { kind: "filtered", globs: [] };

  const pushInline = lines[pushAt].slice(lines[pushAt].indexOf(":") + 1).trim();
  if (pushInline.length > 0) return { kind: "unknown" };

  const pushBlock = blockAfter(lines, pushAt);
  const pathsAt = findKey(lines, pushBlock, "paths");
  if (pathsAt !== -1) {
    const globs = listAfter(lines, pathsAt);
    return globs === null ? { kind: "unknown" } : { kind: "filtered", globs };
  }

  const ignoreAt = findKey(lines, pushBlock, "paths-ignore");
  if (ignoreAt !== -1) {
    const globs = listAfter(lines, ignoreAt);
    return globs === null ? { kind: "unknown" } : { kind: "ignore", globs };
  }

  return { kind: "all" };
}

function stripComments(yaml: string): string {
  // Path globs don't contain `#`, and every `#` in a workflow file that isn't inside a quoted
  // string starts a comment. Quoted `#` would survive as part of the value, which is why the
  // stripper only fires when the `#` follows whitespace or opens the line.
  return yaml.replace(/(^|\s)#.*$/gm, "$1");
}

function indentOf(line: string): number {
  return line.length - line.replace(/^\s*/, "").length;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

/** The line range nested under `lines[at]`, by indentation. */
function blockAfter(lines: string[], at: number): [number, number] {
  const base = indentOf(lines[at]);
  let end = at + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > base)) end += 1;
  return [at + 1, end];
}

/** A direct child key of a block — one nesting level, so `paths:` under another job isn't found. */
function findKey(lines: string[], [from, to]: [number, number], key: string): number {
  let childIndent = -1;
  for (let i = from; i < to; i += 1) {
    if (isBlank(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (childIndent === -1) childIndent = indent;
    if (indent !== childIndent) continue;
    const match = /^\s*([A-Za-z0-9_-]+)\s*:/.exec(lines[i]);
    if (match !== null && match[1] === key) return i;
  }
  return -1;
}

/** The `- item` list under `lines[at]`. `null` when it is a flow list or something else entirely. */
function listAfter(lines: string[], at: number): string[] | null {
  const inline = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  if (inline.length > 0) {
    if (!inline.startsWith("[") || !inline.endsWith("]")) return null;
    return inline
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter((item) => item.length > 0);
  }

  const [from, to] = blockAfter(lines, at);
  const globs: string[] = [];
  for (let i = from; i < to; i += 1) {
    if (isBlank(lines[i])) continue;
    const match = /^\s*-\s*(.+?)\s*$/.exec(lines[i]);
    // A non-item line inside the block means this isn't the plain sequence we know how to read.
    if (match === null) return null;
    globs.push(unquote(match[1]));
  }
  return globs;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Glob matching, GitHub's dialect
// ---------------------------------------------------------------------------

/**
 * One filter glob as a regular expression.
 *
 * GitHub's rules for `paths`: `*` matches anything except `/`, `**` matches anything including `/`,
 * `?` matches one character except `/`. Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` collapses so `tokens/**/x` also matches `tokens/x`, which is how git's pathspec
        // and GitHub's filter both behave.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a path passes a filter list, with GitHub's negation rule: **the last matching pattern
 * wins**. A list with no positive pattern matches nothing.
 */
export function matchesFilter(globs: string[], path: string): boolean {
  let verdict = false;
  let matched = false;
  for (const glob of globs) {
    const negated = glob.startsWith("!");
    const pattern = negated ? glob.slice(1) : glob;
    if (globToRegExp(pattern).test(path)) {
      matched = true;
      verdict = !negated;
    }
  }
  return matched && verdict;
}

export interface FilterCoverage {
  /** `yes` — every token file triggers it; `partial` — some do; `no` — none do. */
  covered: "yes" | "partial" | "no" | "unknown";
  /** Token files the filter would not fire for. Capped for display. */
  unmatched: string[];
}

/**
 * Does pushing this file's token tree actually trigger the workflow?
 *
 * `candidates` are the **real repo paths this connection would write** — not a guess at what a
 * token folder looks like. That is what makes the warning specific enough to act on: it can name
 * the file that wouldn't have triggered anything.
 */
export function filterCoverage(paths: PushPaths, candidates: string[]): FilterCoverage {
  if (paths.kind === "unknown") return { covered: "unknown", unmatched: [] };
  if (paths.kind === "all") return { covered: "yes", unmatched: [] };
  if (candidates.length === 0) return { covered: "unknown", unmatched: [] };

  const triggers = (path: string): boolean =>
    paths.kind === "ignore" ? !matchesFilter(paths.globs, path) : matchesFilter(paths.globs, path);

  const unmatched = candidates.filter((path) => !triggers(path));
  if (unmatched.length === 0) return { covered: "yes", unmatched: [] };
  if (unmatched.length === candidates.length) return { covered: "no", unmatched: unmatched.slice(0, 5) };
  return { covered: "partial", unmatched: unmatched.slice(0, 5) };
}

/**
 * The mismatch warning — gap 8's whole point is that it **states the consequence**.
 *
 * "Doesn't match" is a fact about two strings. "The build never runs" is what the user actually
 * needs to know, and it is the half that was missing everywhere this was warned before.
 */
export function describeMismatch(
  tokensDir: string,
  coverage: FilterCoverage,
  globs: string[]
): string | null {
  if (coverage.covered === "yes" || coverage.covered === "unknown") return null;
  const filter = globs.length === 0 ? "no push filter that includes it" : globs.join(", ");
  if (coverage.covered === "no") {
    return `Settings pushes to ${tokensDir}/, but the workflow only builds on ${filter}. Nothing you push will start a build — there will be no failed run to notice, just no run at all. Fix it in the repo, in the workflow's paths: filter.`;
  }
  return `Some of what Settings pushes to ${tokensDir}/ falls outside the workflow's paths: filter (${filter}), so those pushes start no build at all. Fix it in the repo, in the workflow's paths: filter.`;
}

// ---------------------------------------------------------------------------
// Joining CI's failure to the plugin's own vocabulary — gap 9
// ---------------------------------------------------------------------------

export type CiDiagnosticKind =
  | "reference-cycle"
  | "expression-error"
  | "dangling-reference"
  | "path-conflict";

export interface CiDiagnostic {
  kind: CiDiagnosticKind;
  theme: string;
  /** The dotted token path, pulled out of the message our own script wrote. */
  path: string | null;
  /** The loop, when the message carried one — `a → b → a`, the same form the editor renders. */
  loop: string | null;
  message: string;
}

const DIAGNOSTIC_LINE =
  /\[(reference-cycle|expression-error|dangling-reference|path-conflict)\]\s+(.*?):\s+(\S.*)$/;

/**
 * The build's own diagnostics, recovered from the job log.
 *
 * `cli.ts` prints `  [kind] theme: message` for every diagnostic and writes nothing when there is
 * one, so those lines are the join between CI's *"the build failed"* and the plugin's *"this token
 * is on a loop"* — the two halves gap 9 says are each correct and never meet.
 *
 * **Only text matching this exact shape is ever extracted**, and it originates from Tokenvault's
 * own build script rather than from GitHub. That is deliberate and is what keeps ADR-0006 §10's
 * rule intact: a log is a response body, and no response body is rendered wholesale.
 */
export function parseBuildLog(log: string, limit = 10): CiDiagnostic[] {
  const out: CiDiagnostic[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = DIAGNOSTIC_LINE.exec(line);
    if (match === null) continue;
    const message = match[3].trim().slice(0, 300);
    out.push({
      kind: match[1] as CiDiagnosticKind,
      // Log lines carry a leading ISO timestamp; the theme capture starts after `[kind] `, so it
      // is clean already.
      theme: match[2].trim(),
      path: quoted(message),
      loop: loopOf(message),
      message,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function quoted(message: string): string | null {
  const match = /^"([^"]+)"/.exec(message);
  return match === null ? null : match[1];
}

function loopOf(message: string): string | null {
  const match = /reference loop \(([^)]+)\)/.exec(message);
  return match === null ? null : match[1];
}

export interface CiFailure {
  diagnostics: CiDiagnostic[];
  /** The failing step's name, when the jobs call answered. */
  step: string | null;
}

/** The failing step of a failed run — `Build tokens` when the build itself is what said no. */
export function failingStep(jobs: WorkflowJobSummary[]): string | null {
  for (const job of jobs) {
    if (job.conclusion !== "failure") continue;
    const step = job.steps.find((one) => one.conclusion === "failure");
    if (step !== undefined) return step.name;
  }
  return null;
}

/** The failing job, whose log is the only place the diagnostics exist. */
export function failingJobId(jobs: WorkflowJobSummary[]): number | null {
  const job = jobs.find((one) => one.conclusion === "failure");
  return job === undefined ? null : job.id;
}

/**
 * What to say about a failed build — cycle first, because that is the one the plugin can speak
 * about in the user's own terms.
 */
export function describeBuildFailure(failure: CiFailure): string {
  const cycles = failure.diagnostics.filter((one) => one.kind === "reference-cycle");
  if (cycles.length > 0) {
    const first = cycles[0];
    const where = first.path === null ? "a token" : first.path;
    const scope = cycles.length === 1 ? "" : ` (${cycles.length} tokens on loops)`;
    return `The build failed on a reference cycle: ${where} in theme "${first.theme}" is on a loop${scope}. Nothing was written, so the generated files still hold the last good build.`;
  }
  if (failure.diagnostics.length > 0) {
    const kinds = new Set(failure.diagnostics.map((one) => one.kind));
    return `The build refused ${failure.diagnostics.length} token${failure.diagnostics.length === 1 ? "" : "s"} (${[...kinds].join(", ")}) and wrote nothing.`;
  }
  if (failure.step !== null) {
    return `The build failed at the "${failure.step}" step.`;
  }
  return "Tokenvault couldn't read why it failed. Open the run on GitHub for the log.";
}

/** Shown when the run failed and its diagnostics could not be read — the honest shrug, once. */
export const LOG_UNAVAILABLE =
  "Tokenvault couldn't read the build log — the token may not have Actions: read. Open the run on GitHub to see it.";

/**
 * The lines to render under a failed build.
 *
 * One rule: never two sentences that say the same thing. When nothing at all could be read — the
 * jobs call was refused, or the log was — `describeBuildFailure` bottoms out at its own "couldn't
 * read why it failed", which is the log-unavailable sentence with less information in it. In that
 * case the specific one is the only one that renders.
 */
export function buildFailureLines(failure: CiFailure, logUnavailable: boolean): string[] {
  const nothingRead = failure.diagnostics.length === 0 && failure.step === null;
  if (logUnavailable && nothingRead) return [LOG_UNAVAILABLE];
  const lines = [describeBuildFailure(failure)];
  if (logUnavailable) lines.push(LOG_UNAVAILABLE);
  return lines;
}
