// Composes the Variables and Styles imports into one coherent token tree — ADR-0003 §5, §7.
//
// The two builders are deliberately kept apart and neither writes a file: each emits candidates
// plus its own report entries, and this module runs collision detection across the union, drops
// the losers, and serialises. That is the only way a collision can be cross-source at all, and it
// keeps "who wins" in one place rather than split across two builders.
//
// The Variables side is a special case of that shape rather than an exception to it: `build.ts`
// is pinned unchanged by ADR-0003 §7, so it still resolves its own same-source contests and
// produces its own files. What reaches the union from that side is therefore already a set of
// survivors — unique paths, no token/group clashes — so the pass below can only ever produce
// style-vs-style and cross-source entries, which is exactly what is left to decide.

import type {
  BuildOptions,
  FileScan,
  ImportReport,
  ImportResult,
  Manifest,
  ManifestStyleSet,
  ManifestTheme,
  ReportEntry,
  Token,
  TokenFileOutput,
  TokenGroup,
} from "./types";
import { compareKeys } from "./serialize";
import { isToken, setTokenAtPath } from "./paths";
import { buildImport } from "./build";
import { buildStyleTokens, STYLE_SETS, STYLES_DIR } from "./buildStyles";
import type { StyleCandidate } from "./buildStyles";
import {
  countInboundAliases,
  detectItemCollisions,
  participantOfItem,
  type CollisionItem,
} from "./collisions";

const TOKENS_DIR = "tokens";

export function buildMergedImport(scan: FileScan, options: BuildOptions): ImportResult {
  const variablesResult = buildImport(scan.variables, options);
  const entries: ReportEntry[] = variablesResult.report.entries.slice();

  // 1. The reserved directory. A Variables collection that slugs to `styles` would write into
  //    `tokens/styles/`, the same place the style sets live.
  const reserved = reserveStylesDirectory(variablesResult, entries);

  // 2. What the Variables side actually wrote, as source-agnostic candidates.
  const variableCandidates = variableItems(reserved.files, scan);
  const writtenVariablePaths = new Set(variableCandidates.map((item) => item.path));

  // 3. The Styles side. It needs the Variables result in hand: the mirror rule (§4) only fires
  //    on a Variable that was really written, and a bound paint needs its target's name.
  const variableNames = new Map<string, string>();
  for (const variable of scan.variables.variables) variableNames.set(variable.id, variable.name);
  for (const id of Object.keys(scan.variables.aliasTargetNames)) {
    if (!variableNames.has(id)) variableNames.set(id, scan.variables.aliasTargetNames[id]);
  }
  for (const id of Object.keys(scan.styles.boundVariableNames)) {
    if (!variableNames.has(id)) variableNames.set(id, scan.styles.boundVariableNames[id]);
  }

  const styles = buildStyleTokens(scan.styles, { variableNames, writtenVariablePaths });
  entries.push(...styles.entries);

  // 4. The shared collision pass, over both sources at once.
  const styleItems = styles.candidates.map(styleItem);
  const collisions = detectItemCollisions(variableCandidates.concat(styleItems));
  entries.push(...collisions.entries);

  const survivingStyles = styles.candidates.filter(
    (candidate) => !collisions.excludedKeys.has(styleKey(candidate))
  );

  // 5. Serialise the style sets, then the merged manifest and report.
  const styleFiles = buildStyleFiles(survivingStyles, entries);
  const styleSets: ManifestStyleSet[] = styleFiles.map((file) => file.set);
  const styleSetIds = styleSets.map((set) => set.set);

  const tokenSetOrder = reserved.manifest.tokenSetOrder.concat(styleSetIds);
  const manifest: Manifest = {
    // A new top-level key changes the contract for the Phase 8 export reader, so it is announced
    // rather than silently inferred (ADR-0003 §1). Every manifest this path writes is a v2 one,
    // whether or not the file happened to contain styles.
    version: 2,
    generatedBy: "tokenvault",
    tokenSetOrder,
    collections: reserved.manifest.collections,
    themes: reserved.manifest.themes.map((theme) => withStyleSets(theme, styleSetIds)),
  };
  if (styleSets.length > 0) manifest.styleSets = styleSets;

  const variableFiles = reserved.files.filter((file) => !file.path.startsWith(`${TOKENS_DIR}/$`));
  const styleTokens = styleFiles.reduce((total, file) => total + file.tokenCount, 0);
  const variableTokens = variableFiles.reduce(
    (total, file) => total + countTokens(file.content as TokenGroup),
    0
  );

  entries.sort(compareEntries);
  const partialTokens = entries.filter((entry) => entry.kind === "partial-token").length;

  const report: ImportReport = {
    version: 1,
    importedAt: options.importedAt,
    figmaFileKey: scan.variables.fileKey,
    counts: {
      tokens: variableTokens + styleTokens,
      flagged: entries.length,
      unconfirmedSubtypes: variablesResult.report.counts.unconfirmedSubtypes,
      styles: styles.counts.styles,
      partialTokens,
    },
    entries,
  };

  const files = variableFiles
    .concat(styleFiles.map((file) => ({ path: `${TOKENS_DIR}/${file.set.file}`, content: file.content })))
    .concat([
      { path: `${TOKENS_DIR}/$manifest.json`, content: manifest },
      { path: `${TOKENS_DIR}/$import-report.json`, content: report },
    ]);
  files.sort((a, b) => compareKeys(a.path, b.path));

  const modes = manifest.collections.reduce((total, collection) => total + collection.modes.length, 0);

  return {
    files,
    manifest,
    report,
    candidates: variablesResult.candidates,
    counts: {
      collections: manifest.collections.length,
      modes,
      variables: scan.variables.variables.length,
      tokens: variableTokens + styleTokens,
      flagged: entries.length,
      unconfirmedSubtypes: variablesResult.report.counts.unconfirmedSubtypes,
      styles: styles.counts.styles,
      styleSets: styleSets.length,
      styleTokens,
      partialTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// The reserved `styles/` directory — ADR-0003 §1
// ---------------------------------------------------------------------------

interface ReservedOutcome {
  files: TokenFileOutput[];
  manifest: Manifest;
}

/**
 * Evicts any Variables collection that would write into `tokens/styles/`.
 *
 * This is exactly the `set-slug` collision from ADR-0002 Amendment 1 §E, with a fixed winner:
 * the reserved directory wins, the collection is not written, and every participant is reported
 * as usual. It is enforced whether or not the file actually has styles — a directory whose
 * ownership flipped depending on unrelated content would be worse than one that is simply taken.
 */
function reserveStylesDirectory(result: ImportResult, entries: ReportEntry[]): ReservedOutcome {
  const clashing = result.manifest.collections.filter((collection) => collection.slug === STYLES_DIR);
  if (clashing.length === 0) return { files: result.files, manifest: result.manifest };

  const droppedSets = new Set<string>();
  const droppedFiles = new Set<string>();
  for (const collection of clashing) {
    for (const mode of collection.modes) {
      droppedSets.add(mode.set);
      droppedFiles.add(`${TOKENS_DIR}/${mode.file}`);
    }
  }

  entries.push({
    kind: "collision",
    reason: "set-slug",
    message: `${clashing.length} variable collection${clashing.length === 1 ? "" : "s"} (${clashing.map((collection) => `"${collection.name}"`).join(", ")}) slug to "${STYLES_DIR}", which is reserved for the imported Figma Styles. The style sets keep the directory; ${clashing.length === 1 ? "that collection was" : "those collections were"} not written. Rename ${clashing.length === 1 ? "it" : "them"} in Figma to import ${clashing.length === 1 ? "it" : "them"}.`,
    path: STYLES_DIR,
    winnerRule: "source-precedence",
    participants: clashing.map((collection) => ({
      // The contest is between a collection and a reserved directory, so variable identity is
      // empty — the precedent Amendment 1 §E set for collection participants.
      variableId: "",
      variableName: "",
      collectionId: collection.$figmaCollectionId,
      collectionName: collection.name,
      outcome: "skipped" as const,
    })),
  });

  const manifest: Manifest = {
    ...result.manifest,
    tokenSetOrder: result.manifest.tokenSetOrder.filter((set) => !droppedSets.has(set)),
    collections: result.manifest.collections.filter((collection) => collection.slug !== STYLES_DIR),
    themes: result.manifest.themes.map((theme) => ({
      name: theme.name,
      selectedTokenSets: theme.selectedTokenSets.filter((set) => !droppedSets.has(set)),
    })),
  };

  return { files: result.files.filter((file) => !droppedFiles.has(file.path)), manifest };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * The Variables tokens that were actually written, as collision candidates.
 *
 * Read back out of the generated trees rather than recomputed from the snapshot, so what enters
 * the contest is what is really on disk — a variable that lost an earlier contest, or had no
 * usable value, is not there to evict a style token that could have taken its place.
 *
 * One candidate per token path: the same variable produces one token per mode of its collection,
 * all at the same path, and a path is contested once.
 */
function variableItems(files: TokenFileOutput[], scan: FileScan): CollisionItem[] {
  const inbound = countInboundAliases(scan.variables.variables);
  const names = new Map<string, string>();
  for (const variable of scan.variables.variables) names.set(variable.id, variable.name);
  const collectionNames = new Map<string, string>();
  for (const collection of scan.variables.collections) collectionNames.set(collection.id, collection.name);

  const seen = new Set<string>();
  const items: CollisionItem[] = [];

  for (const file of files) {
    if (file.path.startsWith(`${TOKENS_DIR}/$`)) continue;

    walkTokens(file.content as TokenGroup, [], (token, segments) => {
      const figma = token.$extensions["com.tokenvault"].figma;
      const variableId = figma.variableId;
      if (variableId === undefined) return;

      const path = segments.join(".");
      const normalizedPath = path.toLowerCase();
      if (seen.has(normalizedPath)) return;
      seen.add(normalizedPath);

      items.push({
        key: `variable:${variableId}`,
        source: "variable",
        id: variableId,
        name: names.get(variableId) ?? path,
        containerId: figma.collectionId ?? "",
        containerName: collectionNames.get(figma.collectionId ?? "") ?? "",
        path,
        normalizedPath,
        inboundAliases: inbound.get(variableId) ?? 0,
      });
    });
  }

  return items;
}

function styleKey(candidate: StyleCandidate): string {
  return `style:${candidate.styleId}`;
}

function styleItem(candidate: StyleCandidate): CollisionItem {
  return {
    key: styleKey(candidate),
    source: "style",
    id: candidate.styleId,
    name: candidate.styleName,
    // A style token's namespace is owned by its set: styles have no collection, and the four
    // kinds are scanned and change independently (ADR-0003 §1).
    containerId: candidate.setId,
    containerName: candidate.setId,
    path: candidate.path,
    normalizedPath: candidate.normalizedPath,
    // Nothing can alias a style token, which is half of why cross-source contests need their own
    // rule rather than Amendment 1 §F's comparator (ADR-0003 §5).
    inboundAliases: 0,
  };
}

// ---------------------------------------------------------------------------
// Output assembly
// ---------------------------------------------------------------------------

interface StyleFile {
  set: ManifestStyleSet;
  content: TokenGroup;
  tokenCount: number;
}

/**
 * One file per style kind, written only when that kind has at least one importable style.
 *
 * Per-kind rather than one `styles.json`: the four kinds are scanned independently and change
 * independently, so a re-import that only touched effects should only diff `styles/effect.json` —
 * the same blast-radius argument ADR-0002 §1 used for splitting per mode.
 */
function buildStyleFiles(candidates: StyleCandidate[], entries: ReportEntry[]): StyleFile[] {
  const files: StyleFile[] = [];

  for (const definition of STYLE_SETS) {
    const members = candidates
      .filter((candidate) => candidate.kind === definition.kind)
      .sort((a, b) => compareKeys(a.path, b.path) || compareKeys(a.styleId, b.styleId));
    if (members.length === 0) continue;

    const root: TokenGroup = {};
    let tokenCount = 0;

    for (const member of members) {
      if (!setTokenAtPath(root, member.segments, member.token)) {
        // The collision pass should have caught anything that lands here; this is a net.
        entries.push({
          kind: "collision",
          reason: "path-blocked",
          message: `Token path "${member.path}" could not be written to ${definition.set} — the path is already occupied. Not written.`,
          path: member.path,
          set: definition.set,
          participants: [
            participantOfItem(
              {
                key: "",
                source: "style",
                id: member.styleId,
                name: member.styleName,
                containerId: definition.set,
                containerName: definition.set,
                path: member.path,
                normalizedPath: member.normalizedPath,
                inboundAliases: 0,
              },
              "skipped"
            ),
          ],
        });
        continue;
      }
      tokenCount += 1;
    }

    if (tokenCount === 0) continue;

    files.push({
      set: {
        file: definition.file,
        kind: definition.kind,
        name: definition.name,
        set: definition.set,
        slug: definition.slug,
      },
      content: root,
      tokenCount,
    });
  }

  return files;
}

/**
 * Style sets join every theme, in first position (ADR-0003 §1).
 *
 * Styles are mode-free, so they belong to every theme equally. First position means that if a
 * hand-authored override ever does land on the same path — import never generates one — the
 * Variables side wins by last-wins ordering, which matches Figma's own direction of travel.
 */
function withStyleSets(theme: ManifestTheme, styleSetIds: string[]): ManifestTheme {
  return {
    name: theme.name,
    selectedTokenSets: styleSetIds.concat(theme.selectedTokenSets),
  };
}

// ---------------------------------------------------------------------------

function walkTokens(
  node: TokenGroup,
  segments: string[],
  visit: (token: Token, segments: string[]) => void
): void {
  for (const key of Object.keys(node).sort(compareKeys)) {
    const child = node[key];
    if (child === null || typeof child !== "object") continue;
    if (isToken(child)) visit(child, segments.concat([key]));
    else walkTokens(child, segments.concat([key]), visit);
  }
}

function countTokens(tree: TokenGroup): number {
  let count = 0;
  walkTokens(tree, [], () => {
    count += 1;
  });
  return count;
}

/**
 * Report ordering, identical to build.ts's.
 *
 * Duplicated rather than exported from there because ADR-0003 §7 pins `build.ts` unchanged, and
 * a five-line comparator is a cheaper thing to repeat than a reopened file is to justify.
 */
function compareEntries(a: ReportEntry, b: ReportEntry): number {
  return (
    compareKeys(a.kind, b.kind) ||
    compareKeys(a.reason, b.reason) ||
    compareKeys(a.path ?? "", b.path ?? "") ||
    compareKeys(a.set ?? "", b.set ?? "") ||
    compareKeys(a.message, b.message)
  );
}
