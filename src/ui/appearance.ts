// The panel's Appearance setting — UX `docs/ux/dark-mode.md` §2.
//
// This module is the entire script cost of dark mode. Everything else is cascade: `index.html`'s
// four `:root` blocks resolve the four combinations of §2.1's table on their own, and **no
// component selector anywhere carries a theme variant**. All this does is stamp one class.
//
//   - **Auto stamps nothing.** Figma's own `figma-light` / `figma-dark` class drives the cascade,
//     it is re-stamped by Figma on every editor theme change, and the panel follows live with no
//     listener, no media query and no reload. Auto is the default, and the default path runs none
//     of this beyond a `classList.remove`.
//   - **An override stamps `tv-light` / `tv-dark` beside Figma's class**, never replacing it —
//     Figma's class is what its injected `--figma-color-*` style block is keyed to, and it is
//     re-stamped on every theme change, so rewriting it means fighting the host for no gain.
//
// Note what is *not* here: nothing reads the effective theme back out. Token content is never
// re-themed under any circumstance (§7) — a `#ffffff` token renders white on a dark panel because
// that is the fact the user opened the panel to check — and chrome colour is settled entirely by
// custom properties. A future contributor who needs to branch on the theme in TypeScript should
// suspect the rule before writing the branch.

import type { Appearance } from "../messages";
import { send } from "./state";

const root = document.documentElement;

let current: Appearance = "auto";

export function getAppearance(): Appearance {
  return current;
}

/**
 * Stamps the class for `next`. Live in both directions (§2.3): the cascade repaints every open
 * surface in place — popover, apply dialog, a visible toast — with no reload and no re-render.
 */
export function applyAppearance(next: Appearance): void {
  current = next;
  root.classList.toggle("tv-light", next === "light");
  root.classList.toggle("tv-dark", next === "dark");
}

/** Stamp it and persist it. The write is fire-and-forget; the paint has already happened. */
export function setAppearance(next: Appearance): void {
  if (next === current) return;
  applyAppearance(next);
  send({ type: "set-appearance", appearance: next });
}

/**
 * Releases the first paint — §2.4.
 *
 * The stored value lives in `clientStorage`, which only the main thread can read, asynchronously,
 * so there is a window where the UI exists and the class does not. §2.4 assumed Phase 9's
 * `ui-ready` handshake already gated first paint; it does not — it gates the first *screen*, while
 * the header, the tab strip and the panel ground are static markup that paint immediately. So the
 * chrome is held instead, exactly as §2.4 says to do if that turned out to be the case.
 *
 * `index.html` hides `body` until `tv-painted` is on `<html>`; this puts it there. The failsafe
 * timer is the answer to the obvious objection — a main thread that throws before it replies would
 * otherwise leave a permanently blank panel, which is a far worse failure than the flash this
 * exists to prevent. On that path Auto is what paints, which is also the correct guess.
 */
export function releaseFirstPaint(): void {
  root.classList.add("tv-painted");
}

export function installFirstPaintFailsafe(afterMs = 1500): void {
  window.setTimeout(releaseFirstPaint, afterMs);
}
