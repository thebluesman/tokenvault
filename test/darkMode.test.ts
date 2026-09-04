// Phase 10's dark mode, pinned where it can actually be checked — UX `docs/ux/dark-mode.md`.
//
// The panel has no DOM in CI, so this is source inspection, the same technique as
// `errorStates.test.ts` and `gitInvariant.test.ts`. That is not a weakness here: almost everything
// dark-mode.md asks for is a *structural* property of the stylesheet rather than something you see.
//
//   - Every colour is a custom property, and every custom property is declared in one of four
//     `:root` blocks (§2.2, §3). A component-level theme override means a colour escaped the audit.
//   - The neutrals are sourced from Figma where the two themes agree and from the snapshot where
//     they don't (§2.1) — four selectors, resolving four combinations.
//   - In **dark**, the green stays quieter than the amber, ranked numerically rather than by eye
//     (§5.1). The naive dark-mode move of lifting every colour to the same perceived brightness
//     inverts that ranking, and a confirmation that out-shouts a warning breaks
//     `apply-and-drift.md` §8. Light is pinned by *value* instead — see the note above the ratio
//     tests for why the two halves are checked differently.
//   - Red stays a button-and-menu-label colour, never a state colour (§5.3).
//
// What this cannot check is the part that needs eyes: whether `--ok-bg` still reads green rather
// than grey, whether `--muted` is readable on `--bg-raised`, and whether the real injected
// `--figma-color-*` values match the snapshot literals. Those are §8's checklist, for a human in
// front of Figma.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, "src/ui/index.html"), "utf8");

/** The stylesheet, with comments stripped so prose about a colour isn't mistaken for one. */
const css = html
  .slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"))
  .replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
}

const rules: Rule[] = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
  selector: match[1].trim().replace(/\s+/g, " "),
  body: match[2],
}));

/** The four palette blocks of §2.2, in the order the cascade depends on. */
const PALETTE_SELECTORS = [
  ":root",
  ":root.tv-dark, :root.figma-dark:not(.tv-light)",
  ":root:not(.figma-dark):not(.tv-dark)",
  ":root.figma-dark:not(.tv-light)",
];

const paletteRules = rules.filter((rule) => PALETTE_SELECTORS.indexOf(rule.selector) !== -1);

function block(index: number): Rule {
  const found = paletteRules[index];
  assert.ok(found !== undefined, `palette block ${index + 1} is missing`);
  return found;
}

/** `--name: value;` declarations in a rule body. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1], match[2].trim());
  }
  return out;
}

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;

// ---------------------------------------------------------------------------
// §2.2 / §3 — the structure
// ---------------------------------------------------------------------------

test("the four palette blocks exist, in the order the cascade needs", () => {
  // Blocks 3-4 have equal specificity with block 2, so **source order is what decides** which of
  // the four cells in §2.1's table wins. Reordering them silently breaks the override.
  assert.deepEqual(
    paletteRules.map((rule) => rule.selector),
    PALETTE_SELECTORS
  );
});

test("no colour literal appears outside the palette blocks", () => {
  // §3's audit, kept true. Thirteen hardcoded values across twenty-three declarations is where this
  // phase started; the point of tokenising them is that the *next* phase cannot quietly add a
  // fourteenth, because a literal in a component rule is a rule with no dark counterpart.
  for (const rule of rules) {
    if (PALETTE_SELECTORS.indexOf(rule.selector) !== -1) continue;
    const found = rule.body.match(COLOUR) ?? [];
    assert.deepEqual(found, [], `${rule.selector} carries a colour literal: ${found.join(", ")}`);
  }
});

test("no selector outside the palette blocks mentions a theme class", () => {
  // §2.2, and §8's step-1 acceptance: *"No theme-class selector exists except §2.2's four `:root`
  // blocks."* A component-level `.tv-dark` or `.figma-dark` override means a colour escaped §3 and
  // is being patched per-component instead of being made a token.
  for (const rule of rules) {
    if (PALETTE_SELECTORS.indexOf(rule.selector) !== -1) continue;
    // The first-paint hold (§2.4) is the one non-palette rule allowed to name a `tv-` class, and it
    // is about visibility rather than colour.
    if (rule.selector === ":root:not(.tv-painted) body") continue;
    assert.equal(
      /\.(tv-light|tv-dark|figma-light|figma-dark)\b/.test(rule.selector),
      false,
      `${rule.selector} has a theme variant — the colour under it should have been a token`
    );
  }
});

test("blocks 3 and 4 redeclare only neutrals, and always with a snapshot fallback", () => {
  // They fire only where the panel's theme and Figma's agree, and they exist to repoint the
  // *neutrals* at Figma's injected variables (§2.1). A semantic colour appearing here would mean a
  // hand-authored value silently changing between the agree and disagree cells.
  //
  // `--toast-bg` is the one non-neutral among them, and deliberately: §6.2 wants the dark toast to
  // be "one step lighter than raised" by construction rather than by a number.
  const allowed = new Set([
    "--bg",
    "--bg-raised",
    "--bg-subtle",
    "--text",
    "--muted",
    "--border",
    "--swatch-ring",
    "--toast-bg",
  ]);
  for (const index of [2, 3]) {
    for (const [name, value] of declarations(block(index).body)) {
      assert.equal(allowed.has(name), true, `${name} does not belong in a neutral-repoint block`);
      assert.equal(
        value.indexOf("var(--figma-color-") === 0,
        true,
        `${name} in block ${index + 1} should be sourced from Figma`
      );
      // §2.1: the snapshot *"also serves as the fallback if a future Figma release stops injecting
      // a variable we read"* — so a bare `var()` with no fallback is a latent blank panel.
      assert.equal(
        /,\s*[^)]/.test(value),
        true,
        `${name} in block ${index + 1} has no fallback if Figma stops injecting it`
      );
    }
  }
});

test("every custom property the panel uses is declared in the light block", () => {
  // Block 1 is the base every other block overrides, so a property declared only in the dark block
  // is undefined in light. Covers the TypeScript too — `applyDialog`, `tokens` and `valueField`
  // each set a colour from JS, and §2.2 requires those to be `var()` references rather than
  // literals precisely so they follow the cascade.
  const declared = new Set(declarations(block(0).body).keys());
  const sources: string[] = [css];
  const uiDir = join(ROOT, "src/ui");
  for (const name of readdirSync(uiDir)) {
    if (name.endsWith(".ts")) sources.push(readFileSync(join(uiDir, name), "utf8"));
  }
  for (const text of sources) {
    for (const match of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = match[1];
      if (name.indexOf("--figma-color-") === 0) continue;
      assert.equal(declared.has(name), true, `${name} is used but never declared in :root`);
    }
  }
});

test("both themes declare color-scheme explicitly", () => {
  // §6.5, the single highest-ratio line in the change: without it every native control renders in
  // its light form on a dark panel — scrollbars above all, of which this panel has many. Light is
  // declared explicitly rather than left unset so that a `tv-light` panel inside a *dark* Figma
  // gets light controls instead of inheriting the host's.
  assert.equal(/color-scheme:\s*light/.test(block(0).body), true);
  assert.equal(/color-scheme:\s*dark/.test(block(1).body), true);
});

// ---------------------------------------------------------------------------
// §5 — the semantic language
// ---------------------------------------------------------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((each) => each + each)
          .join("")
      : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A theme's effective palette: the dark block over the light one. */
function palette(dark: boolean): Map<string, string> {
  const out = declarations(block(0).body);
  if (dark) for (const [name, value] of declarations(block(1).body)) out.set(name, value);
  return out;
}

function colour(theme: Map<string, string>, name: string): string {
  const value = theme.get(name);
  assert.ok(value !== undefined, `${name} is not declared`);
  assert.equal(/^#[0-9a-fA-F]{3,8}$/.test(value), true, `${name} is not a plain hex: ${value}`);
  return value;
}

/**
 * The numeric constraints are **dark-mode constraints**, and deliberately not applied to light.
 *
 * §8.1 requires the light palette to come out of this phase byte-identical to what nine phases
 * shipped, so light is pinned below by value rather than by ratio. That matters, because the light
 * palette does not satisfy these ratios and was never meant to: `--ok` (#2f7d55) is 5.02:1 on white
 * while `--warn` (#b8730a) is 3.82:1, so in light the green is *louder* than the amber by contrast
 * ratio. §1 says why that is not a contradiction — in light the ranking is achieved by
 * **desaturating the green**, and it is only in dark, where saturation behaves differently and the
 * naive "lift everything to equal perceived brightness" move inverts the ranking, that §5 fixes the
 * ordering numerically instead. §4.2's line about `#2f7d55` sitting below `#b8730a` in light is
 * true of chroma, not of contrast.
 */
const darkTheme = palette(true);

test("green stays quieter than amber in dark", () => {
  // §5.1 / §4.2, and the one ratio in the palette that must not be "improved": a confirmation must
  // never out-shout a warning (`apply-and-drift.md` §8). If a future contrast pass wants to lift
  // `--ok`, it has to lift `--warn` further first.
  const bg = colour(darkTheme, "--bg");
  const ok = contrast(colour(darkTheme, "--ok"), bg);
  const warn = contrast(colour(darkTheme, "--warn"), bg);
  assert.equal(
    ok < warn,
    true,
    `--ok (${ok.toFixed(2)}:1) must sit below --warn (${warn.toFixed(2)}:1)`
  );
});

test("dark text colours clear 4.5:1 on the panel floor", () => {
  // §4.2 step 4: *"The ordering is the acceptance criterion, not the absolute numbers"* — but the
  // floor under the ordering is still 4.5:1 for everything read as text.
  const bg = colour(darkTheme, "--bg");
  for (const name of ["--text", "--accent-text", "--danger-text", "--warn", "--ok"]) {
    const ratio = contrast(colour(darkTheme, name), bg);
    assert.equal(ratio >= 4.5, true, `${name} is ${ratio.toFixed(2)}:1 on --bg`);
  }
});

test("dark text colours stay readable on the raised surface too", () => {
  // §8.10: Figma tunes `--muted` against its own floor, and our raised surface is a use Figma does
  // not have. Only arithmetic against the snapshot is available here; §8.10's eye-check is what
  // covers the sourced values.
  const raised = colour(darkTheme, "--bg-raised");
  for (const name of ["--text", "--muted", "--warn", "--ok"]) {
    const ratio = contrast(colour(darkTheme, name), raised);
    assert.equal(ratio >= 3, true, `${name} is ${ratio.toFixed(2)}:1 on --bg-raised`);
  }
});

test("--on-fill is legible on the danger fill in both themes", () => {
  // `--danger` stays ours in both themes and carries `--on-fill` rather than `--text`.
  //
  // `--accent` is deliberately **not** checked: white on Figma's own `#0d99ff` is about 2.8:1, and
  // §4.3 argues it stays anyway — *"this is Figma's own primary blue at Figma's own contrast, and
  // matching the host is worth more here than the ratio"*. Accent text is a different problem and
  // has its own token, which is checked above.
  for (const theme of [palette(false), darkTheme]) {
    const ratio = contrast(colour(theme, "--on-fill"), colour(theme, "--danger"));
    assert.equal(ratio >= 4.5, true, `--on-fill on --danger is ${ratio.toFixed(2)}:1`);
  }
});

test("the dark tints stay distinguishable from the panel", () => {
  // §5.1's worry, as far as arithmetic can take it: dark tinted fills at low chroma drift toward
  // "just a grey chip". A ratio cannot tell green from grey — §8.9 is the eye-check that can — but
  // a tint that has collapsed onto the background is catchable here.
  for (const [tint, on] of [
    ["--warn-bg", "--warn"],
    ["--ok-bg", "--ok"],
  ]) {
    assert.equal(
      contrast(colour(darkTheme, tint), colour(darkTheme, "--bg")) > 1.05,
      true,
      `${tint} has collapsed onto --bg`
    );
    assert.equal(
      contrast(colour(darkTheme, on), colour(darkTheme, tint)) >= 4.5,
      true,
      `${on} is unreadable on ${tint}`
    );
  }
});

test("the light palette is byte-identical to what nine phases shipped", () => {
  // §8.1, the step-1 acceptance criterion: the tokenisation is a **pure refactor**, so every light
  // value stays exactly what it was and the light panel renders unchanged. The two swatch tokens
  // are the doc's own named exceptions (§6.3) and are checked separately above.
  const light = palette(false);
  const shipped: Record<string, string> = {
    "--border": "#e6e6e6",
    "--muted": "#8c8c8c",
    "--bg-subtle": "#f5f5f5",
    "--accent": "#0d99ff",
    "--accent-text": "#0d99ff",
    "--warn": "#b8730a",
    "--warn-bg": "#fff6e5",
    "--ok": "#2f7d55",
    "--ok-bg": "#eef7f1",
    "--danger": "#c4382f",
    "--danger-text": "#c4382f",
    "--text": "#1a1a1a",
    "--bg": "#ffffff",
    "--bg-raised": "#ffffff",
    "--on-fill": "#ffffff",
    "--mark-bg": "#fff2a8",
    "--toast-bg": "#1a1a1a",
    "--toast-text": "#ffffff",
    "--toast-action": "#7cc4ff",
  };
  for (const [name, value] of Object.entries(shipped)) {
    assert.equal(colour(light, name), value, `${name} moved in light mode`);
  }
});

test("the hover filter flips direction between the themes", () => {
  // §6.4: on a dark ground, darkening a fill reads as *receding* — the opposite of a hover.
  const light = declarations(block(0).body).get("--fill-hover") ?? "";
  const dark = declarations(block(1).body).get("--fill-hover") ?? "";
  const value = (each: string): number => Number(each.replace(/[^0-9.]/g, ""));
  assert.equal(value(light) < 1, true, `light --fill-hover should darken, got ${light}`);
  assert.equal(value(dark) > 1, true, `dark --fill-hover should lighten, got ${dark}`);
});

test("red is a button and menu-label colour and nothing else", () => {
  // §5.3. The `--danger` / `--danger-text` split in §4.2 is a legibility fix, not a licence: after
  // it there are still exactly two sites, `button.danger` (with its hover) and
  // `.popover .item.danger`. Any third is a defect — a control that wants red needs
  // `apply-and-drift.md` §5.7's treatment, not a palette entry.
  const sites = rules
    .filter((rule) => PALETTE_SELECTORS.indexOf(rule.selector) === -1)
    .filter((rule) => /var\(--danger(-text)?\)/.test(rule.body))
    .map((rule) => rule.selector)
    .sort();
  assert.deepEqual(sites, ["button.danger", "button.danger:hover", ".popover .item.danger"].sort());
});

test("the swatch decorations are sourced, never a tuned hairline", () => {
  // §6.3. The failure this guards is precise: a `#000000` token on a dark panel is an invisible
  // 12px square, which is exactly the failure a colour tool cannot have. The old fixed
  // `rgba(0,0,0,0.15)` hairline was tuned against one known background; after §9.2 the background
  // is Figma's, so the ring is sourced from the colour whose contrast with it Figma maintains.
  const swatch = rules.find((rule) => rule.selector === ".swatch");
  assert.ok(swatch !== undefined);
  assert.equal(/box-shadow:\s*inset 0 0 0 1px var\(--swatch-ring\)/.test(swatch.body), true);
  assert.equal(/background-color:\s*var\(--checker-a\)/.test(swatch.body), true);
  const fill = rules.find((rule) => rule.selector === ".swatch-fill");
  assert.ok(fill !== undefined);
  assert.equal(/var\(--swatch-ring\)/.test(fill.body), true);

  // Square A is the panel's own ground, so a semi-transparent token composites against exactly the
  // surface it will look like in use — which is more correct than the authored `#fff`/`#ddd` pair
  // ever was, and it never glows in dark.
  const light = declarations(block(0).body);
  assert.equal(light.get("--checker-a"), "var(--bg)");
  assert.equal(light.get("--checker-b"), "var(--border)");
});

// ---------------------------------------------------------------------------
// §2 — the mechanism
// ---------------------------------------------------------------------------

test("the UI is created with themeColors", () => {
  // §2: there is no other supported way for a plugin to learn Figma's theme, so this flag is
  // load-bearing whatever else the doc decided. Without it Figma stamps no class and injects no
  // variables, and three of the four palette blocks never fire.
  const code = readFileSync(join(ROOT, "src/code.ts"), "utf8");
  assert.equal(/figma\.showUI\(__html__, \{[^}]*themeColors: true/.test(code), true);
});

test("the appearance preference has its own storage key and never touches the overlay", () => {
  // §2.3: stored in `clientStorage` per user beside the repo settings, under its own key. **Not**
  // the tokens overlay — that is document content that syncs to a repo, and a personal display
  // preference must never travel to anyone else's checkout. Not per Figma file either.
  const code = readFileSync(join(ROOT, "src/code.ts"), "utf8");
  const key = code.match(/const APPEARANCE_KEY = "([^"]+)"/);
  assert.ok(key !== null, "APPEARANCE_KEY is missing");
  assert.equal(key[1].indexOf(":") !== -1, true, "the key should be namespaced");
  // Not suffixed with a file identity, which is what a per-file key looks like here.
  assert.equal(/APPEARANCE_KEY \+/.test(code), false, "the key must not be per-file");
  for (const other of ["editStorageKey()", "SETTINGS_KEY", "PAT_KEY", "syncKey("]) {
    assert.equal(
      code.indexOf(`${other}, message.appearance`) === -1,
      true,
      `the appearance value must not be written through ${other}`
    );
  }
});

test("the appearance class is stamped before the first paint is released", () => {
  // §2.4. The doc assumed Phase 9's `ui-ready` handshake already gated first paint; it gates the
  // first *screen*, while the header and the panel ground are static markup that paint at once. So
  // the chrome is held instead — which is what §2.4 says to do if that turned out to be the case.
  const main = readFileSync(join(ROOT, "src/ui/main.ts"), "utf8");
  const applied = main.indexOf("applyAppearance(message.appearance)");
  const released = main.indexOf("releaseFirstPaint()");
  assert.equal(applied !== -1 && released !== -1, true, "both calls should be in the ready handler");
  assert.equal(applied < released, true, "the class must be stamped before the paint is released");
  assert.equal(/:root:not\(\.tv-painted\) body \{\s*visibility: hidden/.test(css), true);

  // A main thread that throws before replying would otherwise leave a permanently blank panel,
  // which is a far worse failure than the flash the hold exists to prevent.
  const appearance = readFileSync(join(ROOT, "src/ui/appearance.ts"), "utf8");
  assert.equal(/setTimeout\(releaseFirstPaint/.test(appearance), true, "no first-paint failsafe");
  const errors = readFileSync(join(ROOT, "src/ui/errors.ts"), "utf8");
  assert.equal(/releaseFirstPaint\(\)/.test(errors), true, "the crash screen must release the hold");
});

test("Auto stamps nothing, and an override never replaces Figma's class", () => {
  // §2.2's two properties worth keeping: Auto costs zero lines of script (with no `tv-*` class,
  // `figma-dark` alone drives blocks 2 and 4), and our class is added *alongside* Figma's — Figma
  // re-stamps its own on every theme change, so rewriting it means fighting the host for no gain.
  const appearance = readFileSync(join(ROOT, "src/ui/appearance.ts"), "utf8");
  assert.equal(/classList\.toggle\("tv-light", next === "light"\)/.test(appearance), true);
  assert.equal(/classList\.toggle\("tv-dark", next === "dark"\)/.test(appearance), true);
  assert.equal(
    /classList\.(remove|toggle|add)\("figma-/.test(appearance),
    false,
    "nothing may touch Figma's own class"
  );
});
