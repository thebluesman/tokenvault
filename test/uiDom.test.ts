// The UI's DOM contract — every element a module reaches for at load time exists in the template.
//
// This is the cheapest possible substitute for the thing a browser would tell you: several UI
// modules resolve their root element at *module scope*
//
//   const repoEl = document.getElementById("repo") as HTMLElement;
//
// so a typo'd or missing id is not a null check away — it is a `TypeError` on the first render,
// inside a Figma plugin iframe with no console the user will ever see. A phase that adds three new
// elements to `index.html` is exactly when that happens, so it is pinned here.
//
// Ids created at runtime (`drift-bulk`, which `renderChanged` appends) are exempted by name, with
// the reason attached, rather than by loosening the check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UI = join(process.cwd(), "src/ui");
const html = readFileSync(join(UI, "index.html"), "utf8");

/** Ids the template does not carry because a render creates them. Each needs a reason. */
const RUNTIME_IDS = new Set([
  // Appended by `renderChanged` and read back by `renderBulkBar`, which repaints the footer strip
  // in place without re-rendering the forty rows above it (UX git-sync §10.4).
  "drift-bulk",
]);

test("every element the UI looks up exists in index.html", () => {
  const ids = new Set<string>();
  for (const name of readdirSync(UI)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(join(UI, name), "utf8");
    for (const match of text.matchAll(/getElementById\("([^"]+)"\)/g)) ids.add(match[1]);
  }

  assert.equal(ids.size > 0, true, "the scan found no lookups — the regex has drifted");

  for (const id of ids) {
    if (RUNTIME_IDS.has(id)) continue;
    assert.equal(
      html.indexOf(`id="${id}"`) !== -1,
      true,
      `index.html has no element with id="${id}" — a module-scope lookup would be null at load`
    );
  }
});

test("the tab strip has exactly the three top-level tabs", () => {
  // UX git-sync §4.1: Repo is a **third top-level tab**, beside Import and Tokens. A fourth would
  // mean something grew a tab that should have been a screen.
  const tabs = Array.from(html.matchAll(/id="tab-([a-z]+)"/g)).map((match) => match[1]);
  assert.deepEqual(tabs, ["import", "tokens", "repo"]);
});

test("the settings overlay sits above the panel, and the modal above both", () => {
  // Settings is reachable from every tab, so it must not be nested inside one; and the phase's one
  // modal (first connect) opens over it. Ordering here is a real z-index contract, not a detail:
  // a connect question rendered *under* the settings overlay is unanswerable.
  // Matched against the *declaring* rule — the one whose own block sets `z-index` — because these
  // ids also appear in shared rules (`#repo, #settings { … }`) that set layout and nothing else.
  const zIndex = (id: string): number => {
    const match = new RegExp(`${id}\\s*\\{[^}]*z-index:\\s*(\\d+)`).exec(html);
    assert.notEqual(match, null, `${id} declares no z-index of its own`);
    return Number((match as RegExpExecArray)[1]);
  };
  assert.equal(zIndex("#repo") < zIndex("#panel"), true, "the Repo tab is a view, not an overlay");
  assert.equal(zIndex("#panel") < zIndex("#settings"), true, "Settings is reachable from every tab");
  assert.equal(zIndex("#settings") < zIndex("#modal"), true, "first connect opens over Settings");
});
