// The only module that talks to the Figma Styles API — ADR-0003 §7.
//
// Same boundary precedent as src/figma/scan.ts: flatten the live API objects into a plain-data
// `StylesSnapshot` so that src/tokens/buildStyles.ts — where all the schema decisions live —
// stays pure and testable.
//
// Nothing here interprets a value. Paint types, effect types and grid patterns are copied across
// as raw strings so that a kind Figma adds later reaches the report as an explicit non-import
// rather than being silently coerced into something it is not (PRD §11).

import type {
  EffectSnapshot,
  EffectStyleSnapshot,
  GridStyleSnapshot,
  LayoutGridSnapshot,
  PaintSnapshot,
  PaintStyleSnapshot,
  RgbaSnapshot,
  StylesSnapshot,
  TextStyleSnapshot,
} from "../tokens/types";

function base(style: BaseStyle) {
  return {
    id: style.id,
    key: style.key,
    name: style.name,
    description: style.description,
  };
}

function toRgba(color: RGB | RGBA): RgbaSnapshot {
  return { r: color.r, g: color.g, b: color.b, a: "a" in color ? color.a : undefined };
}

function toPaint(paint: Paint, boundVariableIds: Set<string>): PaintSnapshot {
  const snapshot: PaintSnapshot = {
    type: paint.type,
    // Figma documents both as defaulting to true/1 when absent.
    visible: paint.visible !== false,
    opacity: paint.opacity === undefined ? 1 : paint.opacity,
  };

  if (paint.type === "SOLID") {
    snapshot.color = toRgba(paint.color);
    const bound = paint.boundVariables?.color;
    if (bound) {
      snapshot.boundVariableId = bound.id;
      boundVariableIds.add(bound.id);
    }
  }

  return snapshot;
}

function toEffect(effect: Effect, boundVariableIds: Set<string>): EffectSnapshot {
  const snapshot: EffectSnapshot = {
    type: effect.type,
    visible: effect.visible !== false,
    radius: "radius" in effect ? effect.radius : 0,
    boundVariables: {},
  };

  if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
    snapshot.color = toRgba(effect.color);
    snapshot.offsetX = effect.offset.x;
    snapshot.offsetY = effect.offset.y;
    snapshot.spread = effect.spread;
  }

  const bound = (effect as { boundVariables?: Record<string, VariableAlias> }).boundVariables;
  if (bound) {
    for (const field of Object.keys(bound)) {
      const alias = bound[field];
      if (!alias) continue;
      snapshot.boundVariables[field] = alias.id;
      boundVariableIds.add(alias.id);
    }
  }

  return snapshot;
}

function toLayoutGrid(grid: LayoutGrid): LayoutGridSnapshot {
  const snapshot: LayoutGridSnapshot = {
    pattern: grid.pattern,
    visible: grid.visible !== false,
  };

  if (grid.pattern === "GRID") {
    snapshot.sectionSize = grid.sectionSize;
    return snapshot;
  }

  snapshot.alignment = grid.alignment;
  snapshot.count = grid.count;
  snapshot.gutterSize = grid.gutterSize;
  // Absent on a STRETCH grid, and absent keys stay absent in the token (ADR-0003 §3).
  if (grid.sectionSize !== undefined) snapshot.sectionSize = grid.sectionSize;
  if (grid.offset !== undefined) snapshot.offset = grid.offset;
  return snapshot;
}

function toTextStyle(style: TextStyle, boundVariableIds: Set<string>): TextStyleSnapshot {
  const boundVariables: Record<string, string> = {};
  const bound = style.boundVariables;
  if (bound) {
    for (const field of Object.keys(bound)) {
      const alias = (bound as Record<string, VariableAlias | undefined>)[field];
      if (!alias) continue;
      boundVariables[field] = alias.id;
      boundVariableIds.add(alias.id);
    }
  }

  return {
    ...base(style),
    fontFamily: style.fontName.family,
    fontStyle: style.fontName.style,
    fontSize: style.fontSize,
    letterSpacing: { value: style.letterSpacing.value, unit: style.letterSpacing.unit },
    lineHeight:
      style.lineHeight.unit === "AUTO"
        ? { unit: "AUTO" }
        : { value: style.lineHeight.value, unit: style.lineHeight.unit },
    textDecoration: style.textDecoration,
    textCase: style.textCase,
    leadingTrim: style.leadingTrim,
    textWrapStyle: style.textWrapStyle,
    paragraphIndent: style.paragraphIndent,
    paragraphSpacing: style.paragraphSpacing,
    listSpacing: style.listSpacing,
    hangingPunctuation: style.hangingPunctuation,
    hangingList: style.hangingList,
    boundVariables,
  };
}

/**
 * Reads every local paint, text, effect and grid style in the current file.
 *
 * The four reads are independent round trips, so they are issued together rather than awaited one
 * at a time — the same reason `scanFile` batches its alias lookups.
 *
 * Variables bound by a style are resolved to names here for the same reason `scanFile` resolves
 * library alias targets: a binding whose target cannot be named cannot be written as a reference,
 * and the conversion layer needs to be able to tell "unnameable" from "not bound at all".
 */
export async function scanStyles(): Promise<StylesSnapshot> {
  const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
    figma.getLocalGridStylesAsync(),
  ]);

  const boundVariableIds = new Set<string>();

  const paint: PaintStyleSnapshot[] = paintStyles.map((style) => ({
    ...base(style),
    paints: style.paints.map((item) => toPaint(item, boundVariableIds)),
  }));

  const text: TextStyleSnapshot[] = textStyles.map((style) => toTextStyle(style, boundVariableIds));

  const effect: EffectStyleSnapshot[] = effectStyles.map((style) => ({
    ...base(style),
    effects: style.effects.map((item) => toEffect(item, boundVariableIds)),
  }));

  const grid: GridStyleSnapshot[] = gridStyles.map((style) => ({
    ...base(style),
    layoutGrids: style.layoutGrids.map(toLayoutGrid),
  }));

  const boundVariableNames: Record<string, string> = {};
  await Promise.all(
    Array.from(boundVariableIds).map(async (id) => {
      try {
        const variable = await figma.variables.getVariableByIdAsync(id);
        if (variable) boundVariableNames[id] = variable.name;
      } catch {
        // Deleted, or a library the file can no longer reach. Left out, so the conversion writes
        // the literal value and reports the lost link rather than inventing a reference.
      }
    })
  );

  return { paint, text, effect, grid, boundVariableNames };
}
