// The resizable panel window — UX `docs/ux/panel-size-and-swatches.md` §3, issue #35.
//
// Two halves. The clamp is real logic and is tested as logic. The rest of §3 is a set of *structural*
// promises about two files — the read happens before `showUI`, the write is debounced, there is no
// maximum and no breakpoint — and those are pinned by source inspection, the same technique
// `darkMode.test.ts` and `errorStates.test.ts` use for the same reason: the panel has no DOM in CI.
//
// What this cannot check is §7's checklist, which needs a running panel: that a restored size really
// comes back, that the filter row wraps rather than breaks at 400px, and that nothing scrolls
// sideways at 1,400px.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  RESIZE_DEBOUNCE_MS,
  clampWindowSize,
} from "../src/window";

const ROOT = process.cwd();
const codeTs = readFileSync(join(ROOT, "src/code.ts"), "utf8");
const mainTs = readFileSync(join(ROOT, "src/ui/main.ts"), "utf8");

test("the three numbers are the ones §9.1 settled", () => {
  assert.deepEqual(DEFAULT_WINDOW_SIZE, { width: 640, height: 720 });
  // Deliberately **below** the old fixed 460, not at it (§3.2): the minimum is the layout target.
  assert.deepEqual(MIN_WINDOW_SIZE, { width: 400, height: 480 });
});

test("nothing stored opens at the default", () => {
  assert.deepEqual(clampWindowSize(undefined), DEFAULT_WINDOW_SIZE);
  assert.deepEqual(clampWindowSize(null), DEFAULT_WINDOW_SIZE);
});

test("an unreadable blob falls back to the default rather than to a screen", () => {
  // §3.3 — same posture as `error-states.md` §3, minus the quarantine: there is no user data in a
  // window size to recover, so a corrupt one is indistinguishable from a missing one on purpose.
  assert.deepEqual(clampWindowSize("640x720"), DEFAULT_WINDOW_SIZE);
  assert.deepEqual(clampWindowSize(42), DEFAULT_WINDOW_SIZE);
  assert.deepEqual(clampWindowSize({}), DEFAULT_WINDOW_SIZE);
  assert.deepEqual(clampWindowSize({ width: "wide", height: null }), DEFAULT_WINDOW_SIZE);
  assert.deepEqual(clampWindowSize({ width: Number.NaN, height: Infinity }), DEFAULT_WINDOW_SIZE);
});

test("a stored size below the minimum clamps up, silently, per axis", () => {
  assert.deepEqual(clampWindowSize({ width: 320, height: 300 }), MIN_WINDOW_SIZE);
  // One axis being legal does not rescue the other, and does not cost it either.
  assert.deepEqual(clampWindowSize({ width: 900, height: 200 }), { width: 900, height: 480 });
  assert.deepEqual(clampWindowSize({ width: 100, height: 1000 }), { width: 400, height: 1000 });
});

test("there is no maximum — Figma clamps to the viewport and we invent no ceiling", () => {
  // §3.2. A ceiling we invent protects against nothing and has to be re-justified every time
  // someone attaches a bigger display.
  assert.deepEqual(clampWindowSize({ width: 4000, height: 3000 }), { width: 4000, height: 3000 });
});

test("a fractional size is rounded rather than refused", () => {
  // The iframe reports its own viewport, which can be fractional on a scaled display.
  assert.deepEqual(clampWindowSize({ width: 640.4, height: 719.6 }), { width: 640, height: 720 });
});

test("one guard stops a drag writing every frame, not two", () => {
  // The ±2 dead zone in `rememberWindowSize` is the whole guard: it already returns for every size
  // an exact-equality check would have caught, so the exact check that used to sit under it was
  // unreachable and is gone (`/code-review high`, 2026-09-08).
  assert.equal(
    codeTs.indexOf("sameWindowSize") === -1,
    true,
    "the dead exact-equality guard came back under the ±2 dead zone"
  );
  assert.equal(
    /Math\.abs\(size\.width - storedWindowSize\.width\) <= 2/.test(codeTs),
    true,
    "the ±2 creep guard is gone — a hairline difference now writes to clientStorage every drag"
  );
});

test("the stored size is read and clamped before showUI, never after", () => {
  // §10 — Figma clamping an out-of-range size for us leaves the *stored* value wrong, so the next
  // session starts from the same bad number. The order of these two statements is the fix.
  const clamp = codeTs.indexOf("clampWindowSize(await figma.clientStorage.getAsync(WINDOW_SIZE_KEY))");
  const show = codeTs.indexOf("figma.showUI(__html__");
  assert.equal(clamp !== -1, true, "the stored size is no longer clamped on the way in");
  assert.equal(show !== -1, true, "showUI moved — re-check the ordering this test is about");
  assert.equal(clamp < show, true, "the clamp must precede showUI");

  // And the old fixed size is gone from the call entirely.
  assert.equal(/showUI\(__html__, \{ width: \d+, height: \d+,/.test(codeTs), false);
});

test("the resize write is debounced", () => {
  // §10, ADR-0004 §1 — resize fires continuously during a drag and `clientStorage` is
  // quota-constrained. One write when the drag settles, not one per frame.
  assert.equal(RESIZE_DEBOUNCE_MS > 0, true, "the debounce interval is gone");
  assert.equal(
    mainTs.indexOf("clearTimeout(resizeTimer)") !== -1,
    true,
    "the resize handler no longer coalesces — every frame of a drag would reach clientStorage"
  );
});

test("both resize listeners coalesce on the same interval", () => {
  // The tree's own listener rebuilds the whole tree when the reference budget moves with the width
  // (§3.4), and it used to do that on every native resize event — visible stutter while dragging the
  // handle across the boundary at 1,300 tokens (`/code-review high`, 2026-09-08). One interval, one
  // source, so a future change to it cannot leave two rebuild waves per drag.
  const tokensTs = readFileSync(join(ROOT, "src/ui/tokens.ts"), "utf8");
  assert.equal(
    /RESIZE_DEBOUNCE_MS\s*=\s*\d+/.test(readFileSync(join(ROOT, "src/window.ts"), "utf8")),
    true,
    "the shared debounce interval left src/window.ts"
  );
  for (const [name, source] of [["main.ts", mainTs], ["tokens.ts", tokensTs]] as const) {
    assert.equal(
      /import \{[^}]*RESIZE_DEBOUNCE_MS[^}]*\} from "\.\.\/window"/.test(source),
      true,
      `${name} no longer takes the debounce interval from src/window.ts`
    );
  }
  const listener = tokensTs.slice(tokensTs.indexOf("export function initTokens"));
  const handler = listener.slice(0, listener.indexOf("\n}"));
  assert.equal(
    handler.indexOf("clearTimeout(budgetTimer)") !== -1,
    true,
    "the tree's resize listener stopped coalescing — a drag rebuilds the tree per native event"
  );
  assert.equal(
    handler.indexOf("renderTree()") > handler.indexOf("budgetTimer = setTimeout"),
    true,
    "renderTree() escaped the debounce"
  );
});

test("the window size is stored per machine, not per file and not in Settings", () => {
  // §3.3 — a physical preference, like where you put a palette. It never travels with a token tree,
  // so its key carries no file identity the way the overlay's and the theme's do.
  assert.equal(codeTs.indexOf('const WINDOW_SIZE_KEY = "tokenvault:window-size"') !== -1, true);
  assert.equal(
    /WINDOW_SIZE_KEY\s*\+|`\$\{WINDOW_SIZE_KEY\}/.test(codeTs),
    false,
    "the window-size key gained a file suffix — the size is per machine, not per file"
  );
});

test("no breakpoints, no layout modes, no width-conditional controls", () => {
  // §3.4 is a constraint, not a preference: a resizable panel means 400px is still reachable, so a
  // layout that only reads correctly at 640px breaks silently for someone sitting at the minimum.
  // A CSS media query on width, or a JS branch on it, is the shape that failure takes.
  const html = readFileSync(join(ROOT, "src/ui/index.html"), "utf8");
  const css = html
    .slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(
    /@media[^{]*(min-width|max-width)/.test(css),
    false,
    "a width breakpoint appeared — §3.4 forbids one, at any width"
  );
});
