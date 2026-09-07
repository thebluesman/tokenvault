// The token card — UX `docs/ux/edit-view-redesign.md`, issue #38.
//
// Two halves, split the way `panelWindow.test.ts` splits its own subject. The decisions the card makes
// about itself — what a field is called, whether two members share a line, whether the Figma
// disclosure opens itself, what a Figma scope enum reads as in English — are real logic and are
// tested as logic. The rest of the doc is a set of *structural* promises about two files (the label
// gutter is gone, the value shell is one class, the footer holds no Save, the stale Phase 6 sentence
// is retired), and those are pinned by source inspection because the panel has no DOM in CI.
//
// What this cannot check is §11's checklist, which needs a running panel at 400px and at 640: that a
// `#000000` chip is visible inside the shell, that the `guessed` badge wraps rather than overflows,
// that nothing scrolls sideways.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  autoExpandFigma,
  collapsedLayers,
  figmaSummary,
  hasFigmaSection,
  humanizeScope,
  memberLabel,
  pairMembers,
  scopesLine,
  valueLabel,
} from "../src/ui/card";

const ROOT = process.cwd();
const detailTs = readFileSync(join(ROOT, "src/ui/detail.ts"), "utf8");
const html = readFileSync(join(ROOT, "src/ui/index.html"), "utf8");
const cardTs = readFileSync(join(ROOT, "src/ui/card.ts"), "utf8");

/** Comments stripped, so a rule *about* a lookup table is not mistaken for one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const cardCode = code(cardTs);

// ---------------------------------------------------------------------------
// §4.2, §5.5, §8 — labels
// ---------------------------------------------------------------------------

test("a scalar's value label is its $type, sentence case", () => {
  // §4.2 — and `Hex` is gone: the hex expectation moved to the refusal copy on a bad commit, which
  // fires at the moment the user is looking at the problem.
  assert.equal(valueLabel("color"), "Color");
  assert.equal(valueLabel("number"), "Number");
  assert.equal(valueLabel("boolean"), "Boolean");
  assert.equal(valueLabel("string"), "String");
});

test("composite member labels are human, per §8's table", () => {
  assert.equal(memberLabel("fontFamily"), "Font family");
  assert.equal(memberLabel("fontSize"), "Font size");
  assert.equal(memberLabel("letterSpacing"), "Letter spacing");
  assert.equal(memberLabel("lineHeight"), "Line height");
  assert.equal(memberLabel("offsetX"), "Offset X");
  assert.equal(memberLabel("offsetY"), "Offset Y");
  assert.equal(memberLabel("sectionSize"), "Section size");
  // The schema calls it `gutter`; the label is `Gutter size`, which is what Figma's own UI says.
  assert.equal(memberLabel("gutter"), "Gutter size");
});

test("an unknown member key still reads as English rather than as a schema key", () => {
  // A schema addition must not render `letterCase` verbatim on the day it lands, and adding a row to
  // the map must not be the thing that makes a field legible.
  assert.equal(memberLabel("letterCase"), "Letter case");
  assert.equal(memberLabel("paragraphIndent"), "Paragraph indent");
});

test("the label map is display-only — no error copy is routed through it", () => {
  // §5.5, §12's fourth build note. UI labels are human; copy *about the JSON* keeps the schema key in
  // mono. Rule 2's refusal is still "`fontSize` takes a number, so it can't point there", §14.7's
  // disagreement line still names `fontSize`, and the `boundVariables` rows still read `fontSize → …`.
  // If `memberLabel` ever appeared in `members.ts` or `valueField.ts`, the two would have merged.
  for (const name of ["../src/tokens/members.ts", "../src/ui/valueField.ts"]) {
    const text = readFileSync(join(ROOT, "src", name.replace("../src/", "")), "utf8");
    assert.equal(
      text.indexOf("memberLabel") === -1,
      true,
      `${name} routes copy through the label map — the key in the copy would stop matching the file`
    );
  }
  // The disagreement line still spells the slot's own key in backticks, not its label.
  assert.equal(detailTs.indexOf("Figma binds \\`${slot.label}\\`") !== -1, true);
});

// ---------------------------------------------------------------------------
// §6.3 — scopes
// ---------------------------------------------------------------------------

test("scopes humanise by transform, so an unknown enum still renders", () => {
  assert.equal(humanizeScope("ALL_FILLS"), "All fills");
  assert.equal(humanizeScope("STROKE_COLOR"), "Stroke color");
  assert.equal(humanizeScope("TEXT_CONTENT"), "Text content");
  // The point of a transform over a table: a scope Figma adds next year is legible without a release.
  assert.equal(humanizeScope("SOME_FUTURE_SCOPE_NAME"), "Some future scope name");
  assert.equal(humanizeScope("SHAPE_FILL"), "Shape fill");
});

test("the humanising is a transform, not a lookup", () => {
  // §12's sixth build note, pinned structurally: a map of enum → label would go stale, and the whole
  // reason the transform was chosen is that it cannot.
  assert.equal(/ALL_FILLS/.test(cardCode), false, "card.ts carries a scope lookup table");
});

test("no scopes means no line at all — never `None`, never a dash", () => {
  // §6.3, §8. Same precedent as `panel-size-and-swatches.md` §5.2's empty strip: absence already
  // means absence, and a placeholder on most of the tree is ink that never says anything.
  assert.equal(scopesLine(undefined), null);
  assert.equal(scopesLine([]), null);
  assert.equal(scopesLine(["  "]), null);
  assert.equal(scopesLine(["ALL_FILLS", "STROKE_COLOR"]), "All fills, Stroke color");
});

// ---------------------------------------------------------------------------
// §6.1, §6.2 — the Figma disclosure
// ---------------------------------------------------------------------------

test("the Source line is the disclosure's summary, so collapsing never hides provenance", () => {
  // §6.1. `local-editor.md` §5.2's rule is *provenance is always shown*; promoting the one line that
  // matters keeps that true while the ids, the scopes and the bindings fold away.
  assert.equal(figmaSummary({ variableId: "VariableID:1:24" }, "Theme / Light"), "Variable · Theme / Light");
  assert.equal(figmaSummary({ styleId: "S:abc", styleType: "TEXT" }, "Styles"), "Style · TEXT");
  assert.equal(figmaSummary({ styleId: "S:abc" }, "Styles"), "Style · ?");
  assert.equal(figmaSummary({}, "Theme / Light"), null);
});

test("a token with no provenance renders no Figma section at all", () => {
  // §8's last empty state — nothing in this card renders an empty container.
  assert.equal(hasFigmaSection({}), false);
  assert.equal(hasFigmaSection({ boundVariables: {}, text: {} }), false);
  assert.equal(hasFigmaSection({ variableId: "VariableID:1:24" }), true);
  assert.equal(hasFigmaSection({ styleId: "S:abc" }), true);
  // A pulled token with no Figma id can still carry bindings worth showing.
  assert.equal(hasFigmaSection({ boundVariables: { fontSize: "{a.b}" } }), true);
  assert.equal(hasFigmaSection({ text: { textCase: "UPPER" } }), true);
});

test("the disclosure opens itself exactly when it explains the fields above it", () => {
  // §6.2 — collapsed by default, because this is read-only reference material and the editable fields
  // are the point. Two exceptions, both of them `local-editor.md` §5.2's own reasoning: a populated
  // `boundVariables` is *why* a text style's numbers look already-aliased, and hiding the reason makes
  // the value editor look broken; and §14.7's line exists only to explain which value applies.
  assert.equal(autoExpandFigma({ bound: false, disagreement: false }), false);
  assert.equal(autoExpandFigma({ bound: true, disagreement: false }), true);
  assert.equal(autoExpandFigma({ bound: false, disagreement: true }), true);
});

test("eleven Figma text extras are not a reason to open — they explain nothing", () => {
  // The one thing §6.2 is *not*: "expanded when there is a lot in it". A token with eleven `text`
  // extras and no bindings says nothing about its own value, and opening on it is the
  // always-expanded default the reference ships and §6.2 rejects.
  assert.equal(autoExpandFigma({ bound: false, disagreement: false }), false);
  assert.equal(
    /text/.test(cardCode.slice(cardCode.indexOf("export function autoExpandFigma"))),
    false,
    "autoExpandFigma reads the `text` extras — §6.2 says they explain nothing"
  );
});

test("the disclosure's open state is in memory and cleared on close", () => {
  // §12's seventh build note. Not `clientStorage`: the store is quota-constrained (ADR-0004 §1) and
  // which accordion you last poked is a per-glance preference, not user data.
  assert.equal(/const figmaOpen = new Map<string, boolean>\(\)/.test(detailTs), true);
  const close = detailTs.slice(
    detailTs.indexOf("export function closeDetail"),
    detailTs.indexOf("export function isDetailOpen")
  );
  assert.equal(close.indexOf("figmaOpen.clear()") !== -1, true, "closeDetail leaks the open state");
  assert.equal(close.indexOf("layerOpen.clear()") !== -1, true, "closeDetail leaks the layer state");
  assert.equal(
    /clientStorage|set-settings/.test(detailTs.slice(detailTs.indexOf("const figmaOpen"), detailTs.indexOf("export function setNavigator"))),
    false,
    "the disclosure state reached clientStorage"
  );
});

// ---------------------------------------------------------------------------
// §5.6 — pairing and layer collapsing
// ---------------------------------------------------------------------------

test("numeric members pair two-up", () => {
  assert.deepEqual(
    pairMembers(["offsetX", "offsetY", "blur", "spread"], () => false),
    [
      ["offsetX", "offsetY"],
      ["blur", "spread"],
    ]
  );
});

test("a pair unpairs the moment either member holds a non-literal value", () => {
  // §5.6's one condition, and it is the whole reason the rule is static everywhere else: a dotted path
  // needs the full width, and ~190px at the 400px floor is ample for a number and useless for a path.
  assert.deepEqual(
    pairMembers(["offsetX", "offsetY", "blur", "spread"], (key) => key === "offsetX"),
    [["offsetX"], ["offsetY"], ["blur", "spread"]]
  );
  assert.deepEqual(
    pairMembers(["offsetX", "offsetY", "blur", "spread"], (key) => key === "spread"),
    [["offsetX", "offsetY"], ["blur"], ["spread"]]
  );
});

test("an odd trailing member stands alone rather than half-pairing", () => {
  assert.deepEqual(pairMembers(["count", "gutter", "offset"], () => false), [
    ["count", "gutter"],
    ["offset"],
  ]);
  assert.deepEqual(pairMembers([], () => false), []);
  assert.deepEqual(pairMembers(["sectionSize"], () => false), [["sectionSize"]]);
});

test("shadow layers collapse only past two", () => {
  // §5.6 — one or two layers is a shadow you read as a whole, so nothing folds. Three or more and
  // layer 1 stays expanded while the rest go, which is where the height actually is.
  assert.deepEqual(collapsedLayers(1), []);
  assert.deepEqual(collapsedLayers(2), []);
  assert.deepEqual(collapsedLayers(3), [1, 2]);
  assert.deepEqual(collapsedLayers(5), [1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// §4.1, §4.3, §7.2 — structural promises about the two files
// ---------------------------------------------------------------------------

test("the 84px label gutter and the 90px note margins moved together", () => {
  // §12's fifth build note: those three numbers are one decision (§4.1), and moving one without the
  // others leaves notes hanging off nothing. `.field > label`'s width survives for `#settings`, which
  // keeps its label-beside-control rows; inside `#panel` it is overridden to `auto`.
  assert.equal(/#panel \.field > label \{[^}]*width: auto/.test(html), true);
  assert.equal(/\.field-note \{\s*margin: -3px 0 6px;/.test(html), true);
  assert.equal(/\.resolve-line \{[^}]*margin: -3px 0 6px;/.test(html), true);
  assert.equal(/margin: -3px 0 6px 90px/.test(html), false, "a 90px note gutter survived");
});

test("the value shell is one new class, and the input inside it loses its own border", () => {
  // §12's second build note: "if the build ends up adding a second new class per type, the design was
  // misread." The shell is the border; the input is transparent inside it, which is also why the amber
  // refusal has to move to the shell — the input has no border left to colour.
  assert.equal(/\.value-shell \{/.test(html), true);
  assert.equal(/\.value-shell > input\[type="text"\] \{[^}]*border: 0;/.test(html), true);
  assert.equal(/\.value-shell\.invalid \{[^}]*border-color: var\(--warn\)/.test(html), true);
  assert.equal(
    /shell\.classList\.add\("invalid"\)/.test(detailTs),
    true,
    "the refusal still only reddens the borderless input, so it is invisible"
  );
});

test("the shell's swatch is swatchMark + swatchNode, not a third treatment", () => {
  // §4.3, §12's third build note. The same call the tree row makes, under the same resolution. A third
  // swatch treatment would be a third vocabulary in a panel whose argument is that it has one of
  // everything — and `panel-size-and-swatches.md` §5.4 exists to prevent exactly that disagreement.
  assert.equal(/swatchNode\(swatchMark\(line\.entry\.token, resolutionFor\(line\)\)\)/.test(detailTs), true);
  assert.equal(
    detailTs.indexOf('"swatch-fill"'),
    -1,
    "the card hand-rolls a swatch fill instead of asking swatchNode()"
  );
  // The native input stays the hidden mechanism behind the chip rather than being dressed up as one.
  assert.equal(/class = "hidden-picker"|"hidden-picker"/.test(detailTs), true);
  assert.equal(/showPicker/.test(detailTs), true);
});

test("there is no value-type chevron anywhere on the field", () => {
  // §4.3's last bullet. The reference screenshot's trailing chevron is its value-type dropdown, which
  // is precisely the mode toggle `references-math-themes.md` §4.1 refused — one value field takes a
  // literal, a reference or an expression, and nothing announces which. Reintroducing it here would
  // bring back the phase's single load-bearing rejection as decoration.
  const shellRule = html.slice(html.indexOf(".value-shell {"), html.indexOf(".field-pair {"));
  assert.equal(/chevron|▾|▿/.test(shellRule), false);
});

test("the footer holds Done and the write verb, and no Save or Cancel", () => {
  // §7.2 — every field commits to the overlay on blur (ADR-0004 §2), so Save would mean inventing a
  // draft buffer, and a card that can be abandoned unsaved makes `local-editor.md` §5.4's "local
  // edits" promise conditional. `←` has been the exit since Phase 4.
  const footer = detailTs.slice(
    detailTs.indexOf("function renderFooter"),
    detailTs.indexOf("function renderCard")
  );
  assert.equal(footer.indexOf('button("Done"') !== -1, true);
  assert.equal(/Apply all \$\{row\.lines\.length\} sets/.test(footer), true);
  assert.equal(/button\("Save"|button\("Cancel"/.test(detailTs), false);
  // Reuses the class `#repo` and `#settings` already pin their write verb with (git-sync.md §7.2).
  assert.equal(footer.indexOf('el("div", "panel-foot")') !== -1, true);
  assert.equal(/#panel \.panel-foot \{/.test(html), true);
});

test("destructive path actions stay in the body, never beside Done", () => {
  // §7.2 — `Delete from all N sets` and `Delete in Figma…` are not footer material.
  const footer = detailTs.slice(
    detailTs.indexOf("function renderFooter"),
    detailTs.indexOf("function renderCard")
  );
  assert.equal(/Delete/.test(footer), false);
  const pathActions = detailTs.slice(
    detailTs.indexOf("function renderPathActions"),
    detailTs.indexOf("export function applyLines")
  );
  assert.equal(/Delete from all/.test(pathActions), true);
  // And the path-level Apply left the bottom of the scroll for the pinned footer.
  assert.equal(/button\(`Apply all/.test(pathActions), false);
});

test("the footer note replaces Phase 4's stale git-sync paragraph", () => {
  // §1's last row and §7.2. Phase 6 landed 2026-09-03; the sentence promising it was still on screen.
  assert.equal(
    /nothing is committed anywhere until git sync/.test(detailTs),
    false,
    "the stale Phase 6 sentence is still shipping"
  );
  assert.equal(detailTs.indexOf("Edits are local until you Apply.") !== -1, true);
});

test("flag messages render under the value, not after the actions toolbar", () => {
  // §4.6. *"Points at folio.ref.palette.red-warm.50, which isn't in any set"* is a sentence about the
  // field above it, and it used to sit at the very bottom of the section, past the buttons.
  const card = detailTs.slice(detailTs.indexOf("function renderCard"), detailTs.indexOf("/** UX §5.5's conflict block"));
  const editorAt = card.indexOf("section.appendChild(typedEditor(line));");
  const flagsAt = card.indexOf("for (const flag of line.flags) section.appendChild");
  const actionsAt = card.indexOf('const actions = el("div", "toolbar")');
  assert.equal(editorAt !== -1 && flagsAt !== -1 && actionsAt !== -1, true);
  assert.equal(editorAt < flagsAt, true, "the flag message no longer follows the value it describes");
  assert.equal(flagsAt < actionsAt, true, "the flag message is back below the actions toolbar");
});

test("the state blocks keep their precedence, all of them above the value field", () => {
  // §4.6 — cycle first (the loop is the thing in the error state, not this token), then conflict, then
  // drift, then the in-sync line, then `editBlockedReason`. None of that ordering changed.
  const card = detailTs.slice(detailTs.indexOf("function renderCard"), detailTs.indexOf("/** UX §5.5's conflict block"));
  const order = ["cycleBlock(cycle", "renderConflict(line)", "renderDrift(line)", "renderInSync()", "editBlockedReason(line)", "typedEditor(line)"];
  let at = -1;
  for (const marker of order) {
    const found = card.indexOf(marker);
    assert.equal(found > at, true, `${marker} is out of §4.6's order`);
    at = found;
  }
});

test("a single-set path skips .set-section entirely rather than suppressing its border", () => {
  // §12's fifth-from-last build note, and the badges it drops have to reappear in the head's meta line
  // or they are lost. The `$type` badge is deliberately *not* among them: on a single-set card the
  // value field's own label carries the type (§4.2).
  assert.equal(/const single = row\.lines\.length === 1/.test(detailTs), true);
  assert.equal(/el\("div", bare \? "card" : "set-section"\)/.test(detailTs), true);
  const meta = detailTs.slice(detailTs.indexOf('el("div", "head-meta")'), detailTs.indexOf("head.appendChild(headMain)"));
  assert.equal(meta.indexOf('"edited"') !== -1, true, "the edited badge was lost with the h3");
  assert.equal(meta.indexOf("flag.kind") !== -1, true, "the flag badges were lost with the h3");
  assert.equal(meta.indexOf("$type") === -1, true, "the $type badge came back — the value label says it");
});

test("there is no Name field, and the title bar is still the identity", () => {
  // §10.1, Shyam's call: display-only. ADR-0004 defines `set-value` / `set-description` / `delete` and
  // no rename op, so an input here would refuse everything typed into it — worse than no input.
  assert.equal(/"Copy path"/.test(detailTs), true);
  assert.equal(/label: "Name"|"Rename"|set-name/.test(detailTs), false);
});

test("description is a textarea that keeps its newlines", () => {
  // §7.1 — two rows, `Optional description` rather than `none` (which read like a value), and Enter
  // inserts a newline because in a textarea it must. A variant of `committingInput`, not a fork (§12).
  assert.equal(/multiline: true/.test(detailTs), true);
  assert.equal(detailTs.indexOf('"Optional description"') !== -1, true);
  assert.equal(/placeholder = "none"/.test(detailTs), false);
  assert.equal(/options\.multiline === true && !event\.metaKey && !event\.ctrlKey/.test(detailTs), true);
  assert.equal(/textarea\.desc-input/.test(html), true);
});

test("the subtype is a trailing control in the value shell, not a row of its own", () => {
  // §5's matrix puts subtype directly under the value because it changes how the number is read, and
  // §4.4 puts it inside the shell at a fixed 84px.
  assert.equal(/trailing: \(\) => subtypeControl\(line\)/.test(detailTs), true);
  assert.equal(/fieldRow\("Subtype"/.test(detailTs), false, "the subtype is still its own row");
  assert.equal(/\.value-shell \.subtype[^{]*\{[^}]*width: 84px/.test(html), true);
});

test("the boolean card spends one label on two mechanisms", () => {
  // §5.3 — a two-state value does not deserve six sections. One `Boolean` label over the segmented
  // pair; the pointer shell below loses its own `Points at` label and gains a muted hint instead.
  const boolEditor = detailTs.slice(
    detailTs.indexOf("function booleanEditor"),
    detailTs.indexOf("function stringEditor")
  );
  assert.equal(boolEditor.indexOf('label: null') !== -1, true);
  assert.equal(boolEditor.indexOf("or point at another boolean token") !== -1, true);
  assert.equal(boolEditor.indexOf('"Points at"') === -1, true);
  // The reference readout still sits in front of the pair as a non-selectable third position.
  assert.equal(boolEditor.indexOf('"ref-chip"') !== -1, true);
});

test("the composite pointer footer is focus-scoped through one shared container", () => {
  // §4.5, §12's last-but-one build note. A typography token with three referenced members would
  // otherwise carry six buttons; and one container moved to the focused field beats one hidden
  // container per member, because a node can only be in one place.
  assert.equal(/const memberFooterHost = el\("div", "toolbar member-footer"\)/.test(detailTs), true);
  const attach = detailTs.slice(
    detailTs.indexOf("function attachMemberFooter"),
    detailTs.indexOf("function memberCycle")
  );
  assert.equal(/addEventListener\("focus"/.test(attach), true);
  assert.equal(/addEventListener\("blur"/.test(attach), true);
  // The cycle block is *not* focus-scoped: a loop is a state, not an affordance (§14.6).
  const cycle = detailTs.slice(detailTs.indexOf("function memberCycle"), detailTs.indexOf("function fieldRow"));
  assert.equal(/addEventListener\("focus"/.test(cycle), false);
});

test("nothing in the card calls Figma", () => {
  // §12's first build note. This is layout over fields that already ship — no canvas reads, no canvas
  // writes, no change to what `scan.ts` collects.
  // Matched against the plugin API's own surface rather than the word `figma`, which is also the name
  // of the provenance object every card reads.
  const api = /figma\.(variables|getLocal|currentPage|root|clientStorage|ui)/;
  assert.equal(api.test(code(detailTs)), false);
  assert.equal(api.test(cardCode), false);
});
