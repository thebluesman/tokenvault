// Builders for `FileSnapshot` fixtures, so tests read as data rather than boilerplate.

import type {
  CollectionSnapshot,
  FileSnapshot,
  Token,
  TokenGroup,
  VariableSnapshot,
  VariableValueSnapshot,
} from "../src/tokens/types";
import { isToken } from "../src/tokens/paths";

export function collection(
  id: string,
  name: string,
  modes: Array<[string, string]>
): CollectionSnapshot {
  return {
    id,
    name,
    defaultModeId: modes[0][0],
    modes: modes.map(([modeId, modeName]) => ({ modeId, name: modeName })),
  };
}

export function variable(
  id: string,
  name: string,
  collectionId: string,
  resolvedType: string,
  valuesByMode: Record<string, VariableValueSnapshot>,
  options: { scopes?: string[]; description?: string } = {}
): VariableSnapshot {
  return {
    id,
    name,
    collectionId,
    resolvedType,
    scopes: options.scopes ?? ["ALL_SCOPES"],
    description: options.description ?? "",
    valuesByMode,
  };
}

export function alias(id: string): VariableValueSnapshot {
  return { type: "VARIABLE_ALIAS", id };
}

export function snapshot(
  collections: CollectionSnapshot[],
  variables: VariableSnapshot[],
  aliasTargetNames: Record<string, string> = {}
): FileSnapshot {
  return {
    fileName: "Test File",
    fileKey: "testfilekey",
    collections,
    variables,
    aliasTargetNames,
  };
}

export const IMPORTED_AT = "2026-09-01T00:00:00.000Z";

/** Looks up a token by dotted path in a generated tree, or returns undefined. */
export function tokenAt(tree: TokenGroup, path: string): Token | undefined {
  let node: TokenGroup | Token | undefined = tree;
  for (const segment of path.split(".")) {
    if (node === undefined || isToken(node)) return undefined;
    node = (node as TokenGroup)[segment];
  }
  return node !== undefined && isToken(node) ? node : undefined;
}

/** The parsed content of one generated file, by repo-relative path. */
export function fileAt(
  files: Array<{ path: string; content: unknown }>,
  path: string
): TokenGroup {
  const found = files.find((file) => file.path === path);
  if (!found) throw new Error(`No generated file at ${path}. Got: ${files.map((f) => f.path).join(", ")}`);
  return found.content as TokenGroup;
}
