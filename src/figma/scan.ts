// The only module that talks to the Figma Variables API.
//
// Its whole job is to flatten the live API objects into a plain-data `FileSnapshot` so that
// src/tokens/build.ts — where all the schema decisions live — stays pure and testable.

import type {
  AliasSnapshot,
  CollectionSnapshot,
  FileSnapshot,
  VariableSnapshot,
  VariableValueSnapshot,
} from "../tokens/types";

function isAliasValue(value: VariableValue): value is VariableAlias {
  return typeof value === "object" && value !== null && (value as VariableAlias).type === "VARIABLE_ALIAS";
}

function toSnapshotValue(value: VariableValue): VariableValueSnapshot {
  if (isAliasValue(value)) {
    const alias: AliasSnapshot = { type: "VARIABLE_ALIAS", id: value.id };
    return alias;
  }
  if (typeof value === "object" && value !== null && "r" in value) {
    const color = value as RGB | RGBA;
    return {
      r: color.r,
      g: color.g,
      b: color.b,
      a: "a" in color ? color.a : undefined,
    };
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  // MotionEasing and anything else Figma adds later: not representable in the Phase 2 schema.
  // Returning null routes it through the report as an unmappable value rather than crashing.
  return null;
}

/**
 * Reads every local collection, every mode, and every local variable in the current file.
 *
 * Alias targets that are not local (variables imported from a team library) are resolved by id
 * so their names can still be written as references, rather than being reported as unmappable.
 */
export async function scanFile(): Promise<FileSnapshot> {
  const [collections, variables] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);

  const collectionSnapshots: CollectionSnapshot[] = collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
  }));

  const localIds = new Set<string>();
  for (const variable of variables) localIds.add(variable.id);

  const variableSnapshots: VariableSnapshot[] = [];
  const aliasTargetIds = new Set<string>();

  for (const variable of variables) {
    const valuesByMode: Record<string, VariableValueSnapshot> = {};
    for (const modeId of Object.keys(variable.valuesByMode)) {
      const value = toSnapshotValue(variable.valuesByMode[modeId]);
      valuesByMode[modeId] = value;
      if (value !== null && typeof value === "object" && "type" in value && !localIds.has(value.id)) {
        aliasTargetIds.add(value.id);
      }
    }

    variableSnapshots.push({
      id: variable.id,
      name: variable.name,
      collectionId: variable.variableCollectionId,
      resolvedType: variable.resolvedType,
      scopes: variable.scopes.slice(),
      description: variable.description,
      valuesByMode,
    });
  }

  // Independent round trips — a file with heavy cross-collection aliasing can have many, and
  // awaiting them one at a time serializes the whole lot for no reason. Each settles into its
  // own key with its own catch, so there is nothing to race.
  const aliasTargetNames: Record<string, string> = {};
  await Promise.all(
    Array.from(aliasTargetIds).map(async (id) => {
      try {
        const target = await figma.variables.getVariableByIdAsync(id);
        if (target) aliasTargetNames[id] = target.name;
      } catch {
        // Unresolvable target (deleted, or a library the file can no longer reach). Left out, so
        // buildImport reports it as `alias-target-unknown` rather than writing a bogus reference.
      }
    })
  );

  return {
    fileName: figma.root.name,
    fileKey: figma.fileKey ?? "",
    collections: collectionSnapshots,
    variables: variableSnapshots,
    aliasTargetNames,
  };
}
