// Configurable path transform rules and the matcher they share with routing — ADR-0002
// Amendment 2 §A–§C, §I; ADR-0008 §5.
//
// **One matcher, two consumers.** ADR-0008 §Context is explicit that routing's exception rules
// reuse this matcher rather than growing their own, which is why the two features are one ticket.
// `matchesName` is therefore deliberately ignorant of what the caller intends to do with a match:
// Amendment 2 §A's *"the match text has no required relationship to what the action does"* is a
// property of this module, not a note about how it happens to be used today.
//
// Everything here is pure and knows nothing about Figma, storage or git. The whole engine is one
// function of (source name, rule set) — Amendment 2 §A's `pathRules(sourceName)` — which is what
// makes "editing a rule updates the previewed paths without a re-import" true by construction
// rather than by cache invalidation.

import { splitVariableName } from "./paths";

// ---------------------------------------------------------------------------
// The shared matcher — Amendment 2 §A
// ---------------------------------------------------------------------------

/**
 * `segment` is the common case and is **not** a regex, so a variable name carrying `.` or `(`
 * needs no escaping to be matched. `name` is the escape hatch: a regex over the whole
 * `/`-delimited name.
 */
export type RuleMatch =
  | { kind: "segment"; value: string; caseSensitive?: boolean }
  | { kind: "name"; pattern: string };

/** Segment matching defaults to case-insensitive; Figma names are not consistently cased. */
function segmentEquals(segment: string, value: string, caseSensitive: boolean | undefined): boolean {
  return caseSensitive === true ? segment === value : segment.toLowerCase() === value.toLowerCase();
}

/**
 * A compiled regex, or `null` when the pattern does not compile.
 *
 * `null` never silently means "matches nothing" at the engine's edge — `validateRules` reports the
 * rule so the user meets a named bad pattern rather than a rule that quietly stopped working.
 */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** Does this match select anything in `name`? The gate every action runs behind. */
export function matchesName(match: RuleMatch, name: string): boolean {
  if (match.kind === "segment") {
    return splitVariableName(name).some((segment) => segmentEquals(segment, match.value, match.caseSensitive));
  }
  const regex = compile(match.pattern);
  return regex !== null && regex.test(name);
}

/**
 * Which segments of `name` the match selects, as indices into `splitVariableName(name)`.
 *
 * For a `segment` match this is exactly the equal segments. For a `name` match the regex is a gate
 * over the whole name, so the selection is *the segments its matched substring covers* — the only
 * reading that is well-defined for a pattern that may span or split segments. A regex matching the
 * entire name therefore selects every segment, which is what `^…$` patterns visibly do.
 */
export function matchedSegments(match: RuleMatch, name: string): number[] {
  const segments = splitVariableName(name);

  if (match.kind === "segment") {
    const picked: number[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      if (segmentEquals(segments[i], match.value, match.caseSensitive)) picked.push(i);
    }
    return picked;
  }

  const regex = compile(match.pattern);
  if (regex === null) return [];

  // Offsets are computed against the *normalised* join, not the raw name: `splitVariableName`
  // trims and drops empties, so mapping raw offsets onto trimmed segments would be off by however
  // much whitespace the designer left in. Matching the normalised form keeps the two in step.
  const joined = segments.join("/");
  const global = new RegExp(regex.source, regex.flags.indexOf("g") === -1 ? regex.flags + "g" : regex.flags);

  const bounds: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const segment of segments) {
    bounds.push({ start: cursor, end: cursor + segment.length });
    cursor += segment.length + 1;
  }

  const picked = new Set<number>();
  let found: RegExpExecArray | null;
  while ((found = global.exec(joined)) !== null) {
    const start = found.index;
    const end = start + found[0].length;
    for (let i = 0; i < bounds.length; i += 1) {
      // A zero-length segment cannot overlap anything, and a zero-length match covers the
      // boundary it sits on rather than a segment — both fall out of strict overlap.
      if (bounds[i].start < end && start < bounds[i].end) picked.add(i);
    }
    // A zero-length match would otherwise spin forever.
    if (found[0].length === 0) global.lastIndex += 1;
  }

  return Array.from(picked).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Rules — Amendment 2 §B
// ---------------------------------------------------------------------------

export type PathRuleAction =
  /** Removes every segment the match selected, wherever it occurs. */
  | { kind: "drop-matched-segments" }
  /** Rewrites every matched segment to a literal (which may itself be `/`-delimited). */
  | { kind: "replace-segment"; with: string }
  /** Regex replace over the whole `/`-delimited name, `$1` capture groups. */
  | { kind: "rewrite"; pattern: string; replacement: string }
  /** The variable is not imported at all — §I. Terminal: later rules do not run. */
  | { kind: "exclude" };

export interface PathRule {
  id: string;
  enabled: boolean;
  match: RuleMatch;
  action: PathRuleAction;
  note?: string;
}

/**
 * What the pipeline did to one source name.
 *
 * `name` is populated in every case, including `excluded`, and that is load-bearing rather than
 * incidental: Amendment 2 §I keeps writing a reference to an excluded target, so something has to
 * say what path that reference names. It is the path the variable *would* have had — the pipeline
 * output at the moment the `exclude` fired.
 */
export type PathRuleOutcome =
  | { kind: "ok"; name: string; applied: string[] }
  | { kind: "excluded"; name: string; ruleId: string; applied: string[] }
  /** §C: a rule produced an unusable path, so **no** transform is applied and the source name wins. */
  | { kind: "invalid"; name: string; ruleId: string; reason: string };

/**
 * `pathRules(sourceName)` — Amendment 2 §A.
 *
 * An ordered pipeline, not first-match-wins: every enabled rule runs, in order, each against the
 * previous rule's output. Precedence is array order, so "two rules disagree" is not a question
 * anyone has to answer (§B).
 *
 * Pure, and run once per variable per scan. Re-scan determinism does not depend on any individual
 * rule being idempotent, because the input is always the untouched source name (§B).
 */
export function applyPathRules(sourceName: string, rules: PathRule[] = []): PathRuleOutcome {
  const applied: string[] = [];
  let name = sourceName;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesName(rule.match, name)) continue;

    if (rule.action.kind === "exclude") {
      // Terminal (§B). There is no path left to transform, so a rule set reads top-to-bottom as
      // an `exclude` being a final statement about the variables it matched.
      return { kind: "excluded", name: normalizeName(name), ruleId: rule.id, applied };
    }

    const next = runAction(name, rule.match, rule.action);
    const invalid = invalidReason(next);
    if (invalid !== null) {
      // §C: a mangled path is never written. The transform is abandoned for this variable and the
      // verbatim source name is used, with the offending rule named in the report.
      return { kind: "invalid", name: normalizeName(sourceName), ruleId: rule.id, reason: invalid };
    }

    name = next;
    applied.push(rule.id);
  }

  return { kind: "ok", name: normalizeName(name), applied };
}

/** The dotted token path a source name derives to — `pathRules(sourceName)` with `/` → `.`. */
export function derivePath(sourceName: string, rules: PathRule[] = []): PathRuleOutcome & { path: string } {
  const outcome = applyPathRules(sourceName, rules);
  return { ...outcome, path: splitVariableName(outcome.name).join(".") };
}

function normalizeName(name: string): string {
  return splitVariableName(name).join("/");
}

function runAction(name: string, match: RuleMatch, action: PathRuleAction): string {
  const segments = splitVariableName(name);

  if (action.kind === "rewrite") {
    const regex = compile(action.pattern);
    if (regex === null) return name;
    // Non-global on purpose: `rewrite` is described as a replace over the whole name, and a
    // pattern anchored with `^…$` is the documented shape. A user wanting every occurrence writes
    // the pattern that way.
    return segments.join("/").replace(regex, action.replacement);
  }

  const picked = new Set(matchedSegments(match, name));
  if (picked.size === 0) return name;

  const out: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (!picked.has(i)) {
      out.push(segments[i]);
      continue;
    }
    if (action.kind === "replace-segment") {
      // A `/` in the replacement splits into several segments; that is insertion, and §B says
      // insertion needs no action of its own.
      for (const piece of splitVariableName(action.with)) out.push(piece);
    }
    // `drop-matched-segments`: the segment simply is not pushed.
  }
  return out.join("/");
}

/** §C's `invalid-result`: an empty path, an empty segment, or a leading/trailing separator. */
function invalidReason(name: string): string | null {
  if (name.trim().length === 0) return "empty-path";
  if (splitVariableName(name).length === 0) return "empty-path";
  if (/^\/|\/$/.test(name)) return "leading-or-trailing-separator";
  if (name.split("/").some((segment) => segment.trim().length === 0)) return "empty-segment";
  return null;
}

// ---------------------------------------------------------------------------
// Rule-set validation
// ---------------------------------------------------------------------------

export interface RuleIssue {
  ruleId: string;
  reason: "bad-match-pattern" | "bad-rewrite-pattern" | "empty-replacement" | "duplicate-id";
  message: string;
}

/**
 * Problems with the rules themselves, as opposed to with what they produce.
 *
 * Separated from `applyPathRules` because these are file-scoped: an uncompilable regex is one
 * broken rule, not one broken variable, and reporting it per variable would bury it under a
 * thousand identical lines. A rule with an issue is skipped by the engine (it matches nothing),
 * so the caller must surface these — a silently inert rule is the failure mode this guards.
 */
export function validateRules(rules: Array<PathRule | { id: string; match: RuleMatch }>): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (seen.has(rule.id)) {
      issues.push({
        ruleId: rule.id,
        reason: "duplicate-id",
        message: `Two rules share the id "${rule.id}". Rule ids identify a rule in the report and in the routing table, so they have to be unique.`,
      });
    }
    seen.add(rule.id);

    if (rule.match.kind === "name" && compile(rule.match.pattern) === null) {
      issues.push({
        ruleId: rule.id,
        reason: "bad-match-pattern",
        message: `Rule "${rule.id}" has a match pattern that is not a valid regular expression, so it matches nothing.`,
      });
    }

    const action = (rule as PathRule).action;
    if (action === undefined) continue;
    if (action.kind === "rewrite") {
      if (compile(action.pattern) === null) {
        issues.push({
          ruleId: rule.id,
          reason: "bad-rewrite-pattern",
          message: `Rule "${rule.id}" has a rewrite pattern that is not a valid regular expression, so it changes nothing.`,
        });
      }
    }
    if (action.kind === "replace-segment" && splitVariableName(action.with).length === 0) {
      issues.push({
        ruleId: rule.id,
        reason: "empty-replacement",
        message: `Rule "${rule.id}" replaces a segment with nothing. Use "drop matched segments" to remove a segment.`,
      });
    }
  }

  return issues;
}

/** The rules an issue-free engine run should use: anything `validateRules` flagged is dropped. */
export function usableRules(rules: PathRule[]): PathRule[] {
  const broken = new Set(validateRules(rules).map((issue) => issue.ruleId));
  return rules.filter((rule) => !broken.has(rule.id));
}

// ---------------------------------------------------------------------------
// `tokens/$rules.json` — Amendment 2 §F
// ---------------------------------------------------------------------------

/** The committed rule set. Serialized by ADR-0002 §7, with `pathRules` order preserved. */
export interface RuleSetFile {
  version: 1;
  generatedBy: "tokenvault";
  pathRules: PathRule[];
}

export const RULES_FILE_PATH = "tokens/$rules.json";

export function makeRuleSetFile(rules: PathRule[]): RuleSetFile {
  return { version: 1, generatedBy: "tokenvault", pathRules: rules.slice() };
}

/**
 * Parses a stored or pulled rule set, dropping anything malformed.
 *
 * Lenient about shape and strict about semantics: a rule that cannot be understood is not silently
 * reinterpreted, it is dropped, and `validateRules` then has nothing to say about it. The file is
 * authored configuration that a teammate may hand-edit, so it must survive a stray key.
 */
export function parseRuleSet(stored: unknown): PathRule[] {
  const record = stored as { pathRules?: unknown } | null;
  const raw = record !== null && typeof record === "object" ? record.pathRules : undefined;
  if (!Array.isArray(raw)) return [];

  const rules: PathRule[] = [];
  for (const item of raw) {
    const rule = parseRule(item);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

function parseRule(item: unknown): PathRule | null {
  if (item === null || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;

  const match = parseMatch(record.match);
  if (match === null) return null;

  const action = parseAction(record.action);
  if (action === null) return null;

  const rule: PathRule = { id: record.id, enabled: record.enabled !== false, match, action };
  if (typeof record.note === "string" && record.note.length > 0) rule.note = record.note;
  return rule;
}

export function parseMatch(value: unknown): RuleMatch | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "segment" && typeof record.value === "string" && record.value.length > 0) {
    const match: RuleMatch = { kind: "segment", value: record.value };
    if (record.caseSensitive === true) match.caseSensitive = true;
    return match;
  }
  if (record.kind === "name" && typeof record.pattern === "string" && record.pattern.length > 0) {
    return { kind: "name", pattern: record.pattern };
  }
  return null;
}

function parseAction(value: unknown): PathRuleAction | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "drop-matched-segments") return { kind: "drop-matched-segments" };
  if (record.kind === "exclude") return { kind: "exclude" };
  if (record.kind === "replace-segment" && typeof record.with === "string") {
    return { kind: "replace-segment", with: record.with };
  }
  if (
    record.kind === "rewrite" &&
    typeof record.pattern === "string" &&
    typeof record.replacement === "string"
  ) {
    return { kind: "rewrite", pattern: record.pattern, replacement: record.replacement };
  }
  return null;
}

/**
 * Whether two rule sets are the same — Amendment 2 §F's mismatch check.
 *
 * Compares the *effective* rules, order included, and ignores `note`: a comment cannot change a
 * path, and blocking a whole repo over an edited note would be the gate crying wolf. A disabled
 * rule is likewise not part of the comparison, because it produces no transform on either side.
 */
export function rulesEqual(a: PathRule[], b: PathRule[]): boolean {
  const left = a.filter((rule) => rule.enabled).map(ruleKey);
  const right = b.filter((rule) => rule.enabled).map(ruleKey);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function ruleKey(rule: PathRule): string {
  return JSON.stringify([rule.id, rule.match, rule.action]);
}
