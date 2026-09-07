// Git sync's module boundary and credential rules, asserted by source inspection — ADR-0006 §1.
//
// The same spirit as `applyInvariant.test.ts`, which asserts that no code path writes to Figma
// outside the confirmed dialog. These are properties about *which modules can reach what*, and no
// runtime test can prove the absence of a second path — so they are checked the only way they can
// be, and a future ticket that wants a second edge amends the ADR first.
//
// Four properties, and the middle two are security rather than tidiness:
//
//   1. `src/git/api.ts` is the only module in the codebase that calls `fetch`.
//   2. The PAT is never logged, never stored on the iframe side, and never rendered as a value.
//   3. `src/git/*` stays pure apart from that one edge — no `figma` global, no `clientStorage`.
//   4. There is exactly one diff row component (UX §14: *"if Phase 6 introduces a second diff row,
//      something went wrong"*).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const GIT = join(ROOT, "src/git");
const UI = join(ROOT, "src/ui");

/** Strips comments, so a rule *discussed* in prose isn't mistaken for the thing it forbids. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sources(dir: string): Array<{ name: string; text: string }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: code(readFileSync(join(dir, name), "utf8")) }));
}

/**
 * Every source file **the plugin ships**.
 *
 * `src/export/` is excluded: it is repo-side Node code that never runs inside Figma, never sees a
 * credential, and whose CLI exists precisely to print (issue #17). Including it would turn the
 * no-logging rule — which is about a PAT reaching a console — into a rule about a build tool
 * reporting its own progress. The exclusion is bounded by the test below, which asserts the export
 * never reaches for a credential, the network, or the Figma global in the first place.
 */
function everySource(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "export") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ path: full.slice(ROOT.length + 1), text: code(readFileSync(full, "utf8")) });
      }
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

test("api.ts is the only module that calls the GitHub API", () => {
  // ADR-0006 §1: one impure edge, everything else pure and testable without a network. This is the
  // parallel of `src/figma/apply.ts` being the single write edge (ADR-0005 §3).
  const callers = everySource()
    .filter(({ text }) => /\bfetch\s*\(/.test(text) || /api\.github\.com/.test(text))
    .map(({ path }) => path);
  assert.deepEqual(callers, ["src/git/api.ts"]);
});

test("nothing outside api.ts writes an Authorization header", () => {
  const senders = everySource()
    .filter(({ text }) => /Authorization/.test(text))
    .map(({ path }) => path);
  assert.deepEqual(senders, ["src/git/api.ts"]);
});

test("the PAT is never logged", () => {
  // §1: *"never logged and never included in an error payload"* — a response body can echo a
  // request header, and a URL can carry a token.
  for (const { path, text } of everySource()) {
    assert.equal(/console\.(log|warn|error|debug)/.test(text), false, `${path} must not log`);
  }
});

test("the export never reaches for a credential, the network, or Figma", () => {
  // The bound on `everySource`'s exclusion above. `src/export/` reads files off disk and writes
  // files to disk; the moment it wants a PAT or a `fetch`, it stops being outside the credential
  // rules and this test is where that gets noticed.
  const EXPORT = join(ROOT, "src/export");
  for (const { name, text } of sources(EXPORT)) {
    // Not `/token/` — "token" is this project's domain noun and appears on every other line. The
    // credential's own vocabulary is what must be absent.
    assert.equal(
      /Authorization|clientStorage|\bPAT\b|personal access token/i.test(text),
      false,
      `src/export/${name} is credential-free`
    );
    assert.equal(/\bfetch\s*\(/.test(text), false, `src/export/${name} must not call the network`);
    assert.equal(/\bfigma\./.test(text), false, `src/export/${name} must not touch the figma global`);
  }
});

test("api.ts never renders GitHub's own words back to the user", () => {
  // Every string §11's table specifies is written by us from a status code. Reading a response body
  // into a message is how a header ends up on screen.
  const api = code(readFileSync(join(GIT, "api.ts"), "utf8"));
  assert.equal(/message:\s*(await|response|error|String\()/.test(api), false);

  // One response body is read as text, and exactly one: the Actions job log (issue #25, gap 9),
  // which is not JSON. It is never rendered — `parseBuildLog` extracts only lines matching the
  // `[kind] theme: message` shape Tokenvault's own build script prints — and the test below binds
  // that promise. `statusText` stays banned outright, since there is no reading of it that isn't
  // GitHub's words on our screen.
  assert.deepEqual(api.match(/response\.(?:text|statusText)\(/g) ?? [], ["response.text("]);
  assert.equal(/response\.statusText/.test(api), false);
});

test("the CI job log is only ever read through the diagnostic parser", () => {
  // The bound on the carve-out above. A module that fetches a log and does anything with it other
  // than hand it to `parseBuildLog` would be putting an untrusted response body one step from the
  // DOM, so the two names travel together or the rule has been broken.
  for (const { path, text } of everySource()) {
    if (path === "src/git/api.ts" || path === "src/git/pipeline.ts") continue;
    if (!/getJobLog/.test(text)) continue;
    assert.equal(/parseBuildLog/.test(text), true, `${path} must parse the log, not render it`);
  }
});

test("the export block is read-only — it never starts, re-runs or cancels a build", () => {
  // Issue #25's out-of-scope list, as code. Every Actions call is a GET; the four write endpoints
  // (`/rerun`, `/cancel`, `/dispatches`, `/approve`) must not appear anywhere.
  const api = code(readFileSync(join(GIT, "api.ts"), "utf8"));
  assert.equal(/rerun|\/cancel|dispatches|\/approve/.test(api), false);
  for (const { path, text } of everySource()) {
    // Every Actions request, with the 200 characters of the call that follow it — long enough to
    // reach the options object a write would need, short enough not to run into the next request.
    for (const match of text.matchAll(/actions\//g)) {
      const call = text.slice(match.index ?? 0, (match.index ?? 0) + 200);
      assert.equal(
        /method:\s*"(POST|PUT|PATCH|DELETE)"/.test(call),
        false,
        `${path} must call Actions read-only`
      );
    }
  }
});

test("the export block never polls, and never repairs a workflow", () => {
  // Same rule as the status check (ADR-0006 §5), and issue #25's second out-of-scope item: a
  // `tokensDir` mismatch is *warned*, never auto-fixed — the fix is a commit to the repo.
  const pipeline = code(readFileSync(join(UI, "pipeline.ts"), "utf8"));
  assert.equal(/setInterval|setTimeout/.test(pipeline), false);
  assert.equal(/send\(\{\s*type:\s*"(apply|delete-in-figma)"/.test(pipeline), false);
});

test("the iframe holds the credential in a closure, not in a module or on window", () => {
  const git = code(readFileSync(join(UI, "git.ts"), "utf8"));
  // No module-level cache, no `window` property, no `localStorage` (§1).
  assert.equal(/localStorage|sessionStorage/.test(git), false);
  assert.equal(/window\.\w+\s*=/.test(git), false);
  assert.equal(/^(let|var|const)\s+token\b/m.test(git), false);
  // The token is requested per operation and handed straight to the client.
  assert.equal(/requestToken\(\)/.test(git), true);
});

test("the PAT never enters the DOM as a value", () => {
  // UX §14: the settings field renders `••••` plus four characters from stored *metadata*. No
  // `value` attribute carrying a token, no reveal toggle, no copy button.
  const settings = code(readFileSync(join(UI, "settings.ts"), "utf8"));
  assert.equal(/\.value\s*=\s*.*token/i.test(settings), false);
  assert.equal(/reveal|showToken|Show token/i.test(settings), false);
  assert.equal(/patLastFour/.test(settings), true);
});

test("src/git stays pure apart from its one edge", () => {
  const FIGMA_API = /\bfigma\.(variables|root|ui|currentPage|clientStorage|viewport|notify|showUI)/;
  for (const { name, text } of sources(GIT)) {
    assert.equal(FIGMA_API.test(text), false, `src/git/${name} must not touch the figma global`);
    if (name === "api.ts") continue;
    assert.equal(/\bfetch\s*\(/.test(text), false, `src/git/${name} must stay pure`);
  }
});

test("clientStorage is the sandbox's alone", () => {
  // The mirror image of the fetch rule: storage is sandbox-only, so the iframe must never reach for
  // it and the sandbox is the only place a key is read or written.
  const users = everySource()
    .filter(({ text }) => /clientStorage/.test(text))
    .map(({ path }) => path);
  assert.deepEqual(users, ["src/code.ts"]);
});

test("there is exactly one diff row component", () => {
  // UX §14: *"Reuse Phase 5's row component for the commit diff, the compare view, and the apply
  // dialog… If Phase 6 introduces a second diff row, something went wrong."*
  const definers = sources(UI)
    .filter(({ text }) => /function\s+diffRow\s*\(/.test(text))
    .map(({ name }) => name);
  assert.deepEqual(definers, ["diffRow.ts"]);

  // And the surfaces that show a diff all use it rather than growing their own.
  for (const name of ["applyDialog.ts", "repo.ts"]) {
    const text = code(readFileSync(join(UI, name), "utf8"));
    assert.equal(/diffRow\(/.test(text), true, `${name} must use the shared row`);
  }
});

test("pull never writes to Figma — the apply dialog stays the only write path", () => {
  // ADR-0006 §5, restated as code: Phase 5's invariant test says only `applyDialog.ts` may send an
  // `apply`, and Phase 6 adds no exception. Checked here too, because a pull is exactly the kind of
  // thing that would want one.
  for (const name of ["git.ts", "repo.ts", "settings.ts"]) {
    const text = code(readFileSync(join(UI, name), "utf8"));
    assert.equal(/send\(\{\s*type:\s*"apply"/.test(text), false, `${name} must not write to Figma`);
    assert.equal(/send\(\{\s*type:\s*"delete-in-figma"/.test(text), false);
  }
});

test("nothing polls — status refreshes on demand, never on a timer", () => {
  // ADR-0006 §5, §10 and ADR-0005 §9: a status check is cheap but not free, the answer is only
  // interesting when the user is about to act, and a background timer in a Figma plugin is a
  // battery and rate-limit cost paid for a question nobody asked.
  for (const name of ["git.ts", "repo.ts", "settings.ts"]) {
    const text = code(readFileSync(join(UI, name), "utf8"));
    assert.equal(/setInterval|setTimeout\s*\(\s*[^,]*checkStatus/.test(text), false, `${name} must not poll`);
  }
});

test("$import-report.json is excluded at the boundary, not in a renderer", () => {
  // UX §14. The exclusion lives in `diff.ts`/`local.ts`; a UI module filtering it would mean it had
  // reached the UI in the first place.
  const local = code(readFileSync(join(GIT, "local.ts"), "utf8"));
  assert.equal(/isExcluded/.test(local), true);
  for (const { name, text } of sources(UI)) {
    assert.equal(
      /\$import-report/.test(text),
      false,
      `${name} must never need to know the report exists`
    );
  }
});

test("no source file contains a literal NUL byte, so every one of them stays reviewable", () => {
  // A single raw NUL makes git and GitHub classify the whole file as binary: `git diff`, `gh pr
  // diff` and the web UI all render "Binary files differ" with no hunks at all, which takes the
  // file straight out of the review gate. Written as the escape `\u0000` it has identical runtime
  // semantics and costs nothing, so that is how the map-key joiners are always spelled.
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Read raw, not comment-stripped: a NUL in a comment is as fatal to the diff as one in code.
      else if (readFileSync(full, "utf8").indexOf("\u0000") !== -1) {
        offenders.push(full.slice(ROOT.length + 1));
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "test"));
  assert.deepEqual(offenders, []);
});
