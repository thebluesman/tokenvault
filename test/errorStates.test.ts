// Phase 9's error-state contracts, asserted by source inspection — UX `error-states.md`.
//
// Same technique as `applyInvariant.test.ts` and `gitInvariant.test.ts`, and for the same reason:
// these are properties about *which module reaches what*, and the panel has no DOM in CI. What is
// pinned here is the routing — which failure goes to which surface — because that is the part a
// later change breaks silently, and a crash screen that shows up for a handled 404 is a crash screen
// the user learns to ignore (§3.3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Strips comments, so a rule *discussed* in prose isn't mistaken for the thing it forbids. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function read(path: string): string {
  return code(readFileSync(join(ROOT, path), "utf8"));
}

test("only a failed scan is reported as an import failure", () => {
  // §3.3's routing rule, at its source. The catch-all used to post `import-error` for every message
  // type, so a pull that threw told the user their import had failed and moved them to the Import
  // tab. Both destinations must be present, and the scan test must gate the import one.
  const controller = read("src/code.ts");
  const posts = controller.match(/post\(\{\s*type:\s*"import-error"/g) ?? [];
  assert.equal(posts.length, 1, "import-error should be posted from exactly one place");
  assert.equal(
    /message\.type === "scan"\) post\(\{ type: "import-error"/.test(controller),
    true,
    "import-error must be gated on the failing message being a scan"
  );
  assert.equal(
    /post\(\{ type: "plugin-error", message: detail, source: message\.type \}\)/.test(controller),
    true,
    "everything else must go to plugin-error, naming the operation"
  );
});

test("the crash screen is the last resort, not a second notice surface", () => {
  // Nothing but the boundary, the guard and the unexpected-exception message may open it. If a
  // handled failure ever routes here, this is the test that should have to be edited first.
  const main = read("src/ui/main.ts");
  assert.equal(/message\.type === "plugin-error"/.test(main), true);
  assert.equal(/crash\(\{ message: message\.message, context: describeOperation\(message\.source\)/.test(main), true);

  const callers = ["applyDialog.ts", "repo.ts", "git.ts", "settings.ts", "tokens.ts", "detail.ts", "changes.ts"];
  for (const name of callers) {
    assert.equal(
      /\bcrash\(/.test(read(`src/ui/${name}`)),
      false,
      `${name} must report through its own designed notice, never the crash screen`
    );
  }
});

test("the message pump runs inside the boundary", () => {
  // A render that throws mid-message used to leave a half-painted tree that no longer responded,
  // which is indistinguishable from a hung plugin (§3).
  const main = read("src/ui/main.ts");
  assert.equal(/window\.onmessage = \(event: MessageEvent\) => \{\s*guard\(/.test(main), true);
  assert.equal(/installErrorBoundary\(recoverUi\)/.test(main), true);
});

test("recovery re-runs the handshake rather than reloading the document", () => {
  // §3.2. The plugin iframe's document is injected by Figma rather than served, so a reload is
  // unreliable; the handshake re-derives everything the UI holds and is exercised on every open.
  const main = read("src/ui/main.ts");
  assert.equal(/location\.reload/.test(main), false);
  assert.equal(/function recoverUi\(\): void \{[\s\S]*?send\(\{ type: "ui-ready" \}\)/.test(main), true);

  const errors = read("src/ui/errors.ts");
  assert.equal(/location\.reload/.test(errors), false);
});

test("a failed scan never wipes the Import view", () => {
  // §2.1: a scan is read-only, so a failed one changes nothing about the tree the panel is holding.
  // The Phase 2 version cleared `#content` before rendering the failure and took the previous report
  // down with it.
  const view = read("src/ui/importView.ts");
  const showError = /export function showImportError\([\s\S]*?\n\}/.exec(view);
  assert.notEqual(showError, null);
  assert.equal(
    /textContent = ""/.test(showError?.[0] ?? ""),
    false,
    "showImportError must not clear the view — the notice is added to it"
  );
  assert.equal(/scanError !== null\) contentEl\.appendChild\(renderScanError/.test(view), true);
});

test("a scan failure leaves the Tokens tab reachable", () => {
  // The cached tree and the durable overlay both survive a failed scan, so disabling the tab would
  // hide working features behind a failure that didn't touch them.
  const main = read("src/ui/main.ts");
  const handler = /if \(message\.type === "import-error"\) \{[\s\S]*?\n  \}/.exec(main);
  assert.notEqual(handler, null);
  assert.equal(/tokensTab\.disabled\s*=/.test(handler?.[0] ?? ""), false);
});

test("the delete confirmation stays open until the plugin answers", () => {
  // UX apply-and-drift §7: *"Delete in Figma failed → `.entry` block on the confirmation, which
  // stays open"*. It used to close on the confirming tap and report the failure in a toast.
  const panel = read("src/ui/deleteFigma.ts");
  const confirm = /send\(\{ type: "delete-in-figma"/.exec(panel);
  assert.notEqual(confirm, null);
  const before = panel.slice(0, confirm?.index ?? 0);
  const handlerStart = before.lastIndexOf("confirm.addEventListener");
  assert.equal(
    /closeDeletePanel\(\)/.test(before.slice(handlerStart)),
    false,
    "the confirming tap must not close the screen — the result does"
  );
  assert.equal(/export function reportDeleteResult\(/.test(panel), true);
});

test("an apply failure outlives its toast", () => {
  // §7, amended 2026-09-04: the toast is gone in 1.8 seconds and the failure is still true after it.
  const main = read("src/ui/main.ts");
  assert.equal(/setApplyFailure\(\{\s*text: "Couldn't apply — nothing changed in Figma\."/.test(main), true);
  assert.equal(/reportDeleteResult\(report\.failed, firstFailure\(message\)\)/.test(main), true);

  const tokens = read("src/ui/tokens.ts");
  assert.equal(/export function setApplyFailure\(/.test(tokens), true);
  assert.equal(/"apply failed"/.test(tokens), true);
});

test("the overlay recovery notice is non-blocking and offers the data back", () => {
  // §4.1's third step: the panel stays usable, and the quarantined bytes are reachable. A notice
  // about lost work with no way to look at what was lost is half a state.
  const tokens = read("src/ui/tokens.ts");
  assert.equal(/model\.overlayRecovery/.test(tokens), true);
  assert.equal(/Copy the unreadable data/.test(tokens), true);
  // Rendered as a notice among the others — never a modal, never a takeover.
  assert.equal(/noticesEl\.appendChild\(box\)/.test(tokens), true);
});

test("the unreadable overlay is quarantined before anything can overwrite it", () => {
  // §4.1's second step, and the ordering is the decision: recover, quarantine, *then* report. A
  // store that destroys the only copy of the user's work while reporting a problem with it is not
  // defensible at any price.
  const controller = read("src/code.ts");
  assert.equal(/const EDIT_QUARANTINE_PREFIX = "tokenvault:edits-unreadable:"/.test(controller), true);
  const load = /async function loadOverlay\(\)[\s\S]*?\n\}/.exec(controller);
  assert.notEqual(load, null);
  const body = load?.[0] ?? "";
  assert.equal(body.indexOf("setAsync(quarantineKey()") < body.indexOf("overlayRecovery ="), true);
  // Never twice for the same file: a second corruption must not bury the first one's quarantine.
  assert.equal(/existing === undefined \|\| existing === null/.test(body), true);
});

test("a blocked cycle row can open the loop", () => {
  // UX references-math-themes §7.3c / §10: the apply dialog's cycle row gets `[ Show the loop ]`,
  // *"opening the block rather than repeating it inside a list row"*. The audit found this as the
  // one missing caller of the three the block was built for.
  const dialog = read("src/ui/applyDialog.ts");
  assert.equal(/Show the loop/.test(dialog), true);
  assert.equal(/cycleBlock\(/.test(dialog), true);
  // Same block, not a second rendering of a loop — §7.2 is one component, three callers.
  assert.equal(/function cycleBlock/.test(dialog), false);
  assert.equal(/CYCLE_REASONS = \["alias-cycle", "expression-cycle"\]/.test(dialog), true);
});

test("the crash screen carries the sentence about the user's edits", () => {
  // §3.1. The first question after a crash in an editor is whether the work is gone, and here the
  // answer is a genuine no. Pinned because it is the line most likely to be trimmed as verbose.
  const errors = read("src/ui/errors.ts");
  assert.equal(/Your local edits are saved/.test(errors), true);
  assert.equal(/Reload the panel/.test(errors), true);
  assert.equal(/Copy details/.test(errors), true);
});
