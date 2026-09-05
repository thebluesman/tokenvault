// The export block on the Repo tab — issue #25, `user-journeys.md` §13b gaps 7–9.
//
// The panel's first surface for *what happened after the push*: whether the export build ran and
// what it said, whether the workflow's `paths:` filter even contains the folder Settings pushes to,
// and — when a build failed — whether it failed on the one thing the plugin already has words for,
// a reference cycle (ADR-0007 §3).
//
// **One block per connection, never one global indicator** (ADR-0008 §6a). Today `targets()`
// returns the single connection ADR-0006 configured, but everything below is keyed by connection
// and rendered in a loop, so the multi-repo settings UI plugs into `targets()` and nothing else
// here changes. A collapsed "builds are fine" across N repos would be a lie the moment two repos
// disagreed, which is exactly what §6a forbids.
//
// **Read-only.** No trigger, no re-run, no cancel, and no offer to fix a `paths:` mismatch — the
// fix for that is a commit to the repo, and this panel does not edit workflows (issue #25, out of
// scope).
//
// **Cadence**: Repo tab open, after a push, and the `[ Check build ]` button. Never a timer —
// ADR-0006 §5's rule is about the sync check but applies with more force here, since a build the
// user isn't looking at is a build nobody is waiting on.

import type { GitFailure } from "../git/types";
import type {
  BuildState,
  CiFailure,
  FilterCoverage,
  PushPaths,
  WorkflowRunSummary,
} from "../git/pipeline";
import {
  buildDetail,
  buildState,
  describeBuild,
  describeBuildFailure,
  describeMismatch,
  failingJobId,
  failingStep,
  filterCoverage,
  isExportWorkflow,
  parseBuildLog,
  parseOutDir,
  parsePushPaths,
  rankWorkflowCandidates,
  selectRun,
  workflowFilePaths,
} from "../git/pipeline";
import { button, el } from "./dom";
import { getGit, localFiles, remoteBlobs, remoteTreeSha, withReadClient } from "./git";
import { failureText } from "./settings";

/** One repo the panel reports a build for. One per connection (ADR-0008 §1 — no primary). */
export interface PipelineTarget {
  key: string;
  owner: string;
  repo: string;
  branch: string;
  tokensDir: string;
  label: string;
}

export interface PipelineState {
  loading: boolean;
  checkedAt: number | null;
  build: BuildState;
  /** The Actions read's own failure, kept off the shared sync view so neither masks the other. */
  failure: GitFailure | null;
  workflowPath: string | null;
  paths: PushPaths | null;
  coverage: FilterCoverage | null;
  /** The one sentence gap 8 needs — including the consequence. `null` when there's no mismatch. */
  mismatch: string | null;
  ci: CiFailure | null;
  /** True when the run failed and its log could not be read, so *why* is genuinely unknown. */
  logUnavailable: boolean;
  outDir: string | null;
  exportsPresent: boolean;
}

const states = new Map<string, PipelineState>();
/** Keys with a refresh in flight — a second tab open must not fire a second set of requests. */
const inFlight = new Set<string>();
/** `key|treeSha` → the workflow lookup for that exact tree, so re-opening the tab costs nothing. */
const workflowCache = new Map<string, WorkflowLookup>();

/** The export workflow, if there is one — `known: false` means *couldn't look*, not *there isn't one*. */
interface WorkflowLookup {
  path: string | null;
  yaml: string | null;
  known: boolean;
}

let onChange: (() => void) | null = null;

export function onPipelineChange(listener: () => void): void {
  onChange = listener;
}

function blank(): PipelineState {
  return {
    loading: false,
    checkedAt: null,
    build: { kind: "unknown", run: null },
    failure: null,
    workflowPath: null,
    paths: null,
    coverage: null,
    mismatch: null,
    ci: null,
    logUnavailable: false,
    outDir: null,
    exportsPresent: false,
  };
}

/**
 * The connections to report on.
 *
 * The single seam multi-repo routing lands on: when the settings panel grows N connections, this
 * becomes `enabledConnections(settings).map(...)` and every other line in this file stands.
 */
export function targets(): PipelineTarget[] {
  const settings = getGit().settings;
  if (settings === null) return [];
  return [
    {
      key: `${settings.owner}/${settings.repo}@${settings.branch}`,
      owner: settings.owner,
      repo: settings.repo,
      branch: settings.branch,
      tokensDir: settings.tokensDir,
      label: `${settings.owner}/${settings.repo}@${settings.branch}`,
    },
  ];
}

function stateFor(key: string): PipelineState {
  const existing = states.get(key);
  if (existing !== undefined) return existing;
  const created = blank();
  states.set(key, created);
  return created;
}

function set(key: string, next: Partial<PipelineState>): void {
  states.set(key, { ...stateFor(key), ...next });
  if (onChange !== null) onChange();
}

/**
 * Forgets state for repos that are no longer connected.
 *
 * Pruned at render rather than cleared from the disconnect handler, which would mean `settings.ts`
 * importing this module and this module importing `settings.ts` back. Keying every entry by
 * connection makes the cheap fix the correct one: a key nothing targets any more is unreachable, so
 * dropping it is all "disconnect" ever needed to mean here.
 */
function prune(live: PipelineTarget[]): void {
  const keys = new Set(live.map((target) => target.key));
  for (const key of [...states.keys()]) if (!keys.has(key)) states.delete(key);
  for (const key of [...workflowCache.keys()]) {
    if (!keys.has(key.slice(0, key.lastIndexOf("|")))) workflowCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// The refresh
// ---------------------------------------------------------------------------

export async function refreshPipeline(): Promise<void> {
  await Promise.all(targets().map((target) => refreshTarget(target)));
}

async function refreshTarget(target: PipelineTarget): Promise<void> {
  if (!getGit().hasToken) return;
  if (inFlight.has(target.key)) return;
  inFlight.add(target.key);
  set(target.key, { loading: true, failure: null });

  try {
    const runs = await withReadClient(target, (client) => client.getWorkflowRuns(target.branch));
    if (!runs.ok) {
      // Gap 7 degrades to *"couldn't ask"*, which is a different sentence from *"no build"* — and
      // the tokens, the sync status and every other part of the tab are untouched by it.
      set(target.key, {
        loading: false,
        failure: runs.failure,
        build: { kind: "unknown", run: null },
        checkedAt: Date.now(),
      });
      return;
    }

    const workflow = await findWorkflow(target, runs.value);
    const run = selectRun(runs.value, workflow.path);
    // *"Couldn't look"* is not *"there is no workflow"*. Without the repo tree — no status check
    // yet, or a blob read that failed — the panel has no way to tell those apart, and the one that
    // sends the user to add a workflow they already have is the wrong guess to make (gap 7).
    const state = workflow.known
      ? buildState({ workflowPath: workflow.path, run })
      : ({ kind: "unknown", run: null } as BuildState);

    const paths = workflow.yaml === null ? null : parsePushPaths(workflow.yaml);
    const coverage = paths === null ? null : filterCoverage(paths, pushedPaths(target));
    const globs = paths !== null && paths.kind !== "all" && paths.kind !== "unknown" ? paths.globs : [];
    const mismatch =
      coverage === null ? null : describeMismatch(target.tokensDir, coverage, globs);
    const outDir = workflow.yaml === null ? null : parseOutDir(workflow.yaml);

    set(target.key, {
      loading: false,
      checkedAt: Date.now(),
      build: state,
      failure: null,
      workflowPath: workflow.path,
      paths,
      coverage,
      mismatch,
      outDir,
      exportsPresent: outDir !== null && hasGeneratedFiles(outDir),
      ci: null,
      logUnavailable: false,
    });

    if (state.kind === "failed" && state.run !== null) await explainFailure(target, state.run);
  } catch {
    // The last line of `error-states.md` §1 applied to a surface that is nobody's critical path:
    // whatever went wrong in here, the Repo tab keeps its sync status, its buttons and its tokens.
    // A crash screen for a build status the user didn't even ask about would be absurd, and an
    // unhandled rejection from this `void`-ed call is exactly how one would appear.
    set(target.key, {
      loading: false,
      checkedAt: Date.now(),
      build: { kind: "unknown", run: null },
      failure: { kind: "unknown", message: "Tokenvault couldn't read this repo's builds." },
    });
  } finally {
    inFlight.delete(target.key);
  }
}

/** Repo paths this connection would actually push — what the filter has to match to be useful. */
function pushedPaths(target: PipelineTarget): string[] {
  const local = [...localFiles().keys()];
  if (local.length > 0) return local;
  // Nothing imported yet, so ask the question about the two files a first push is certain to write
  // rather than answering "unknown" and going quiet at exactly the moment setup is being checked.
  return [`${target.tokensDir}/$manifest.json`, `${target.tokensDir}/core.json`];
}

function hasGeneratedFiles(outDir: string): boolean {
  const blobs = remoteBlobs();
  if (blobs === null) return false;
  const prefix = `${outDir}/`;
  return Object.keys(blobs).some((path) => path.startsWith(prefix));
}

/**
 * Which workflow file is the export one — by content, not by filename.
 *
 * Costs one blob in the ordinary case: `rankWorkflowCandidates` puts the workflow the latest run
 * came from first. A repo with no runs yet falls back to reading the few files under
 * `.github/workflows/`, capped, and the answer is cached against the tree SHA the status check
 * already fetched, so re-opening the tab re-reads nothing.
 */
async function findWorkflow(
  target: PipelineTarget,
  runs: WorkflowRunSummary[]
): Promise<WorkflowLookup> {
  const blobs = remoteBlobs();
  const treeSha = remoteTreeSha();
  // No tree in hand means no answer, not a negative one.
  if (blobs === null || treeSha === null) return { path: null, yaml: null, known: false };

  const cacheKey = `${target.key}|${treeSha}`;
  const cached = workflowCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const latest = runs.length > 0 ? runs[0].path : null;
  const candidates = rankWorkflowCandidates(workflowFilePaths(Object.keys(blobs)), latest).slice(0, 4);

  const found = await withReadClient(target, async (client): Promise<WorkflowLookup> => {
    for (const path of candidates) {
      const sha = blobs[path];
      if (sha === undefined) continue;
      const yaml = await client.getBlob(sha);
      if (isExportWorkflow(yaml)) return { path, yaml, known: true };
    }
    return { path: null, yaml: null, known: true };
  });

  // A failed read is not cached: "no workflow" and "couldn't read the workflow" must not become the
  // same durable answer, or a transient 403 leaves the panel telling the user to add a workflow the
  // repo already has.
  if (!found.ok) return { path: null, yaml: null, known: false };
  workflowCache.set(cacheKey, found.value);
  return found.value;
}

/**
 * Gap 9 — why the build failed, in the plugin's own vocabulary where it can be.
 *
 * Two extra calls, and only on a failure. Both are allowed to come back empty: the jobs list needs
 * `Actions: read` and the log is a redirect to storage this iframe may not be able to follow, so a
 * failure that can't be explained still reports *that* it failed with a link to the run, rather
 * than pretending to a reason it doesn't have (`error-states.md` §1).
 */
async function explainFailure(target: PipelineTarget, run: WorkflowRunSummary): Promise<void> {
  const jobs = await withReadClient(target, (client) => client.getRunJobs(run.id));
  if (!jobs.ok) {
    set(target.key, { ci: { cycle: false, diagnostics: [], step: null }, logUnavailable: true });
    return;
  }

  const step = failingStep(jobs.value);
  const jobId = failingJobId(jobs.value);
  const log = jobId === null ? null : await withReadClient(target, (client) => client.getJobLog(jobId));
  const text = log !== null && log.ok ? log.value : null;
  const diagnostics = text === null ? [] : parseBuildLog(text);

  set(target.key, {
    ci: {
      cycle: diagnostics.some((one) => one.kind === "reference-cycle"),
      diagnostics,
      step,
    },
    logUnavailable: text === null,
  });
}

// ---------------------------------------------------------------------------
// Rendering — §13b's missing surface, in the Repo tab's existing vocabulary
// ---------------------------------------------------------------------------

export function renderPipeline(into: HTMLElement): void {
  const list = targets();
  prune(list);
  if (list.length === 0) return;

  const wrap = el("div", "repo-section");
  wrap.appendChild(el("h3", undefined, "Export"));
  for (const target of list) renderTarget(wrap, target, list.length > 1);
  into.appendChild(wrap);
}

function renderTarget(into: HTMLElement, target: PipelineTarget, named: boolean): void {
  const state = stateFor(target.key);
  // §6a: with more than one connection, every block says which repo it is about. With one, the tab
  // header already named it and repeating it is noise.
  if (named) into.appendChild(el("div", "mono", target.label));

  if (state.loading && state.checkedAt === null) {
    into.appendChild(el("div", "empty", "Checking the build…"));
    return;
  }

  if (state.failure !== null) {
    const entry = el("div", "entry");
    entry.appendChild(el("div", "kind", "build status"));
    entry.appendChild(el("div", undefined, actionsFailureText(state.failure)));
    entry.appendChild(el("div", "empty", buildDetail({ kind: "unknown", run: null }, target.branch)));
    into.appendChild(entry);
    into.appendChild(refreshButton(target));
    return;
  }

  const headline = describeBuild(state.build, target.branch);
  const detail = buildDetail(state.build, target.branch);

  if (state.build.kind === "success") {
    const line = el("div", "ok-line");
    line.appendChild(el("span", "dot", "●"));
    line.appendChild(el("span", undefined, `${headline}${ago(state.build.run)}`));
    into.appendChild(line);
  } else if (state.build.kind === "failed" || state.build.kind === "inconclusive") {
    const entry = el("div", "entry");
    entry.appendChild(el("div", "kind", "export build"));
    entry.appendChild(el("div", undefined, `${headline}${ago(state.build.run)}`));
    if (detail.length > 0) entry.appendChild(el("div", "empty", detail));
    // Only a *failure* has a log worth reading; a cancelled or timed-out run has no diagnostics to
    // wait for, and saying "reading the build log…" under one would be a wait that never ends.
    if (state.build.kind === "failed") renderWhy(entry, state);
    into.appendChild(entry);
  } else {
    const line = el("div", undefined, `${headline}${ago(state.build.run)}`);
    into.appendChild(line);
    if (detail.length > 0) into.appendChild(el("div", "empty", detail));
  }

  // Gap 8. Its own notice, and it appears whatever the build says — a green build from last week
  // is exactly the situation in which a filter that stopped matching goes unnoticed.
  if (state.mismatch !== null) {
    const entry = el("div", "entry");
    entry.appendChild(el("div", "kind", "tokensDir mismatch"));
    entry.appendChild(el("div", undefined, state.mismatch));
    if (state.coverage !== null && state.coverage.unmatched.length > 0) {
      entry.appendChild(
        el("div", "empty mono", state.coverage.unmatched.join(", "))
      );
    }
    into.appendChild(entry);
  }

  const links = el("div", "toolbar");
  const run = state.build.run;
  if (run !== null && run.htmlUrl.length > 0) {
    const view = button("View run ↗");
    view.addEventListener("click", () => window.open(run.htmlUrl, "_blank"));
    links.appendChild(view);
  }
  if (state.exportsPresent && state.outDir !== null) {
    // Gap 7's *"no link to `exports/`"*. Offered only when the folder actually exists on the
    // branch, because a link to a folder GitHub will 404 on is worse than no link.
    const open = button(`${state.outDir}/ ↗`);
    const href = `https://github.com/${target.owner}/${target.repo}/tree/${target.branch}/${state.outDir}`;
    open.addEventListener("click", () => window.open(href, "_blank"));
    links.appendChild(open);
  }
  links.appendChild(refreshButton(target));
  into.appendChild(links);
}

/**
 * Gap 9 rendered: the cycle sentence when there is one, the honest shrug when the log was
 * unreadable, and never a bare "failed" with nothing after it.
 */
function renderWhy(into: HTMLElement, state: PipelineState): void {
  if (state.ci === null) {
    into.appendChild(el("div", "empty", "Reading the build log…"));
    return;
  }
  into.appendChild(el("div", undefined, describeBuildFailure(state.ci)));

  for (const diagnostic of state.ci.diagnostics.slice(0, 3)) {
    if (diagnostic.loop === null) continue;
    // The same loop notation the editor and the apply dialog use, so the two halves gap 9 says
    // never meet are now written in one language.
    into.appendChild(el("div", "cycle-steps", diagnostic.loop));
  }

  if (state.logUnavailable) {
    into.appendChild(
      el(
        "div",
        "empty",
        "Tokenvault couldn't read the build log — the token may not have Actions: read. Open the run on GitHub to see it."
      )
    );
  }
}

function refreshButton(target: PipelineTarget): HTMLElement {
  const state = stateFor(target.key);
  const again = button(state.checkedAt === null ? "Check build" : "Check build again");
  again.disabled = state.loading;
  again.addEventListener("click", () => void refreshTarget(target));
  return again;
}

/** The Actions read's failures, in our words. Two of them get a hint the sync copy can't give. */
function actionsFailureText(failure: GitFailure): string {
  if (failure.kind === "forbidden-write" || failure.kind === "not-found") {
    return "Tokenvault couldn't read this repo's builds. A fine-grained token needs Actions: read as well as Contents.";
  }
  return failureText(failure.kind, failure.message, failure.rateLimitReset);
}

function ago(run: WorkflowRunSummary | null): string {
  if (run === null || run.createdAt.length === 0) return "";
  const at = Date.parse(run.createdAt);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 2) return " · just now";
  if (minutes < 60) return ` · ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ` · ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return ` · ${days} day${days === 1 ? "" : "s"} ago`;
}
