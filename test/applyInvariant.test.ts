// The apply dialog is an invariant, not a default — UX apply-and-drift §5.2, §10.
//
// §5.2 states it as a property of the code, not of the design:
//
//   > there is **no code path** that writes to Figma without this dialog having been shown and
//   > confirmed — not the single-token `⋯ → Apply`, not `Re-apply token` on a drift row (§6.4),
//   > not a bulk re-apply from the Changes list (§6.5). Every one of them routes through here.
//
// and §10 adds: *"Assert it if that's cheap."* It is cheap, so this asserts it — by source
// inspection, because the property is about which modules can reach the write, and no runtime test
// can prove the absence of a second path.
//
// The related §10 rule — *"don't let a delete become an op in the apply batch"* — is checked the
// same way: `delete-in-figma` is its own message with its own handler, and the apply dialog must
// never be able to send one.
//
// If a future ticket wants a fast path, it amends UX §5.2 first, and then this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UI = join(process.cwd(), "src/ui");

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(UI)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(UI, name), "utf8") }));
}

/** Strips comments, so a message name *discussed* in prose isn't mistaken for one being sent. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("only the apply dialog can send an apply", () => {
  const senders = sources()
    .filter(({ text }) => /send\(\{\s*type:\s*"apply"/.test(code(text)))
    .map(({ name }) => name);

  assert.deepEqual(
    senders,
    ["applyDialog.ts"],
    "a write to Figma must be reachable only from the confirmed dialog (UX §5.2)"
  );
});

test("only the delete confirmation can send a delete", () => {
  const senders = sources()
    .filter(({ text }) => /send\(\{\s*type:\s*"delete-in-figma"/.test(code(text)))
    .map(({ name }) => name);

  assert.deepEqual(
    senders,
    ["deleteFigma.ts"],
    "deletion is its own flow with its own confirmation (ADR-0005 §5)"
  );
});

test("the apply dialog cannot send a delete, and the delete flow cannot send an apply", () => {
  // The two verbs share nothing but a word in casual speech (UX §10). Crossing them is how a
  // pre-checked apply row ends up removing a Variable.
  const dialog = code(readFileSync(join(UI, "applyDialog.ts"), "utf8"));
  const del = code(readFileSync(join(UI, "deleteFigma.ts"), "utf8"));
  assert.equal(/delete-in-figma/.test(dialog), false);
  assert.equal(/send\(\{\s*type:\s*"apply"/.test(del), false);
});

test("no plugin-side undo is offered for anything that touches the file", () => {
  // UX §5.5, §9.3: no `[ Undo ]` on the apply, bind or delete toasts, and no pre-write value cache
  // kept alive for one. Phase 4's local undo is untouched — it covers tree-only actions, which is
  // exactly why it keeps its button — so the check is scoped to the two canvas-write surfaces.
  for (const name of ["applyDialog.ts", "deleteFigma.ts"]) {
    const text = code(readFileSync(join(UI, name), "utf8"));
    assert.equal(
      /label:\s*"Undo"/.test(text),
      false,
      `${name} must not offer a plugin-side undo for a canvas write`
    );
  }
});

/**
 * The Figma plugin API's entry points off the global.
 *
 * Named explicitly rather than matched as `figma.*`, because `figma` is also what the codebase
 * calls a token's provenance block (`$extensions["com.tokenvault"].figma`) — so a bare prefix match
 * flags `merge.ts` reading `figma.collectionId` off a plain object and means nothing by it.
 */
const FIGMA_API =
  /\bfigma\.(variables|root|ui|currentPage|clientStorage|viewport|getStyleByIdAsync|getNodeByIdAsync|setCurrentPageAsync|loadFontAsync|commitUndo|triggerUndo|notify|showUI|closePlugin|fileKey|create[A-Z])/;

test("the impure write boundary is a single module", () => {
  // ADR-0005 §3, and the same boundary precedent as ADR-0002's module layout and ADR-0003 §7: one
  // impure edge, everything else pure and unit-testable without a Figma runtime. That is the whole
  // reason this phase's several dozen refusal rules are testable at all.
  const tokens = join(process.cwd(), "src/tokens");
  for (const name of readdirSync(tokens)) {
    const text = code(readFileSync(join(tokens, name), "utf8"));
    assert.equal(FIGMA_API.test(text), false, `src/tokens/${name} must not touch the figma global`);
  }
});

test("apply.ts is the only module in src/figma that writes", () => {
  // The scanners are read-only by contract: if a write ever appears in one, the drift baseline
  // stops being a record of what someone else did and starts including our own edits.
  const WRITES = /\.(remove|setValueForMode)\(|\.(paints|effects|layoutGrids|fontName|fontSize|lineHeight|letterSpacing|description)\s*=/;
  const dir = join(process.cwd(), "src/figma");
  for (const name of readdirSync(dir)) {
    if (name === "apply.ts") continue;
    const text = code(readFileSync(join(dir, name), "utf8"));
    assert.equal(WRITES.test(text), false, `src/figma/${name} must stay read-only`);
  }
});
