// Reference recognition and the inbound index — UX local-editor §5.3, §7.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Token } from "../src/tokens/types";
import {
  buildInboundIndex,
  collectReferences,
  inboundReferrers,
  isReference,
  referenceTarget,
} from "../src/tokens/references";

function token(value: unknown, extras: Record<string, unknown> = {}): Token {
  return {
    $type: "color",
    $value: value as Token["$value"],
    $extensions: { "com.tokenvault": { figma: { variableId: "v", modeId: "m", ...extras } } },
  };
}

test("a reference is the whole value, not a substring of it", () => {
  assert.equal(isReference("{folio.ref.red.50}"), true);
  assert.equal(referenceTarget("{folio.ref.red.50}"), "folio.ref.red.50");
  // Phase 7's math is not a Phase 4 reference, and neither is a string that merely has braces.
  assert.equal(isReference("{a} * 2"), false);
  assert.equal(isReference("Font {Bold}"), false);
  assert.equal(isReference("#c33a2e"), false);
  assert.equal(referenceTarget(16), null);
});

test("references are collected from composite sub-values", () => {
  const shadow = token([
    { color: "{folio.ref.black}", blur: { unit: "px", value: 2 } },
    { color: "#000000", blur: { unit: "px", value: 4 } },
  ]);
  assert.deepEqual(collectReferences(shadow), ["folio.ref.black"]);
});

test("boundVariables count as inbound references", () => {
  // A text style bound to a font-size Variable really does depend on it, and UX §7 names
  // boundVariables explicitly as something the delete check has to see.
  const text = token({ fontFamily: "Urbanist" }, {
    boundVariables: { fontSize: "{folio.typography.font-size.70}", fontFamily: "VariableID:9:9" },
  });
  assert.deepEqual(collectReferences(text), ["folio.typography.font-size.70"]);
});

test("a token that points at nothing collects nothing", () => {
  assert.deepEqual(collectReferences(token("#c33a2e")), []);
});

test("the inbound index groups referrers by target, case-insensitively", () => {
  const index = buildInboundIndex([
    { path: "folio.color.border", setId: "Theme/Light", token: token("{folio.ref.RED.50}") },
    { path: "folio.color.border", setId: "Theme/Dark", token: token("{folio.ref.red.50}") },
    { path: "folio.color.text", setId: "Theme/Light", token: token("{folio.ref.blue.50}") },
  ]);

  const referrers = inboundReferrers(index, "folio.ref.red.50");
  assert.equal(referrers.length, 2);
  assert.deepEqual(
    referrers.map((referrer) => referrer.setId),
    ["Theme/Light", "Theme/Dark"]
  );
  assert.equal(inboundReferrers(index, "folio.ref.green.50").length, 0);
});

test("references from inside the set being deleted don't block the delete", () => {
  // The whole reason a group delete is possible at all (§7): tokens inside the group reference
  // each other, and those references are not stranded by a delete that takes both ends.
  const index = buildInboundIndex([
    { path: "folio.group.inner", setId: "S", token: token("{folio.group.target}") },
    { path: "folio.outside", setId: "S", token: token("{folio.group.target}") },
  ]);

  const going = new Set(["folio.group.inner", "folio.group.target"]);
  const blocking = inboundReferrers(index, "folio.group.target", (referrer) => going.has(referrer.path));
  assert.deepEqual(blocking.map((referrer) => referrer.path), ["folio.outside"]);
});
