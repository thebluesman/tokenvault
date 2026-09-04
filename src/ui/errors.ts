// The crash screen — UX `error-states.md` §3.
//
// The last-resort surface, and the only new container Phase 9 adds. Everything the product knows how
// to fail at has a designed notice inside the panel (`apply-and-drift.md` §7, `git-sync.md` §11,
// `references-math-themes.md` §10, `local-editor.md` §8); this is for the failures nobody designed,
// where the panel can no longer be trusted to render a notice inside itself.
//
// **The routing rule matters more than the screen does** (§3.3): a handled failure must never arrive
// here. A crash screen that shows up for a 404 is a crash screen the user learns to ignore.

import { button, clear, el } from "./dom";
import { releaseFirstPaint } from "./appearance";

const crashEl = document.getElementById("crash") as HTMLElement;

export interface CrashDetail {
  /** `error.message` — never a stack, which goes on the clipboard behind `[ Copy details ]`. */
  message: string;
  /** What was being done, when that is actually known. Never invented. */
  context?: string;
  /** Everything a debugger wants, for `[ Copy details ]`. */
  diagnostics?: string;
}

let crashed = false;
let onRecover: (() => void) | null = null;

export function isCrashed(): boolean {
  return crashed;
}

/**
 * How a message type reads in a sentence — §3.1's context line.
 *
 * A lookup rather than a prettifier over the message name: `git-repo-baseline` prettifies to
 * something that means nothing to the person reading it, and a context line that confuses is worse
 * than no context line. Anything unlisted gets no line at all.
 */
const OPERATIONS: Record<string, string> = {
  edit: "While saving an edit",
  revert: "While undoing an edit",
  "revert-entries": "While undoing your edits",
  "keep-mine": "While resolving a conflict",
  apply: "While applying to Figma",
  "delete-in-figma": "While deleting from Figma",
  "count-consumers": "While checking what uses this",
  "select-nodes": "While selecting layers",
  "set-subtypes": "While changing a type",
  "copy-tree": "While copying the token tree",
  "copy-scan": "While copying the Figma scan",
  "git-load": "While reading the repo connection",
  "git-save-settings": "While saving the repo settings",
  "git-save-sync": "While recording the sync state",
  "git-request-token": "While reading the stored token",
  "git-repo-baseline": "While comparing against the repo",
  "git-pull": "While landing a pull",
  "set-active-theme": "While switching theme",
  "switch-page-theme": "While switching this page's theme",
  "ui-ready": "While starting up",
};

export function describeOperation(source: string): string | undefined {
  return OPERATIONS[source];
}

/**
 * Installs the iframe's last-resort handlers and the recovery route.
 *
 * `recover` re-runs the UI's startup handshake rather than reloading the document (§3.2): the plugin
 * iframe's document is injected by Figma rather than served, so `location.reload()` is unreliable
 * across versions, and the handshake re-derives everything the UI holds anyway.
 */
export function installErrorBoundary(recover: () => void): void {
  onRecover = recover;

  window.addEventListener("error", (event: ErrorEvent) => {
    crash({
      message: event.message || "Unknown error",
      diagnostics: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    crash({
      message: reason instanceof Error ? reason.message : String(reason),
      diagnostics: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

/**
 * Runs `work`, and turns anything it throws into the crash screen.
 *
 * Wrapped around the message pump so a render that throws mid-message lands here rather than leaving
 * a half-painted tree that no longer responds — which is the state Phase 9 was built to remove, and
 * the one that is indistinguishable from a hung plugin.
 */
export function guard<T>(work: () => T, context?: string): T | undefined {
  try {
    return work();
  } catch (error: unknown) {
    crash({
      message: error instanceof Error ? error.message : String(error),
      context,
      diagnostics: error instanceof Error ? error.stack : undefined,
    });
    return undefined;
  }
}

/**
 * Takes the panel over.
 *
 * Idempotent by design: a crash frequently cascades (one throw, then the failed render's own throw),
 * and the *first* error is the useful one. Later ones are dropped rather than overwriting the screen
 * with a downstream symptom.
 */
export function crash(detail: CrashDetail): void {
  // **Nothing is logged**, here of all places. `gitInvariant.test.ts` asserts that no module in the
  // product calls `console.*`, because ADR-0006 §1 forbids the PAT reaching a log — and a crash
  // handler that logs "whatever was in flight" is precisely how a credential ends up in one. The
  // diagnostics go to `[ Copy details ]`, which is a deliberate act by the person holding the token.
  if (crashed) return;
  crashed = true;

  // A crash before the handshake replies would otherwise land behind the first-paint hold (UX
  // `dark-mode.md` §2.4) — a crash screen nobody can see is the blank iframe §3 exists to replace.
  // Auto is what paints in that case, which is the right guess when the stored value never arrived.
  releaseFirstPaint();

  clear(crashEl);
  crashEl.classList.remove("hidden");

  const card = el("div", "crash-card");
  card.appendChild(el("h2", undefined, "Something went wrong."));
  card.appendChild(
    el(
      "p",
      undefined,
      // The sentence the screen exists for. The user's first question after a crash in an editor is
      // whether they just lost their work, and here the answer is a genuine no — edits are written
      // to plugin storage on every change (ADR-0004 §1), not held in this iframe.
      "Tokenvault hit an error it didn't expect and stopped where it was. Your local edits are saved — they're in this file's plugin storage, and reloading the panel won't touch them."
    )
  );

  const box = el("div", "entry");
  if (detail.context !== undefined) box.appendChild(el("span", "kind", detail.context));
  box.appendChild(el("div", undefined, detail.message));
  card.appendChild(box);

  const actions = el("div", "toolbar");
  const reload = button("Reload the panel", "primary");
  reload.addEventListener("click", () => {
    const run = onRecover;
    crashed = false;
    clear(crashEl);
    crashEl.classList.add("hidden");
    if (run !== null) run();
  });
  actions.appendChild(reload);

  const copy = button("Copy details");
  copy.addEventListener("click", () => {
    // Not `dom.copy`, which toasts through the panel this screen has just taken over.
    const clipboard = document.getElementById("clipboard") as HTMLTextAreaElement;
    clipboard.value = [detail.context, detail.message, detail.diagnostics]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n");
    clipboard.select();
    try {
      document.execCommand("copy");
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
  });
  actions.appendChild(copy);
  card.appendChild(actions);

  card.appendChild(
    el(
      "p",
      "empty",
      "If it comes straight back, copy the details and close the plugin — nothing in Figma or in your repo has been left half-written."
    )
  );

  crashEl.appendChild(card);
}
