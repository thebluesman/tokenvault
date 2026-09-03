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

function everySource(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
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

test("api.ts never renders GitHub's own words back to the user", () => {
  // Every string §11's table specifies is written by us from a status code. Reading a response body
  // into a message is how a header ends up on screen.
  const api = code(readFileSync(join(GIT, "api.ts"), "utf8"));
  assert.equal(/message:\s*(await|response|error|String\()/.test(api), false);
  assert.equal(/response\.(text|statusText)/.test(api), false);
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
