// The Figma Variables → token JSON conversion — ADR-0002.
//
// Everything in this file is pure: it takes a `FileSnapshot` (a plain-data mirror of the Figma
// API, produced by src/figma/scan.ts) and returns the full output tree. No `figma` global is
// reachable from here, which is what makes the schema logic unit-testable.

import type {
  CollectionSnapshot,
  FileSnapshot,
  ImportReport,
  ImportResult,
  Manifest,
  ManifestCollection,
  ManifestMode,
  ManifestTheme,
  ReportEntry,
  SubtypeCandidate,
  Token,
  TokenFileOutput,
  TokenGroup,
  TokenType,
  BuildOptions,
  VariableSnapshot,
  VariableValueSnapshot,
} from "./types";
import { compareKeys } from "./serialize";
import { normalizePathKey, setTokenAtPath, slugify, splitVariableName } from "./paths";
import {
  RULES_FILE_PATH,
  applyPathRules,
  makeRuleSetFile,
  usableRules,
  validateRules,
  type PathRule,
} from "./rules";
import { isAlias, isRgba, normalizeFloat, rgbaToHex, toReference } from "./values";
import { resolveSubtype, type SubtypeTag } from "./subtype";
import {
  countInboundAliases,
  detectCollisions,
  explainWinnerRule,
  type PreparedVariable,
} from "./collisions";

const TOKENS_DIR = "tokens";

/** Placeholder identifier, not product copy — Amendment 1 §D. Nothing depends on the string. */
const DEFAULT_THEME_NAME = "Default";

/** Figma `resolvedType` → DTCG `$type`. ADR §3's table; anything absent is unsupported. */
const TYPE_MAP: Record<string, TokenType> = {
  COLOR: "color",
  FLOAT: "number",
  BOOLEAN: "boolean",
  STRING: "string",
};

export function buildImport(snapshot: FileSnapshot, options: BuildOptions): ImportResult {
  const userSubtypes = options.userSubtypes ?? {};
  const entries: ReportEntry[] = [];

  const { collections, excludedCollectionIds } = resolveCollections(
    snapshot.collections,
    snapshot.variables,
    entries
  );
  const collectionsById = new Map<string, CollectionSnapshot>();
  for (const collection of collections) collectionsById.set(collection.id, collection);

  // Names for alias resolution come from every variable in the file, including ones that later
  // lose a collision — a reference should name what Figma actually points at.
  const sourceNames = new Map<string, string>();
  for (const variable of snapshot.variables) sourceNames.set(variable.id, variable.name);
  for (const id of Object.keys(snapshot.aliasTargetNames)) {
    if (!sourceNames.has(id)) sourceNames.set(id, snapshot.aliasTargetNames[id]);
  }

  const derivation = deriveNames(sourceNames, options.pathRules ?? [], entries);
  // Amendment 2 §D: alias targets go through the *same* pipeline as the tokens they point at, or
  // every reference in a rule-transformed file dangles.
  const namesById = derivation.names;

  const prepared = prepareVariables(
    snapshot.variables,
    collectionsById,
    excludedCollectionIds,
    derivation,
    entries
  );
  const inboundAliases = countInboundAliases(snapshot.variables);
  const collisions = detectCollisions(prepared, inboundAliases);
  entries.push(...collisions.entries);

  const survivorsByCollection = new Map<string, PreparedVariable[]>();
  for (const item of collisions.survivors) {
    const bucket = survivorsByCollection.get(item.collection.id);
    if (bucket) bucket.push(item);
    else survivorsByCollection.set(item.collection.id, [item]);
  }

  // Subtype tags are per variable, not per mode: a variable has one identity and one unit.
  const subtypeByVariableId = new Map<string, SubtypeTag>();
  for (const item of collisions.survivors) {
    const tokenType = TYPE_MAP[item.variable.resolvedType];
    subtypeByVariableId.set(
      item.variable.id,
      resolveSubtype(tokenType, item.variable.scopes, userSubtypes[item.variable.id])
    );
  }

  // Convert every (variable, mode) cell up front. Whether a reference resolves depends on which
  // sets its target ended up in, and that is only knowable once every file has been converted —
  // so conversion and reporting are two passes, not one.
  const plans: FilePlan[] = [];
  for (const collection of collections) {
    const collectionSlug = slugify(collection.name);
    const members = survivorsByCollection.get(collection.id) ?? [];

    for (const mode of collection.modes) {
      plans.push({
        collection,
        modeId: mode.modeId,
        setId: `${collection.name}/${mode.name}`,
        file: `${collectionSlug}/${slugify(mode.name)}.json`,
        cells: members.map((item) => ({
          item,
          result: convertValue(
            item.variable.valuesByMode[mode.modeId],
            TYPE_MAP[item.variable.resolvedType],
            namesById
          ),
        })),
      });
    }
  }

  const index = buildResolutionIndex(plans, snapshot.variables, derivation.excluded);

  const files: TokenFileOutput[] = [];
  const manifestCollections: ManifestCollection[] = [];
  const tokenSetOrder: string[] = [];
  let tokenCount = 0;

  for (const collection of collections) {
    const modes: ManifestMode[] = [];

    for (const plan of plans) {
      if (plan.collection !== collection) continue;

      const tree = buildModeFile(plan, subtypeByVariableId, index, entries);
      tokenCount += tree.tokenCount;

      files.push({ path: `${TOKENS_DIR}/${plan.file}`, content: tree.root });
      modes.push({
        name: modeNameOf(collection, plan.modeId),
        slug: slugify(modeNameOf(collection, plan.modeId)),
        set: plan.setId,
        $figmaModeId: plan.modeId,
        file: plan.file,
      });
      tokenSetOrder.push(plan.setId);
    }

    manifestCollections.push({
      name: collection.name,
      slug: slugify(collection.name),
      $figmaCollectionId: collection.id,
      modes,
    });
  }

  const themes = buildThemes(manifestCollections, tokenSetOrder, entries);

  const manifest: Manifest = {
    version: 1,
    generatedBy: "tokenvault",
    tokenSetOrder,
    collections: manifestCollections,
    themes,
  };

  const candidates = buildCandidates(collisions.survivors, subtypeByVariableId);
  const unconfirmedSubtypes = candidates.filter((candidate) => candidate.needsConfirmation).length;

  entries.sort(compareEntries);

  const report: ImportReport = {
    version: 1,
    importedAt: options.importedAt,
    figmaFileKey: snapshot.fileKey,
    counts: {
      tokens: tokenCount,
      flagged: entries.length,
      unconfirmedSubtypes,
    },
    entries,
  };

  files.push({ path: `${TOKENS_DIR}/$manifest.json`, content: manifest });
  files.push({ path: `${TOKENS_DIR}/$import-report.json`, content: report });
  // Amendment 2 §F: authored configuration the tree cannot be reproduced without, so it commits —
  // unlike `$import-report.json`, which ADR-0006 §5 keeps local as per-scan machine state.
  if ((options.pathRules ?? []).length > 0) {
    files.push({ path: RULES_FILE_PATH, content: makeRuleSetFile(options.pathRules as PathRule[]) });
  }
  files.sort((a, b) => compareKeys(a.path, b.path));

  const modeCount = collections.reduce((total, collection) => total + collection.modes.length, 0);

  return {
    files,
    manifest,
    report,
    candidates,
    counts: {
      collections: collections.length,
      modes: modeCount,
      variables: snapshot.variables.length,
      tokens: tokenCount,
      flagged: entries.length,
      unconfirmedSubtypes,
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Sorts collections by name and rejects slug clashes.
 *
 * ADR §1 fixes the file path as `tokens/<collection-slug>/<mode-slug>.json` but does not say
 * what happens when two collection names slug to the same directory ("Core" and "core!"). Left
 * unhandled, the second collection would silently overwrite the first's files — exactly the
 * silent loss §6.5.1 rules out — so it is treated as a collision with the same first-wins rule.
 */
function resolveCollections(
  collections: CollectionSnapshot[],
  variables: VariableSnapshot[],
  entries: ReportEntry[]
): { collections: CollectionSnapshot[]; excludedCollectionIds: Set<string> } {
  const sorted = collections.slice().sort((a, b) => compareKeys(a.name, b.name) || compareKeys(a.id, b.id));
  const bySlug = new Map<string, CollectionSnapshot[]>();
  for (const collection of sorted) {
    const slug = slugify(collection.name);
    const bucket = bySlug.get(slug);
    if (bucket) bucket.push(collection);
    else bySlug.set(slug, [collection]);
  }

  // Amendment 1 §F, collection-level analogue: the collection with more variables wins, since
  // that is the one whose removal loses more tokens. Name order is the deterministic tiebreak.
  const variableCounts = new Map<string, number>();
  for (const variable of variables) {
    variableCounts.set(variable.collectionId, (variableCounts.get(variable.collectionId) ?? 0) + 1);
  }

  const excludedCollectionIds = new Set<string>();
  for (const slug of Array.from(bySlug.keys()).sort(compareKeys)) {
    const group = bySlug.get(slug) as CollectionSnapshot[];
    if (group.length < 2) continue;

    let best = -Infinity;
    for (const collection of group) best = Math.max(best, variableCounts.get(collection.id) ?? 0);
    const leaders = group.filter((collection) => (variableCounts.get(collection.id) ?? 0) === best);

    const winner = leaders[0];
    const winnerRule = leaders.length === 1 ? ("variable-count" as const) : ("name-order" as const);
    for (const loser of group) {
      if (loser !== winner) excludedCollectionIds.add(loser.id);
    }

    entries.push({
      kind: "collision",
      reason: "set-slug",
      message: `${group.length} collections slug to "${slug}" and would write to the same files. Kept "${winner.name}" (${explainWinnerRule(winnerRule)}); the others were not written.`,
      path: slug,
      winnerRule,
      participants: group.map((collection) => ({
        // The contest is between collections, so variable identity is empty (Amendment 1 §E).
        variableId: "",
        variableName: "",
        collectionId: collection.id,
        collectionName: collection.name,
        outcome: collection === winner ? ("written" as const) : ("skipped" as const),
      })),
    });
  }

  return {
    collections: sorted.filter((collection) => !excludedCollectionIds.has(collection.id)),
    excludedCollectionIds,
  };
}

/**
 * Every variable id's *derived* name — Amendment 2 §A's `pathRules(sourceName)`.
 *
 * Run over alias targets as well as over local variables, because §D makes the reference-rewriting
 * and the path-rewriting the same function: a reference is written to the target's transformed
 * name, so both ends of an alias move together and a rule change never strands one.
 *
 * A rule that cannot work — an uncompilable regex, a duplicate id — is reported **once**, here,
 * and then dropped. Reporting it per variable would bury one broken rule under a thousand
 * identical lines, and leaving it in silently is exactly the inert-rule failure §F guards against.
 */
function deriveNames(
  sourceNames: Map<string, string>,
  configured: PathRule[],
  entries: ReportEntry[]
): Derivation {
  for (const issue of validateRules(configured)) {
    entries.push({ kind: "path-rule", reason: issue.reason, message: issue.message });
  }

  const rules = usableRules(configured);
  const names = new Map<string, string>();
  const paths = new Map<string, string>();
  const excluded = new Map<string, string>();
  const invalid = new Map<string, { ruleId: string; reason: string }>();

  for (const id of Array.from(sourceNames.keys())) {
    const outcome = applyPathRules(sourceNames.get(id) as string, rules);
    // `name` is populated in all three outcomes, including `excluded`: §I keeps writing a
    // reference to an excluded target, so it needs the path that target *would* have had.
    names.set(id, outcome.name);
    paths.set(id, splitVariableName(outcome.name).join("."));
    if (outcome.kind === "excluded") excluded.set(id, outcome.ruleId);
    if (outcome.kind === "invalid") invalid.set(id, { ruleId: outcome.ruleId, reason: outcome.reason });
  }

  return { names, paths, excluded, invalid };
}

interface Derivation {
  /** Variable id → transformed `/`-delimited name. */
  names: Map<string, string>;
  /** Variable id → transformed dotted token path. */
  paths: Map<string, string>;
  /** Variable id → the id of the `exclude` rule that dropped it (§I). */
  excluded: Map<string, string>;
  /** Variable id → the rule whose output was unusable, so the source name was used (§C). */
  invalid: Map<string, { ruleId: string; reason: string }>;
}

function prepareVariables(
  variables: VariableSnapshot[],
  collectionsById: Map<string, CollectionSnapshot>,
  excludedCollectionIds: Set<string>,
  derivation: Derivation,
  entries: ReportEntry[]
): PreparedVariable[] {
  const prepared: PreparedVariable[] = [];
  /** §I: exclusions are reported in aggregate — one entry per rule, never one per variable. */
  const excludedCounts = new Map<string, number>();

  for (const variable of variables) {
    const excludedBy = derivation.excluded.get(variable.id);
    if (excludedBy !== undefined) {
      // The variable produces no token at all: nothing in any set file, nothing in the manifest,
      // nothing pushed (§I). Counted rather than listed.
      excludedCounts.set(excludedBy, (excludedCounts.get(excludedBy) ?? 0) + 1);
      continue;
    }

    const collection = collectionsById.get(variable.collectionId);
    if (!collection) {
      // Either the collection lost a slug clash (already reported) or Figma handed us an
      // orphan. Only the orphan case is worth a second entry.
      if (!excludedCollectionIds.has(variable.collectionId)) {
        entries.push({
          kind: "unmappable-value",
          reason: "unknown-collection",
          message: `Variable "${variable.name}" belongs to collection ${variable.collectionId}, which is not in this file. Not written.`,
          participants: [
            {
              variableId: variable.id,
              variableName: variable.name,
              collectionId: variable.collectionId,
              collectionName: "(unknown)",
              outcome: "skipped",
            },
          ],
        });
      }
      continue;
    }

    if (TYPE_MAP[variable.resolvedType] === undefined) {
      // Figma has since added EASING and TIMING resolved types, which ADR §3's table predates.
      // Phase 2 is scoped to the four types the ADR pins, so these are reported, not guessed at.
      entries.push({
        kind: "unsupported-type",
        reason: "resolved-type",
        message: `Variable "${variable.name}" has Figma resolved type ${variable.resolvedType}, which the Phase 2 schema does not cover (ADR-0002 §3 supports COLOR, FLOAT, BOOLEAN, STRING). Not written.`,
        participants: [participantOf(variable, collection)],
      });
      continue;
    }

    const badRule = derivation.invalid.get(variable.id);
    if (badRule !== undefined) {
      // §C: the transform is not applied, the verbatim source name is used, and the rule is named.
      // A mangled path is never written — §5's "no silent drop, no mangled name" covers rules too.
      entries.push({
        kind: "path-rule",
        reason: "invalid-result",
        message: `Rule "${badRule.ruleId}" produced an unusable path for variable "${variable.name}" (${badRule.reason}). The rule was not applied to it; its Figma name was used instead.`,
        path: derivation.paths.get(variable.id),
        participants: [participantOf(variable, collection)],
      });
    }

    const derivedName = derivation.names.get(variable.id) ?? variable.name;
    const segments = splitVariableName(derivedName);
    if (segments.length === 0) {
      entries.push({
        kind: "unmappable-value",
        reason: "empty-path",
        message: `Variable ${variable.id} has a name that produces no token path ("${variable.name}"). Not written.`,
        participants: [participantOf(variable, collection)],
      });
      continue;
    }

    const path = segments.join(".");
    prepared.push({
      variable,
      collection,
      path,
      segments,
      normalizedPath: normalizePathKey(path),
      // Amendment 2 §C: a rule-induced collision has to be readable, and a report saying two
      // variables collided at a path neither of them is *named* is not.
      sourceName: variable.name,
    });
  }

  for (const ruleId of Array.from(excludedCounts.keys()).sort(compareKeys)) {
    const count = excludedCounts.get(ruleId) as number;
    entries.push({
      kind: "path-rule",
      reason: "excluded",
      message: `Rule "${ruleId}" excluded ${count} variable${count === 1 ? "" : "s"} from import. ${count === 1 ? "It produces" : "They produce"} no tokens.`,
      ruleId,
      count,
    });
  }

  return prepared;
}

function modeNameOf(collection: CollectionSnapshot, modeId: string): string {
  const mode = collection.modes.find((candidate) => candidate.modeId === modeId);
  return mode ? mode.name : modeId;
}

/**
 * Indexes, across every planned file, where each variable's token actually landed.
 *
 * A cell that failed to convert — no value for the mode, or a value contradicting the type —
 * produces no token, so the variable is "missing" from that set even though it exists in the
 * file. That is the hole a reference can fall through.
 */
function buildResolutionIndex(
  plans: FilePlan[],
  variables: VariableSnapshot[],
  excludedByRule: Map<string, string>
): ResolutionIndex {
  const writtenAnywhere = new Set<string>();
  const missingSets = new Map<string, string[]>();

  for (const plan of plans) {
    for (const cell of plan.cells) {
      const raw = cell.item.variable.valuesByMode[plan.modeId];
      const produced = cell.result.ok && raw !== undefined && raw !== null;

      if (produced) {
        writtenAnywhere.add(cell.item.variable.id);
      } else {
        const bucket = missingSets.get(cell.item.variable.id);
        if (bucket) bucket.push(plan.setId);
        else missingSets.set(cell.item.variable.id, [plan.setId]);
      }
    }
  }

  for (const sets of Array.from(missingSets.values())) sets.sort(compareKeys);

  const collectionOf = new Map<string, string>();
  const names = new Map<string, string>();
  for (const variable of variables) {
    collectionOf.set(variable.id, variable.collectionId);
    names.set(variable.id, variable.name);
  }

  return { writtenAnywhere, missingSets, collectionOf, names, excludedByRule };
}

function participantOf(variable: VariableSnapshot, collection: CollectionSnapshot) {
  return {
    variableId: variable.id,
    variableName: variable.name,
    collectionId: collection.id,
    collectionName: collection.name,
    outcome: "skipped" as const,
  };
}

interface ModeFileResult {
  root: TokenGroup;
  tokenCount: number;
}

/** One (collection, mode) output file, with every member's value already converted. */
interface FilePlan {
  collection: CollectionSnapshot;
  modeId: string;
  setId: string;
  file: string;
  cells: Array<{ item: PreparedVariable; result: ConversionResult }>;
}

/**
 * What is needed to tell whether a written reference actually resolves.
 *
 * A reference is mode-free (ADR §2) but the thing it points at is not: the target has one token
 * per mode of *its* collection, and a mode it has no value for produces no token at all. So
 * "was this variable written" is not enough — the question is which sets it was written to.
 */
interface ResolutionIndex {
  /** Variables that produced at least one token anywhere in the output. */
  writtenAnywhere: Set<string>;
  /** For each variable, the sets it should have appeared in but did not. Sorted. */
  missingSets: Map<string, string[]>;
  /** Every variable's owning collection id, including ones that were never written. */
  collectionOf: Map<string, string>;
  names: Map<string, string>;
  /** Variable id → the `exclude` rule that dropped it, so a dangle can name the cause (§I). */
  excludedByRule: Map<string, string>;
}

/**
 * Decides whether a reference written into `setId` will fail to resolve, and why.
 *
 * Three distinct failures, all `dangling-reference` (Amendment 1 §G) since the referring token
 * itself was written fine:
 *
 * - the target lives in a team library, so it is nameable but its tokens are not in this repo;
 * - the target produced no token anywhere — a collision loser, an unsupported type, or a
 *   variable with no usable value in any mode;
 * - the target exists but is absent from a mode. When the target lives in the referrer's own
 *   collection, that is exact: same collection, same modes, so it dangles in this very file.
 *   Across collections it depends on which modes a theme pairs, so the entry names the sets
 *   where the hole is rather than claiming this one set is broken.
 */
function danglingReference(
  targetId: string,
  targetName: string,
  referrerCollectionId: string,
  setId: string,
  index: ResolutionIndex
): { reason: string; message: string } | null {
  if (!index.collectionOf.has(targetId)) {
    // Nameable but not local: an alias into a team library. The reference is written because it
    // is what Figma actually points at, but nothing in this repo defines it.
    return {
      reason: "alias-target-external",
      message: `references "${targetName}", which lives in a team library rather than this file, so no token in this repo defines it.`,
    };
  }

  const excludedBy = index.excludedByRule.get(targetId);
  if (excludedBy !== undefined) {
    // §I: a reference to an excluded variable dangles, and import still writes it — the token was
    // mapped fine, only its target was dropped. Its own reason, because unlike a collision loser
    // the fix is a rule edit rather than a rename in Figma. Amendment 3 makes this block the push.
    return {
      reason: "alias-target-excluded",
      message: `references "${targetName}", which rule "${excludedBy}" excludes from import, so nothing in the token files defines it.`,
    };
  }

  if (!index.writtenAnywhere.has(targetId)) {
    return {
      reason: "alias-target-skipped",
      message: `references "${targetName}", which was not written to the token files (it lost a collision, its type is unsupported, or it has no usable value), so the reference will not resolve until that is fixed in Figma.`,
    };
  }

  const missing = index.missingSets.get(targetId);
  if (!missing || missing.length === 0) return null;

  const sameCollection = index.collectionOf.get(targetId) === referrerCollectionId;
  if (sameCollection) {
    if (missing.indexOf(setId) === -1) return null;
    return {
      reason: "alias-target-missing-in-mode",
      message: `references "${targetName}", which has no value in this mode, so the reference does not resolve within ${setId}.`,
    };
  }

  return {
    reason: "alias-target-missing-in-mode",
    message: `references "${targetName}", which is missing from ${missing.join(", ")}. Any theme selecting one of those sets will not resolve this reference.`,
  };
}

function buildModeFile(
  plan: FilePlan,
  subtypeByVariableId: Map<string, SubtypeTag>,
  index: ResolutionIndex,
  entries: ReportEntry[]
): ModeFileResult {
  const { collection, modeId, setId } = plan;
  const root: TokenGroup = {};
  let tokenCount = 0;

  for (const cell of plan.cells) {
    const { item, result } = cell;
    const raw = item.variable.valuesByMode[modeId];

    if (raw === undefined || raw === null) {
      entries.push({
        kind: "unmappable-value",
        reason: "missing-mode-value",
        message: `Variable "${item.variable.name}" has no value for mode "${modeId}". Not written to ${setId}.`,
        path: item.path,
        set: setId,
        participants: [participantOf(item.variable, collection)],
      });
      continue;
    }

    if (!result.ok) {
      entries.push({
        kind: "unmappable-value",
        reason: result.reason,
        message: `Variable "${item.variable.name}" (${setId}): ${result.message} Not written.`,
        path: item.path,
        set: setId,
        participants: [participantOf(item.variable, collection)],
      });
      continue;
    }

    if (result.aliasTargetId !== undefined && result.aliasTargetName !== undefined) {
      const dangling = danglingReference(
        result.aliasTargetId,
        result.aliasTargetName,
        collection.id,
        setId,
        index
      );
      if (dangling) {
        entries.push({
          // The token WAS mapped and written; only what it points at is missing (Amendment 1 §G).
          kind: "dangling-reference",
          reason: dangling.reason,
          message: `Variable "${item.variable.name}" (${setId}): ${dangling.message}`,
          path: item.path,
          set: setId,
          participants: [participantOf(item.variable, collection)],
        });
      }
    }

    const tokenType = TYPE_MAP[item.variable.resolvedType];
    const tag = subtypeByVariableId.get(item.variable.id) ?? {};
    const token: Token = {
      $type: tokenType,
      $value: result.value,
      $extensions: {
        "com.tokenvault": {
          subtype: tag.subtype,
          subtypeSource: tag.subtypeSource,
          figma: {
            variableId: item.variable.id,
            collectionId: collection.id,
            modeId,
            scopes: item.variable.scopes.slice().sort(compareKeys),
          },
        },
      },
    };
    if (item.variable.description.length > 0) token.$description = item.variable.description;

    if (!setTokenAtPath(root, item.segments, token)) {
      // The collision detector should have caught anything that lands here; this is a net.
      entries.push({
        kind: "collision",
        reason: "path-blocked",
        message: `Token path "${item.path}" could not be written to ${setId} — the path is already occupied. Not written.`,
        path: item.path,
        set: setId,
        participants: [participantOf(item.variable, collection)],
      });
      continue;
    }

    tokenCount += 1;
  }

  return { root, tokenCount };
}

type ConversionResult =
  | {
      ok: true;
      value: string | number | boolean;
      /** Set when the value was an alias, so the caller can check the target actually resolves. */
      aliasTargetId?: string;
      aliasTargetName?: string;
    }
  | { ok: false; reason: string; message: string };

/**
 * ADR §2 and §3: aliases become `{dot.path}` references, everything else a literal.
 *
 * Whether a reference actually *resolves* is deliberately not decided here — that depends on
 * which set file is being written and which mode it is for, which this function cannot see.
 * It reports the target it referenced and lets the caller judge.
 */
export function convertValue(
  raw: VariableValueSnapshot,
  tokenType: TokenType,
  namesById: Map<string, string>
): ConversionResult {
  if (isAlias(raw)) {
    const targetName = namesById.get(raw.id);
    if (targetName === undefined) {
      return {
        ok: false,
        reason: "alias-target-unknown",
        message: `aliases variable ${raw.id}, which is not in this file and could not be named, so no reference can be written.`,
      };
    }
    return {
      ok: true,
      value: toReference(targetName),
      aliasTargetId: raw.id,
      aliasTargetName: targetName,
    };
  }

  if (tokenType === "color") {
    if (!isRgba(raw)) {
      return { ok: false, reason: "type-mismatch", message: `is a COLOR variable whose value is not an RGB(A) object.` };
    }
    return { ok: true, value: rgbaToHex(raw) };
  }

  if (tokenType === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, reason: "type-mismatch", message: `is a FLOAT variable whose value is not a finite number.` };
    }
    return { ok: true, value: normalizeFloat(raw) };
  }

  if (tokenType === "boolean") {
    if (typeof raw !== "boolean") {
      return { ok: false, reason: "type-mismatch", message: `is a BOOLEAN variable whose value is not a boolean.` };
    }
    return { ok: true, value: raw };
  }

  if (typeof raw !== "string") {
    return { ok: false, reason: "type-mismatch", message: `is a STRING variable whose value is not a string.` };
  }
  return { ok: true, value: raw };
}

/**
 * Theme composition — ADR §6, as amended by Amendment 1 §C and §D.
 *
 * One multi-mode collection is the unambiguous case: one theme per mode, plus the single mode
 * of every single-mode collection. Two or more make composition a product question, so nothing
 * is generated. Zero is not ambiguous at all — there is exactly one possible composition — so a
 * single theme is generated and only its *name* is synthesised.
 */
function buildThemes(
  collections: ManifestCollection[],
  tokenSetOrder: string[],
  entries: ReportEntry[]
): ManifestTheme[] {
  const multiMode = collections.filter((collection) => collection.modes.length > 1);

  if (multiMode.length === 1) {
    const themed = multiMode[0];
    const baseSets = collections
      .filter((collection) => collection !== themed)
      .map((collection) => collection.modes[0].set);

    return themed.modes.map((mode) => ({
      name: mode.name,
      selectedTokenSets: orderSets(baseSets.concat([mode.set]), tokenSetOrder),
    }));
  }

  if (collections.length === 0) {
    entries.push({
      kind: "theme-composition",
      reason: "no-collections",
      message: "No variable collections were imported, so no themes were generated.",
    });
    return [];
  }

  if (multiMode.length === 0) {
    // Amendment 1 §D: §6's rule is against guessing *composition*, not against naming. Writing
    // no themes here would leave the manifest useless to Phase 8's export, which globs by theme.
    entries.push({
      kind: "theme-composition",
      reason: "synthesized-default",
      message: `No collection has more than one mode, so there is exactly one possible composition. Generated a single theme over all ${tokenSetOrder.length} set${tokenSetOrder.length === 1 ? "" : "s"}; the name "${DEFAULT_THEME_NAME}" was invented by import and is safe to rename.`,
    });
    return [{ name: DEFAULT_THEME_NAME, selectedTokenSets: tokenSetOrder.slice() }];
  }

  entries.push({
    kind: "theme-composition",
    reason: "ambiguous",
    message: `${multiMode.length} collections have more than one mode (${multiMode.map((collection) => `"${collection.name}"`).join(", ")}), so which mode combinations are real themes is a product question, not something import can infer. No themes were generated — see ADR-0002 §6.`,
  });
  return [];
}

function orderSets(sets: string[], tokenSetOrder: string[]): string[] {
  const wanted = new Set(sets);
  return tokenSetOrder.filter((set) => wanted.has(set));
}

function buildCandidates(
  survivors: PreparedVariable[],
  subtypeByVariableId: Map<string, SubtypeTag>
): SubtypeCandidate[] {
  const candidates: SubtypeCandidate[] = [];

  for (const item of survivors) {
    const tokenType = TYPE_MAP[item.variable.resolvedType];
    if (tokenType !== "number" && tokenType !== "string") continue;

    const tag = subtypeByVariableId.get(item.variable.id) ?? {};
    candidates.push({
      variableId: item.variable.id,
      variableName: item.variable.name,
      collectionName: item.collection.name,
      tokenType,
      subtype: tag.subtype,
      subtypeSource: tag.subtypeSource ?? "default",
      scopes: item.variable.scopes.slice().sort(compareKeys),
      // Only the importer's own guesses block: `default` means "imported, but nobody confirmed
      // the type" (ADR §3). Strings are listed so `easing` can be tagged — never auto-detectable
      // (PRD §6.1) — but an untagged string is a legitimate outcome, so they do not block.
      needsConfirmation: tokenType === "number" && tag.subtypeSource === "default",
      sampleValue: sampleValueOf(item.variable),
    });
  }

  return candidates.sort(
    (a, b) => compareKeys(a.collectionName, b.collectionName) || compareKeys(a.variableName, b.variableName)
  );
}

function sampleValueOf(variable: VariableSnapshot): string | number | boolean | null {
  for (const modeId of Object.keys(variable.valuesByMode).sort(compareKeys)) {
    const value = variable.valuesByMode[modeId];
    if (isAlias(value)) return `→ ${value.id}`;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  }
  return null;
}

function compareEntries(a: ReportEntry, b: ReportEntry): number {
  return (
    compareKeys(a.kind, b.kind) ||
    compareKeys(a.reason, b.reason) ||
    compareKeys(a.path ?? "", b.path ?? "") ||
    compareKeys(a.set ?? "", b.set ?? "") ||
    compareKeys(a.message, b.message)
  );
}
