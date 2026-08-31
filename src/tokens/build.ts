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
import { normalizePathKey, setTokenAtPath, slugify, splitVariableName, toDottedPath } from "./paths";
import { isAlias, isRgba, normalizeFloat, rgbaToHex, toReference } from "./values";
import { resolveSubtype, type SubtypeTag } from "./subtype";
import { detectCollisions, type PreparedVariable } from "./collisions";

const TOKENS_DIR = "tokens";

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

  const { collections, excludedCollectionIds } = resolveCollections(snapshot.collections, entries);
  const collectionsById = new Map<string, CollectionSnapshot>();
  for (const collection of collections) collectionsById.set(collection.id, collection);

  // Names for alias resolution come from every variable in the file, including ones that later
  // lose a collision — a reference should name what Figma actually points at.
  const namesById = new Map<string, string>();
  for (const variable of snapshot.variables) namesById.set(variable.id, variable.name);
  for (const id of Object.keys(snapshot.aliasTargetNames)) {
    if (!namesById.has(id)) namesById.set(id, snapshot.aliasTargetNames[id]);
  }

  const prepared = prepareVariables(snapshot.variables, collectionsById, excludedCollectionIds, entries);
  const collisions = detectCollisions(prepared);
  entries.push(...collisions.entries);

  // Every variable that will not appear in the output, for whatever reason. An alias pointing
  // at one of these still gets its reference written (the name is real in Figma) but is
  // flagged, so a dangling reference never reaches the repo unannounced.
  const notWritten = new Set<string>(collisions.excludedIds);
  const survivorIds = new Set(collisions.survivors.map((item) => item.variable.id));
  for (const variable of snapshot.variables) {
    if (!survivorIds.has(variable.id)) notWritten.add(variable.id);
  }

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

  const files: TokenFileOutput[] = [];
  const manifestCollections: ManifestCollection[] = [];
  const tokenSetOrder: string[] = [];
  let tokenCount = 0;

  for (const collection of collections) {
    const modes: ManifestMode[] = [];
    const collectionSlug = slugify(collection.name);
    const members = survivorsByCollection.get(collection.id) ?? [];

    for (const mode of collection.modes) {
      const setId = `${collection.name}/${mode.name}`;
      const file = `${collectionSlug}/${slugify(mode.name)}.json`;

      const tree = buildModeFile(members, collection, mode.modeId, setId, namesById, subtypeByVariableId, notWritten, entries);
      tokenCount += tree.tokenCount;

      files.push({ path: `${TOKENS_DIR}/${file}`, content: tree.root });
      modes.push({
        name: mode.name,
        slug: slugify(mode.name),
        set: setId,
        $figmaModeId: mode.modeId,
        file,
      });
      tokenSetOrder.push(setId);
    }

    manifestCollections.push({
      name: collection.name,
      slug: collectionSlug,
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

  const excludedCollectionIds = new Set<string>();
  for (const slug of Array.from(bySlug.keys()).sort(compareKeys)) {
    const group = bySlug.get(slug) as CollectionSnapshot[];
    if (group.length < 2) continue;
    const winner = group[0];
    for (const loser of group.slice(1)) excludedCollectionIds.add(loser.id);
    entries.push({
      kind: "collision",
      reason: "set-slug",
      message: `${group.length} collections slug to "${slug}" and would write to the same files. Kept "${winner.name}"; the others were not written.`,
      path: slug,
      participants: group.map((collection) => ({
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

function prepareVariables(
  variables: VariableSnapshot[],
  collectionsById: Map<string, CollectionSnapshot>,
  excludedCollectionIds: Set<string>,
  entries: ReportEntry[]
): PreparedVariable[] {
  const prepared: PreparedVariable[] = [];

  for (const variable of variables) {
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

    const segments = splitVariableName(variable.name);
    if (segments.length === 0) {
      entries.push({
        kind: "unmappable-value",
        reason: "empty-path",
        message: `Variable ${variable.id} has a name that produces no token path ("${variable.name}"). Not written.`,
        participants: [participantOf(variable, collection)],
      });
      continue;
    }

    const path = toDottedPath(variable.name);
    prepared.push({
      variable,
      collection,
      path,
      segments,
      normalizedPath: normalizePathKey(path),
    });
  }

  return prepared;
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

function buildModeFile(
  members: PreparedVariable[],
  collection: CollectionSnapshot,
  modeId: string,
  setId: string,
  namesById: Map<string, string>,
  subtypeByVariableId: Map<string, SubtypeTag>,
  notWritten: Set<string>,
  entries: ReportEntry[]
): ModeFileResult {
  const root: TokenGroup = {};
  let tokenCount = 0;

  for (const item of members) {
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

    const tokenType = TYPE_MAP[item.variable.resolvedType];
    const converted = convertValue(raw, tokenType, namesById, notWritten);
    if (!converted.ok) {
      entries.push({
        kind: "unmappable-value",
        reason: converted.reason,
        message: `Variable "${item.variable.name}" (${setId}): ${converted.message} Not written.`,
        path: item.path,
        set: setId,
        participants: [participantOf(item.variable, collection)],
      });
      continue;
    }

    for (const warning of converted.warnings) {
      entries.push({
        kind: "unmappable-value",
        reason: warning.reason,
        message: `Variable "${item.variable.name}" (${setId}): ${warning.message}`,
        path: item.path,
        set: setId,
        participants: [participantOf(item.variable, collection)],
      });
    }

    const tag = subtypeByVariableId.get(item.variable.id) ?? {};
    const token: Token = {
      $type: tokenType,
      $value: converted.value,
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

interface ConversionWarning {
  reason: string;
  message: string;
}

type ConversionResult =
  | { ok: true; value: string | number | boolean; warnings: ConversionWarning[] }
  | { ok: false; reason: string; message: string };

/** ADR §2 and §3: aliases become `{dot.path}` references, everything else a literal. */
export function convertValue(
  raw: VariableValueSnapshot,
  tokenType: TokenType,
  namesById: Map<string, string>,
  notWritten: Set<string>
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
    const warnings: ConversionWarning[] = [];
    if (notWritten.has(raw.id)) {
      warnings.push({
        reason: "alias-target-skipped",
        message: `references "${targetName}", which was not written to the token files (it lost a collision, or its type is unsupported), so the reference will not resolve until that is fixed in Figma.`,
      });
    }
    return { ok: true, value: toReference(targetName), warnings };
  }

  if (tokenType === "color") {
    if (!isRgba(raw)) {
      return { ok: false, reason: "type-mismatch", message: `is a COLOR variable whose value is not an RGB(A) object.` };
    }
    return { ok: true, value: rgbaToHex(raw), warnings: [] };
  }

  if (tokenType === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return { ok: false, reason: "type-mismatch", message: `is a FLOAT variable whose value is not a finite number.` };
    }
    return { ok: true, value: normalizeFloat(raw), warnings: [] };
  }

  if (tokenType === "boolean") {
    if (typeof raw !== "boolean") {
      return { ok: false, reason: "type-mismatch", message: `is a BOOLEAN variable whose value is not a boolean.` };
    }
    return { ok: true, value: raw, warnings: [] };
  }

  if (typeof raw !== "string") {
    return { ok: false, reason: "type-mismatch", message: `is a STRING variable whose value is not a string.` };
  }
  return { ok: true, value: raw, warnings: [] };
}

/**
 * ADR §6 — themes are generated only for the unambiguous case: exactly one multi-mode
 * collection, combined with the single mode of every single-mode collection. Anything else
 * writes no themes and files a report entry rather than guessing a cartesian product.
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

  if (multiMode.length === 0) {
    entries.push({
      kind: "unmappable-value",
      reason: "theme-composition-unnamed",
      message:
        collections.length === 0
          ? "No variable collections were imported, so no themes were generated."
          : "No collection has more than one mode, so there is nothing to switch between and no theme name to derive. No themes were generated; compose them by hand or wait for Phase 7.",
      participants: [],
    });
    return [];
  }

  entries.push({
    kind: "unmappable-value",
    reason: "theme-composition-ambiguous",
    message: `${multiMode.length} collections have more than one mode (${multiMode.map((collection) => `"${collection.name}"`).join(", ")}), so which mode combinations are real themes is a product question, not something import can infer. No themes were generated — see ADR-0002 §6.`,
    participants: [],
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
