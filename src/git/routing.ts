// Push routing and per-repo projections — ADR-0008 §3, §5.
//
// Two halves, and the order matters:
//
//   1. **The router** decides, per token, which connections receive it. Default is every enabled
//      connection; ordered exception rules replace that set outright, last match wins (§5).
//   2. **The projection** turns those decisions into an ordinary token tree per repo, which
//      everything downstream — `stableStringify`, blob SHAs, ADR-0006 §4's three-SHA table — then
//      handles with no idea that routing happened (§3).
//
// The rule matcher is ADR-0002 Amendment 2 §A's, imported rather than reimplemented. Two matchers
// that could disagree about what `segment: "abc"` means would be a bug nobody could see from
// either side.
//
// Routing is per **token** and ADR-0006's unit of commit is per **file**. They reconcile in one
// direction only: a repo's copy of `theme/light.json` is a *subset* of the local file, never a
// different file (§3).

import type { Manifest, Token, TokenGroup } from "../tokens/types";
import type { RuleMatch } from "../tokens/rules";
import { matchesName, parseMatch } from "../tokens/rules";
import { flattenTree } from "./filediff";
import { setTokenAtPath } from "../tokens/paths";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RoutingRule {
  id: string;
  enabled: boolean;
  /**
   * What the pattern matches, and the choice is real (§5).
   *
   * `"path"` (the default, because it is the predictable one) matches the post-transform token
   * path — what the user sees in the plugin and what lands in the repo. `"source"` matches the
   * Figma variable's name *before* ADR-0002 Amendment 2's rules ran, which is the only way to
   * route on a segment a naming rule strips — plausibly the exact case, since a segment removed as
   * output noise may be precisely the one carrying the destination.
   */
  on?: "path" | "source";
  match: RuleMatch;
  /** Connection ids. `[]` is legal and means the token is committed nowhere (§5). */
  repos: string[];
}

export function parseRoutingRules(stored: unknown): RoutingRule[] {
  if (!Array.isArray(stored)) return [];
  const rules: RoutingRule[] = [];

  for (const item of stored) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const match = parseMatch(record.match);
    if (match === null) continue;
    if (!Array.isArray(record.repos)) continue;

    rules.push({
      id: record.id,
      enabled: record.enabled !== false,
      on: record.on === "source" ? "source" : "path",
      match,
      repos: record.repos.filter((repo): repo is string => typeof repo === "string"),
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export interface RouteInput {
  /** The post-transform dotted token path. */
  path: string;
  /** The Figma variable's pre-transform name, where one is known — for `on: "source"` rules. */
  sourceName?: string;
}

export interface RouteDecision {
  /** Connection ids, in the order the enabled connections were given. */
  repos: string[];
  /** The rule that decided, absent when the token took the default. Shown per token on review. */
  routedBy?: string;
}

/**
 * Where one token goes.
 *
 * **Default is every enabled connection.** A token matched by no rule goes everywhere — rules are
 * exceptions, which is how Shyam described them and which makes the empty rule set behave exactly
 * like ADR-0006 (§5).
 *
 * **Ordered, last matching rule wins**, its `repos` replacing the destination set outright. Union
 * and intersection semantics were rejected as a mini-language: the later rule wins, and the review
 * screen shows which rule routed each token.
 *
 * A rule naming a connection that is disabled or gone routes nowhere rather than somewhere
 * unexpected. `routedBy` is still reported, so the review screen can say *why* a token is going
 * nowhere instead of leaving it looking arbitrary.
 */
export function routeToken(
  input: RouteInput,
  rules: RoutingRule[],
  enabledIds: string[]
): RouteDecision {
  let decision: RouteDecision = { repos: enabledIds.slice() };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const subject = rule.on === "source" ? input.sourceName : input.path;
    // An `on: "source"` rule cannot match a token with no known source name — a style token, or a
    // tree restored from cache without its scan. It abstains rather than guessing against the path,
    // which would silently route on the wrong string.
    if (subject === undefined) continue;
    if (!matchesName(rule.match, toMatchableName(subject))) continue;

    const wanted = new Set(rule.repos);
    decision = { repos: enabledIds.filter((id) => wanted.has(id)), routedBy: rule.id };
  }

  return decision;
}

/**
 * The matcher works on `/`-delimited names; a token path is `.`-delimited.
 *
 * Converted here rather than in the matcher, because the matcher's segment semantics are defined
 * over Figma names and both consumers must see the same segmentation. `segment: "abc"` therefore
 * means the same thing whether a rule is matching `on: "path"` or `on: "source"`.
 */
function toMatchableName(subject: string): string {
  return subject.indexOf("/") === -1 ? subject.split(".").join("/") : subject;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ProjectionInput {
  /** Build-shaped path (`tokens/theme/light.json`) → the local tree for it. */
  trees: Map<string, TokenGroup>;
  manifest: Manifest;
  rules: RoutingRule[];
  /** The enabled connections, in settings order. */
  connectionIds: string[];
  /** Figma variable id → pre-transform source name, for `on: "source"` rules. */
  sourceNames?: Map<string, string>;
}

export interface ProjectedToken {
  path: string;
  setId: string;
  token: Token;
}

export interface Projection {
  connectionId: string;
  /**
   * Build-shaped path → projected tree.
   *
   * **An empty projection writes no file** (§3): a set whose tokens all route elsewhere does not
   * appear in that repo as an empty JSON object, so the key is simply absent.
   */
  files: Map<string, TokenGroup>;
  /** The manifest with empty sets dropped, so Phase 8's export in that repo globs what is there. */
  manifest: Manifest;
  tokens: ProjectedToken[];
}

export interface RoutingResult {
  projections: Projection[];
  /** Tokens no enabled connection receives — shown as *not pushed anywhere*, never as errors (§5). */
  routedNowhere: Array<{ path: string; setId: string; routedBy?: string }>;
  /** Per token instance, which rule decided — what the review screen renders per row. */
  decisions: Map<string, RouteDecision>;
}

function decisionKey(setId: string, path: string): string {
  // NUL, for the reason `graph.ts` gives: a Figma name carries spaces and an id carries colons, so
  // a separator that can appear inside the parts is not a separator.
  return `${setId}\u0000${path}`;
}

/**
 * One projection per connection, plus what the review screen needs to explain them.
 *
 * The manifest is projected too (§3): sets with an empty projection are dropped from
 * `collections`, `styleSets`, `tokenSetOrder` and every theme's `selectedTokenSets`. Otherwise
 * Phase 8's export in that repo globs a file that is not there and fails a build for a reason
 * nobody can see.
 */
export function projectTrees(input: ProjectionInput): RoutingResult {
  const setOfFile = fileToSet(input.manifest);
  const projections = new Map<string, Projection>();
  for (const id of input.connectionIds) {
    projections.set(id, {
      connectionId: id,
      files: new Map(),
      manifest: input.manifest,
      tokens: [],
    });
  }

  const decisions = new Map<string, RouteDecision>();
  const routedNowhere: Array<{ path: string; setId: string; routedBy?: string }> = [];
  /** Which sets each connection actually received something for — the manifest projection's input. */
  const liveSets = new Map<string, Set<string>>();
  for (const id of input.connectionIds) liveSets.set(id, new Set());

  for (const buildPath of Array.from(input.trees.keys()).sort()) {
    const tree = input.trees.get(buildPath) as TokenGroup;
    const setId = setOfFile.get(buildPath) ?? buildPath;

    for (const [path, token] of Array.from(flattenTree(tree))) {
      const decision = routeToken(
        { path, sourceName: sourceNameOf(token, input.sourceNames) },
        input.rules,
        input.connectionIds
      );
      decisions.set(decisionKey(setId, path), decision);

      if (decision.repos.length === 0) {
        routedNowhere.push({ path, setId, routedBy: decision.routedBy });
        continue;
      }

      for (const id of decision.repos) {
        const projection = projections.get(id);
        if (projection === undefined) continue;
        let file = projection.files.get(buildPath);
        if (file === undefined) {
          file = {};
          projection.files.set(buildPath, file);
        }
        setTokenAtPath(file, path.split("."), token);
        projection.tokens.push({ path, setId, token });
        (liveSets.get(id) as Set<string>).add(setId);
      }
    }
  }

  for (const id of input.connectionIds) {
    const projection = projections.get(id) as Projection;
    projection.manifest = projectManifest(input.manifest, liveSets.get(id) as Set<string>);
  }

  return {
    projections: input.connectionIds.map((id) => projections.get(id) as Projection),
    routedNowhere,
    decisions,
  };
}

function sourceNameOf(token: Token, sourceNames?: Map<string, string>): string | undefined {
  if (sourceNames === undefined) return undefined;
  const variableId = token.$extensions?.["com.tokenvault"]?.figma?.variableId;
  return variableId === undefined ? undefined : sourceNames.get(variableId);
}

/** Build-shaped file path → set id, off the manifest's own bookkeeping. */
function fileToSet(manifest: Manifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const collection of manifest.collections) {
    for (const mode of collection.modes) out.set(`tokens/${mode.file}`, mode.set);
  }
  for (const styleSet of manifest.styleSets ?? []) out.set(`tokens/${styleSet.file}`, styleSet.set);
  return out;
}

/**
 * The manifest as one repo should see it — §3.
 *
 * A theme that loses every one of its sets is dropped rather than left pointing at nothing; a
 * theme that keeps some keeps those, in order, because a partial theme in a repo holding a subset
 * of the tokens is exactly what that repo's export should build.
 */
export function projectManifest(manifest: Manifest, liveSets: Set<string>): Manifest {
  const collections = manifest.collections
    .map((collection) => ({
      ...collection,
      modes: collection.modes.filter((mode) => liveSets.has(mode.set)),
    }))
    .filter((collection) => collection.modes.length > 0);

  const styleSets = (manifest.styleSets ?? []).filter((styleSet) => liveSets.has(styleSet.set));

  const projected: Manifest = {
    ...manifest,
    collections,
    tokenSetOrder: manifest.tokenSetOrder.filter((set) => liveSets.has(set)),
    themes: manifest.themes
      .map((theme) => ({
        ...theme,
        selectedTokenSets: theme.selectedTokenSets.filter((set) => liveSets.has(set)),
      }))
      .filter((theme) => theme.selectedTokenSets.length > 0),
  };

  if (manifest.styleSets !== undefined) {
    // Absent and empty are different: a v2 manifest that had style sets and now projects none
    // should say so, rather than reading as a v1-shaped manifest that never had any.
    projected.styleSets = styleSets;
  }

  return projected;
}
