// Builders for `FileSnapshot` and `StylesSnapshot` fixtures, so tests read as data rather than
// boilerplate.

import type {
  CollectionSnapshot,
  EffectSnapshot,
  EffectStyleSnapshot,
  FileScan,
  FileSnapshot,
  GridStyleSnapshot,
  LayoutGridSnapshot,
  PaintSnapshot,
  PaintStyleSnapshot,
  StylesSnapshot,
  TextStyleSnapshot,
  Token,
  TokenGroup,
  VariableSnapshot,
  VariableValueSnapshot,
} from "../src/tokens/types";
import type { FlatToken } from "../src/tokens/view";
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

// ---------------------------------------------------------------------------
// Styles (ADR-0003)
// ---------------------------------------------------------------------------

/** A visible solid paint. `alpha` is the colour's own alpha; `opacity` is the paint's. */
export function solid(
  hex: { r: number; g: number; b: number },
  options: { opacity?: number; alpha?: number; boundVariableId?: string; visible?: boolean } = {}
): PaintSnapshot {
  const paint: PaintSnapshot = {
    type: "SOLID",
    visible: options.visible ?? true,
    opacity: options.opacity ?? 1,
    color: { r: hex.r, g: hex.g, b: hex.b, a: options.alpha },
  };
  if (options.boundVariableId !== undefined) paint.boundVariableId = options.boundVariableId;
  return paint;
}

export function nonSolidPaint(type: string, visible = true): PaintSnapshot {
  return { type, visible, opacity: 1 };
}

export function paintStyle(
  id: string,
  name: string,
  paints: PaintSnapshot[],
  description = ""
): PaintStyleSnapshot {
  return { id, key: `key-${id}`, name, description, paints };
}

export function textStyle(
  id: string,
  name: string,
  overrides: Partial<Omit<TextStyleSnapshot, "id" | "key" | "name">> = {}
): TextStyleSnapshot {
  return {
    id,
    key: `key-${id}`,
    name,
    description: "",
    fontFamily: "Inter",
    fontStyle: "Regular",
    fontSize: 16,
    letterSpacing: { value: 0, unit: "PIXELS" },
    lineHeight: { value: 150, unit: "PERCENT" },
    textDecoration: "NONE",
    textCase: "ORIGINAL",
    leadingTrim: "NONE",
    textWrapStyle: "AUTO",
    paragraphIndent: 0,
    paragraphSpacing: 0,
    listSpacing: 0,
    hangingPunctuation: false,
    hangingList: false,
    boundVariables: {},
    ...overrides,
  };
}

export function shadow(
  type: "DROP_SHADOW" | "INNER_SHADOW",
  overrides: Partial<EffectSnapshot> = {}
): EffectSnapshot {
  return {
    type,
    visible: true,
    color: { r: 0, g: 0, b: 0, a: 0.16 },
    offsetX: 0,
    offsetY: 2,
    radius: 8,
    spread: 0,
    boundVariables: {},
    ...overrides,
  };
}

export function blur(type: "LAYER_BLUR" | "BACKGROUND_BLUR" = "LAYER_BLUR", radius = 4): EffectSnapshot {
  return { type, visible: true, radius, boundVariables: {} };
}

export function effectStyle(id: string, name: string, effects: EffectSnapshot[]): EffectStyleSnapshot {
  return { id, key: `key-${id}`, name, description: "", effects };
}

export function columnsGrid(overrides: Partial<LayoutGridSnapshot> = {}): LayoutGridSnapshot {
  return {
    pattern: "COLUMNS",
    visible: true,
    alignment: "STRETCH",
    count: 12,
    gutterSize: 16,
    offset: 24,
    ...overrides,
  };
}

export function gridStyle(id: string, name: string, layoutGrids: LayoutGridSnapshot[]): GridStyleSnapshot {
  return { id, key: `key-${id}`, name, description: "", layoutGrids };
}

export function styles(parts: Partial<StylesSnapshot> = {}): StylesSnapshot {
  return {
    paint: parts.paint ?? [],
    text: parts.text ?? [],
    effect: parts.effect ?? [],
    grid: parts.grid ?? [],
    boundVariableNames: parts.boundVariableNames ?? {},
  };
}

/** The combined Figma-side read the merge builder takes. */
export function scan(variables: FileSnapshot, stylesSnapshot: StylesSnapshot = styles()): FileScan {
  return { variables, styles: stylesSnapshot };
}

/** An empty Variables side, for tests that only care about styles. */
export function noVariables(): FileSnapshot {
  return snapshot([], []);
}

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

// ---------------------------------------------------------------------------
// Phase 5 — apply and drift (ADR-0005)
// ---------------------------------------------------------------------------

/** A Variables-derived token, keyed the way `targetOfToken` reads provenance. */
export function varToken(
  type: Token["$type"],
  value: unknown,
  figma: Record<string, unknown> = {},
  extras: Record<string, unknown> = {}
): Token {
  return {
    $type: type,
    $value: value as Token["$value"],
    $extensions: {
      "com.tokenvault": {
        figma: { variableId: "VariableID:1:1", modeId: "1:0", ...figma },
        ...extras,
      } as Token["$extensions"]["com.tokenvault"],
    },
  };
}

/** A Styles-derived token — the other half of the structurally discriminated provenance. */
export function styleToken(
  type: Token["$type"],
  value: unknown,
  figma: Record<string, unknown> = {}
): Token {
  return {
    $type: type,
    $value: value as Token["$value"],
    $extensions: {
      "com.tokenvault": {
        figma: { styleId: "S:abc", styleType: "PAINT", ...figma },
      } as Token["$extensions"]["com.tokenvault"],
    },
  };
}

/** One `FlatToken`, the unit the view model and the apply plan are both keyed by. */
export function flat(path: string, setId: string, token: Token): FlatToken {
  return { path, segments: path.split("."), setId, token };
}
