// Sub-key references on composite tokens — UX references-math-themes §14, issue #26.
//
// The ticket is a scope widening, not a new surface, and these tests are written to hold the four
// places the widening could go quietly wrong: which members take what, whether the cycle detector
// sees member edges, whether a cycled member blanks *itself* rather than its token, and whether an
// unresolvable member gets past the gates that exist to catch an unresolvable whole token.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { FlatToken } from "../src/tokens/view";
import type { GridValue, ShadowValue, Token, TypographyValue } from "../src/tokens/types";
import {
  hasNonLiteralMember,
  memberShape,
  memberSlots,
  memberValueAt,
  nonLiteralMembers,
  refuseSubKeyReference,
  withMemberValue,
} from "../src/tokens/members";
import { outgoingPaths } from "../src/tokens/graph";
import {
  buildFlatResolveContext,
  checkAuthoredValue,
  graphReport,
  resolveToken,
} from "../src/tokens/resolve";
import { setGridField, setShadowField, setTypographyField } from "../src/tokens/edit";
import { previewOf } from "../src/tokens/preview";
import { toFigmaValue } from "../src/tokens/toFigma";
import { localTreeBlocks } from "../src/git/pushGate";
import { flattenTheme } from "../src/export/flatten";
import { flat, styleToken, varToken } from "./helpers";

const px = (value: number) => ({ unit: "px" as const, value });

function typography(overrides: Partial<TypographyValue> = {}): Token {
  const value: TypographyValue = {
    fontFamily: "Urbanist",
    fontSize: px(20),
    fontWeight: 500,
    letterSpacing: px(0),
    lineHeight: px(24),
    ...overrides,
  };
  return styleToken("typography", value, { styleType: "TEXT", fontStyle: "Medium" });
}

function shadow(overrides: Partial<ShadowValue> = {}): Token {
  const value: ShadowValue = {
    blur: px(4),
    color: "#00000040",
    inset: false,
    offsetX: px(0),
    offsetY: px(4),
    spread: px(0),
    ...overrides,
  };
  return styleToken("shadow", value, { styleType: "EFFECT" });
}

function grid(overrides: Partial<GridValue> = {}): Token {
  const value: GridValue = {
    pattern: "columns",
    alignment: "STRETCH",
    count: 12,
    gutter: px(16),
    ...overrides,
  };
  return styleToken("grid", [value], { styleType: "GRID" });
}

function num(path: string, set: string, value: unknown): FlatToken {
  return flat(path, set, varToken("number", value));
}

// ---------------------------------------------------------------------------
// §14.2 — which members take what
// ---------------------------------------------------------------------------

test("every typography member is a slot, and an absent lineHeight is not", () => {
  // An absent `lineHeight` is Figma's AUTO (ADR-0003 §3). Inventing a slot for it would be the first
  // half of writing a default into a gap the import deliberately left.
  const withLine = memberSlots(typography()).map((slot) => slot.key);
  assert.deepEqual(withLine.sort(), [
    "fontFamily",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
  ]);
  const auto = typography();
  delete (auto.$value as TypographyValue).lineHeight;
  assert.equal(
    memberSlots(auto).some((slot) => slot.key === "lineHeight"),
    false
  );
});

test("numeric members take all three shapes, fontWeight and colour take two, pattern takes one", () => {
  const spec = (token: Token, key: string) =>
    memberSlots(token).filter((slot) => slot.key === key)[0];

  assert.equal(spec(typography(), "fontSize").accepts, "full");
  assert.equal(spec(typography(), "letterSpacing").accepts, "full");
  assert.equal(spec(typography(), "lineHeight").accepts, "full");
  // §14.2: arithmetic on "Semi Bold" has no meaning, and `600 * 1` is §6.5's no-op anyway.
  assert.equal(spec(typography(), "fontWeight").accepts, "reference");
  assert.equal(spec(typography(), "fontFamily").accepts, "reference");
  assert.equal(spec(shadow(), "color").accepts, "reference");
  assert.equal(spec(shadow(), "blur").accepts, "full");
  assert.equal(spec(shadow(), "inset").accepts, "literal");
  assert.equal(spec(grid(), "pattern").accepts, "literal");
  assert.equal(spec(grid(), "count").accepts, "full");
});

test("a member's type is its own, never the composite's", () => {
  // §14.9: "this token is a typography" is true and useless next to a `fontSize` field.
  const slots = memberSlots(typography());
  assert.equal(slots.filter((slot) => slot.key === "fontSize")[0].type, "number");
  assert.equal(slots.filter((slot) => slot.key === "fontFamily")[0].type, "string");
  assert.equal(slots.filter((slot) => slot.key === "fontWeight")[0].type, "number-or-string");
  assert.equal(memberSlots(shadow()).filter((slot) => slot.key === "color")[0].type, "color");
});

test("a shadow stack addresses each member by index, a single shadow does not", () => {
  const stack = styleToken("shadow", [
    (shadow().$value as ShadowValue),
    { ...(shadow().$value as ShadowValue), blur: px(8) },
  ]);
  const blurs = memberSlots(stack).filter((slot) => slot.key === "blur");
  assert.deepEqual(blurs.map((slot) => slot.keyPath), [[0, "blur"], [1, "blur"]]);
  assert.deepEqual(blurs.map((slot) => slot.label), ["blur (shadow 1)", "blur (shadow 2)"]);
  assert.deepEqual(memberSlots(shadow()).filter((slot) => slot.key === "blur")[0].keyPath, ["blur"]);
});

test("the parser classifies a member after the fact, exactly as it does a whole token", () => {
  // §14.1's load-bearing choice: no mode toggle and no second classifier.
  assert.equal(memberShape("full", "{a.b}"), "reference");
  assert.equal(memberShape("full", "{a.b} * 1.5"), "expression");
  assert.equal(memberShape("full", "16"), "literal");
  assert.equal(memberShape("full", px(16)), "literal");
  // A member that takes no arithmetic never has any: "Semi Bold" is a literal however it lexes.
  assert.equal(memberShape("reference", "Semi Bold"), "literal");
  assert.equal(memberShape("reference", "{a.b}"), "reference");
  assert.equal(memberShape("reference", "{a.b} * 2"), "literal");
});

// ---------------------------------------------------------------------------
// §14.2 — the two refusals that stay
// ---------------------------------------------------------------------------

test("pattern and inset refuse a reference by name, and say why", () => {
  const pattern = refuseSubKeyReference("pattern", "literal", "{a.b}");
  assert.equal(typeof pattern, "string");
  assert.match(pattern as string, /which fields this grid has/);
  assert.match(refuseSubKeyReference("inset", "literal", "{a.b}") as string, /drop\/inset switch/);
  // Refused only for a pointer — a literal is the whole point of these fields.
  assert.equal(refuseSubKeyReference("pattern", "literal", "columns"), null);
  // And never for a member that takes one.
  assert.equal(refuseSubKeyReference("fontSize", "full", "{a.b}"), null);
});

test("the editor refuses a pointer in pattern, inset and alignment, and keeps one everywhere else", () => {
  const gridValue = grid().$value as GridValue[];
  const refused = setGridField(gridValue[0], "alignment", "{a.b}");
  assert.equal(refused.ok, false);

  const insetRefused = setShadowField(shadow().$value as ShadowValue, "inset", "{a.b}");
  assert.equal(insetRefused.ok, false);

  // Stored verbatim: the string is the value (ADR-0007 §2), one level down.
  const sized = setTypographyField(typography().$value as TypographyValue, "fontSize", "{brand.size.l}");
  assert.equal(sized.ok, true);
  assert.equal(sized.ok && sized.value.fontSize, "{brand.size.l}");

  const computed = setTypographyField(
    typography().$value as TypographyValue,
    "lineHeight",
    "{brand.size.l} * 1.5"
  );
  assert.equal(computed.ok && computed.value.lineHeight, "{brand.size.l} * 1.5");

  const counted = setGridField(gridValue[0], "count", "{layout.columns}");
  assert.equal(counted.ok && counted.value.count, "{layout.columns}");

  const painted = setShadowField(shadow().$value as ShadowValue, "color", "{palette.black}");
  assert.equal(painted.ok && painted.value.color, "{palette.black}");
});

test("writing a member copies rather than mutates", () => {
  const value = typography().$value as TypographyValue;
  const next = withMemberValue(value, ["fontSize"], px(32)) as TypographyValue;
  assert.deepEqual(value.fontSize, px(20));
  assert.deepEqual(next.fontSize, px(32));
  assert.equal(memberValueAt(next, ["fontSize", "value"]), 32);
});

// ---------------------------------------------------------------------------
// §14.9 — the cycle detector's edge set widens to member edges
// ---------------------------------------------------------------------------

test("a member reference is a graph edge", () => {
  const token = typography({ fontSize: "{brand.size.l}" });
  assert.deepEqual(outgoingPaths(token), ["brand.size.l"]);
});

test("a member expression contributes every operand, the same widening as a whole token's", () => {
  const token = typography({ lineHeight: "({a} + {b}) * 2" });
  assert.deepEqual(outgoingPaths(token).sort(), ["a", "b"]);
});

test("a loop closed through a member is a loop", () => {
  // Issue #26's second acceptance criterion: a missed edge escapes into CI.
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography({ fontSize: "{space.a}" })),
    num("space.a", "S", "{type.heading}"),
  ];
  const context = buildFlatResolveContext(tokens);
  assert.equal(context.cycles.cycles.length, 1);
});

// ---------------------------------------------------------------------------
// §14.6 — a cycle blanks one member, never the token
// ---------------------------------------------------------------------------

test("a member on a loop has no value and the other four members still do", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography({ fontSize: "{space.a}" })),
    num("space.a", "S", "{type.heading}"),
  ];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));

  assert.equal(resolved.kind, "composite");
  const member = (resolved.members ?? [])[0];
  assert.equal(member.slot.key, "fontSize");
  assert.equal(member.resolution.kind, "cycle");
  // The rule this whole apparatus exists for: no zero, no last good number, no value at all.
  assert.equal(member.resolution.value, undefined);
  assert.equal(member.resolution.cycle !== undefined, true);

  // Four members are fine and stay fine.
  const value = resolved.value as TypographyValue;
  assert.equal(value.fontFamily, "Urbanist");
  assert.equal(value.fontWeight, 500);
  assert.deepEqual(value.lineHeight, px(24));
});

test("the preview renders the cycled slot as an em dash and never collapses it", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography({ fontSize: "{space.a}" })),
    num("space.a", "S", "{type.heading}"),
  ];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  const preview = previewOf(tokens[0].token, resolved.value);
  // `Urbanist —/24 · 500`, never `Urbanist 24 · 500`, which is what dropping the slot would read as.
  assert.equal(preview.text, "Urbanist —/24 · 500");
  assert.equal(preview.memberPointer, true);
});

test("a member reference that resolves shows the resolved summary, with the pointer mark", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography({ fontSize: "{brand.size.l}" })),
    num("brand.size.l", "S", 28),
  ];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal(resolved.kind, "composite");
  assert.equal((resolved.members ?? [])[0].resolution.kind, "reference");
  assert.equal(previewOf(tokens[0].token, resolved.value).text, "Urbanist 28/24 · 500");
  assert.equal(hasNonLiteralMember(tokens[0].token), true);
});

test("a member expression evaluates against the theme, and the string stays the value", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography({ lineHeight: "{brand.size.l} * 1.5" })),
    num("brand.size.l", "S", 20),
  ];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal((resolved.members ?? [])[0].resolution.value, 30);
  assert.equal(
    (tokens[0].token.$value as TypographyValue).lineHeight,
    "{brand.size.l} * 1.5"
  );
});

test("a member pointing outside the active theme warns rather than breaking the token", () => {
  const tokens: FlatToken[] = [flat("type.heading", "S", typography({ fontSize: "{missing.size}" }))];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  const member = (resolved.members ?? [])[0];
  assert.equal(member.resolution.kind, "unresolved");
  assert.equal(member.resolution.value, undefined);
  assert.equal(previewOf(tokens[0].token, resolved.value).text, "Urbanist —/24 · 500");
});

test("the build report names the member rather than the token", () => {
  const tokens: FlatToken[] = [flat("type.heading", "S", typography({ fontSize: "{missing.size}" }))];
  const entries = graphReport(tokens, buildFlatResolveContext(tokens));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "unresolved-in-theme");
  assert.match(entries[0].message, /`fontSize`/);
});

// ---------------------------------------------------------------------------
// §14.4 — the four rules, per member
// ---------------------------------------------------------------------------

const FONT_SIZE = { key: "fontSize", type: "number" as const, accepts: "full" as const };

function author(raw: string, tokens: FlatToken[], member = FONT_SIZE) {
  return checkAuthoredValue({
    entry: tokens[0],
    raw,
    context: buildFlatResolveContext(tokens),
    member,
  });
}

test("rule 1 — a member pointing at nothing is refused, and §14.3 makes a sub-key path nothing", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography()),
    num("brand.size.l", "S", 28),
  ];
  const unknown = author("{nope.at.all}", tokens);
  assert.equal(unknown.ok, false);

  // §14.3's hard boundary: a reference points AT a token, never INTO one. There is genuinely no
  // token at `type.heading.fontSize`, so rule 1's copy is the right refusal.
  const intoAComposite = author("{type.heading.fontSize}", tokens);
  assert.equal(intoAComposite.ok, false);
  assert.match(
    intoAComposite.ok === false ? intoAComposite.message : "",
    /Nothing in any set has that path/
  );
});

test("rule 2 reads the member's type and names the member", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography()),
    flat("color.accent", "S", varToken("color", "#c33a2e")),
  ];
  const outcome = author("{color.accent}", tokens);
  assert.equal(outcome.ok, false);
  // §14.4 verbatim: "`folio.color.accent` is a color. `fontSize` takes a number, so it can't point there."
  assert.equal(
    outcome.ok === false ? outcome.message : "",
    "color.accent is a color. `fontSize` takes a number, so it can't point there."
  );
});

test("fontWeight takes a number or a string, and no arithmetic", () => {
  const weight = { key: "fontWeight", type: "number-or-string" as const, accepts: "reference" as const };
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography()),
    flat("brand.weight", "S", varToken("string", "Semi Bold")),
  ];
  assert.equal(author("{brand.weight}", tokens, weight).ok, true);

  const arithmetic = author("{brand.weight} * 1", tokens, weight);
  assert.equal(arithmetic.ok, false);
  assert.match(arithmetic.ok === false ? arithmetic.message : "", /`fontWeight` can't hold one/);
});

test("rule 3 — a member edge that would close a loop is refused before anything evaluates", () => {
  const tokens: FlatToken[] = [
    flat("type.heading", "S", typography()),
    num("space.a", "S", "{type.heading}"),
  ];
  const outcome = author("{space.a}", tokens);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.reason : "", "reference-cycle");
  assert.equal(outcome.ok === false && outcome.cycle !== undefined, true);
});

test("a literal-only member refuses at the rules too, not only at the parser", () => {
  const tokens: FlatToken[] = [flat("g", "S", grid()), num("a", "S", 4)];
  const outcome = author("{a}", tokens, {
    key: "pattern",
    type: "string",
    accepts: "literal",
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.message : "", /which fields this grid has/);
});

// ---------------------------------------------------------------------------
// §14.6 — apply refuses explicitly, and the blocked row is the composite
// ---------------------------------------------------------------------------

test("apply refuses a member reference by name rather than writing a flattened number", () => {
  // A Figma Style has no per-field pointer (ADR-0005 §12 defers bindings), and writing the resolved
  // number would be the silent flattening UX §5.6 rules out — plus permanent phantom drift.
  const write = toFigmaValue(typography({ fontSize: "{brand.size.l}" }));
  assert.equal(write.ok, false);
  assert.equal(write.ok === false ? write.reason : "", "member-reference-unwritable");
  assert.match(write.ok === false ? write.message : "", /`fontSize` points at brand.size.l/);
});

test("apply refuses a member expression too, and names it as a formula", () => {
  const write = toFigmaValue(typography({ lineHeight: "{a} * 2" }));
  assert.equal(write.ok, false);
  assert.equal(write.ok === false ? write.reason : "", "member-expression-unwritable");
});

test("a member on a loop refuses with §14.6's reason line", () => {
  const write = toFigmaValue(typography({ fontSize: "{space.a}" }), {
    memberOnCycle: () => true,
  });
  assert.equal(write.ok, false);
  assert.equal(
    write.ok === false ? write.message : "",
    "`fontSize` is on a loop, so this style can't be written."
  );
});

test("a composite with only literal members still writes", () => {
  const write = toFigmaValue(typography());
  assert.equal(write.ok, true);
  assert.equal(write.ok === true ? write.write.kind : "", "text-style");
});

// ---------------------------------------------------------------------------
// The push gate — ADR-0002 Amendment 3
// ---------------------------------------------------------------------------

test("an unresolvable member reference blocks the push, exactly as a whole-token one does", () => {
  const blocks = localTreeBlocks([flat("type.heading", "S", typography({ fontSize: "{gone}" }))]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "unresolved-reference");
  assert.equal(blocks[0].target, "gone");
});

test("an unresolvable member expression operand blocks the push", () => {
  const blocks = localTreeBlocks([flat("type.heading", "S", typography({ lineHeight: "{gone} * 2" }))]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].target, "gone");
});

test("a loop through a member blocks the push", () => {
  const blocks = localTreeBlocks([
    flat("type.heading", "S", typography({ fontSize: "{space.a}" })),
    num("space.a", "S", "{type.heading}"),
  ]);
  assert.equal(
    blocks.some((block) => block.kind === "reference-cycle"),
    true
  );
});

test("a resolvable member reference does not block the push", () => {
  const blocks = localTreeBlocks([
    flat("type.heading", "S", typography({ fontSize: "{brand.size.l}" })),
    num("brand.size.l", "S", 28),
  ]);
  assert.deepEqual(blocks, []);
});

// ---------------------------------------------------------------------------
// The export — Phase 8's "one failure fails the whole build"
// ---------------------------------------------------------------------------

const THEME = { name: "Base", selectedTokenSets: ["S"] };

test("a member expression is flattened for Style Dictionary and a member reference is not", () => {
  const result = flattenTheme(
    [
      flat("type.heading", "S", typography({ fontSize: "{brand.size.l}", lineHeight: "{brand.size.l} * 1.5" })),
      num("brand.size.l", "S", 20),
    ],
    THEME
  );
  assert.deepEqual(result.diagnostics, []);
  const emitted = result.tokens.filter((token) => token.path === "type.heading")[0];
  const value = emitted.token.$value as TypographyValue;
  // Style Dictionary resolves `{…}` itself; it has no idea what `{a} * 1.5` means, so that one is
  // evaluated here by the same evaluator the apply path uses.
  assert.equal(value.fontSize, "{brand.size.l}");
  assert.equal(value.lineHeight, 30);
});

test("an unresolvable member fails the build and emits nothing for that token", () => {
  const result = flattenTheme([flat("type.heading", "S", typography({ fontSize: "{gone}" }))], THEME);
  assert.equal(result.tokens.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].kind, "dangling-reference");
  assert.match(result.diagnostics[0].message, /`fontSize`/);
});

test("a loop through a member fails the build", () => {
  const result = flattenTheme(
    [
      flat("type.heading", "S", typography({ fontSize: "{space.a}" })),
      num("space.a", "S", "{type.heading}"),
    ],
    THEME
  );
  assert.equal(
    result.diagnostics.some((one) => one.kind === "reference-cycle"),
    true
  );
  assert.equal(
    result.tokens.some((one) => one.path === "type.heading"),
    false
  );
});

test("a member expression that can't be worked out fails the build rather than emitting a string", () => {
  const result = flattenTheme(
    [
      flat("type.heading", "S", typography({ lineHeight: "{brand.size.l} / 0" })),
      num("brand.size.l", "S", 20),
    ],
    THEME
  );
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].kind, "expression-error");
  assert.equal(result.tokens.length, 1); // `brand.size.l` still exports; the typography does not.
});

test("a composite with no pointers is untouched by any of this", () => {
  const tokens = [flat("type.heading", "S", typography())];
  const resolved = resolveToken(tokens[0], buildFlatResolveContext(tokens));
  assert.equal(resolved.kind, "literal");
  assert.deepEqual(nonLiteralMembers(tokens[0].token), []);
  assert.deepEqual(flattenTheme(tokens, THEME).diagnostics, []);
  assert.equal(previewOf(tokens[0].token).memberPointer, undefined);
});
