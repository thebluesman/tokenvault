// The CSS custom-properties target — issue #17, PRD §6.6.
//
// Style Dictionary does the transforming and formatting; this module's whole job is to hand it a
// tree it can read and to keep the output deterministic (ADR-0002 §7 — same input, byte-identical
// output, so a no-op push produces no diff).
//
// Three things here are deliberate:
//
//   1. **No file header.** Style Dictionary's default banner carries a generation timestamp, which
//      would make every run a diff. The provenance line the header would have carried is written by
//      `header()` instead, with no clock in it.
//   2. **`outputReferences: false`.** A reference is emitted as the value it resolves to, not as
//      `var(--other)`. Emitting `var()` chains would be prettier and would also mean a consumer's
//      cascade could override a token's *input* — a behaviour nobody has asked for and one that
//      cannot be taken back once shipped. Its own decision if a consumer ever wants it.
//   3. **Numbers stay unitless.** A `number` token carries no unit (ADR-0002 §3 puts unit handling
//      in Style Dictionary transforms, and nothing in this phase requires it), so `--space-4: 4`
//      is what the token actually says. Emitting `4px` would be inventing a unit the token does not
//      have, and a px assumption is wrong for line heights, opacities and ratios alike. A real unit
//      convention is a decision, not a default.
//
// Composite types are the one place where "CSS custom property" has no single honest answer.
// `shadow` has one — a `box-shadow` value — so it is transformed. `typography` and `grid` do not:
// they are several properties, and flattening them into sub-variables is a naming convention this
// phase has no consumer to validate against. They are skipped, counted, and named in the summary
// rather than emitted as `[object Object]`.

import StyleDictionary from "style-dictionary";
import type { TokenType } from "../tokens/types";
import type { ExportToken, SdGroup } from "./flatten";

/** Types with no single-value CSS form. Skipped for v1, reported rather than silently dropped. */
export const UNSUPPORTED_CSS_TYPES: TokenType[] = ["typography", "grid"];

export interface CssPartition {
  emit: ExportToken[];
  skipped: ExportToken[];
}

export function partitionForCss(tokens: ExportToken[]): CssPartition {
  const emit: ExportToken[] = [];
  const skipped: ExportToken[] = [];
  for (const entry of tokens) {
    if (UNSUPPORTED_CSS_TYPES.includes(entry.token.$type)) skipped.push(entry);
    else emit.push(entry);
  }
  return { emit, skipped };
}

// ---------------------------------------------------------------------------
// Value transforms for the shapes ADR-0002/§0003 store
// ---------------------------------------------------------------------------

interface DimensionLike {
  unit: string;
  value: number;
}

function isDimension(value: unknown): value is DimensionLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DimensionLike).unit === "string" &&
    typeof (value as DimensionLike).value === "number"
  );
}

/** `{ unit: "px", value: 12 }` → `12px`. Also accepts a bare number, which is already CSS-legal. */
function dimensionToCss(value: unknown): string {
  if (isDimension(value)) return `${value.value}${value.unit}`;
  return String(value);
}

interface ShadowLike {
  blur: unknown;
  color: unknown;
  inset: boolean;
  offsetX: unknown;
  offsetY: unknown;
  spread: unknown;
}

function isShadow(value: unknown): value is ShadowLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as ShadowLike;
  return (
    "offsetX" in candidate &&
    "offsetY" in candidate &&
    "blur" in candidate &&
    "spread" in candidate &&
    "color" in candidate
  );
}

/** CSS `box-shadow` order: `inset? offset-x offset-y blur spread color`. */
export function shadowToCss(value: ShadowLike): string {
  const parts = [
    dimensionToCss(value.offsetX),
    dimensionToCss(value.offsetY),
    dimensionToCss(value.blur),
    dimensionToCss(value.spread),
    String(value.color),
  ];
  return (value.inset === true ? ["inset"] : []).concat(parts).join(" ");
}

const DIMENSION_TRANSFORM = "tokenvault/css/dimension";
const SHADOW_TRANSFORM = "tokenvault/css/shadow";

let registered = false;

/**
 * Registers the two value transforms, once per process.
 *
 * Style Dictionary's registry is global and re-registering the same name throws, so a second theme
 * build in the same run must not register again.
 */
export function registerTransforms(): void {
  if (registered) return;
  registered = true;

  StyleDictionary.registerTransform({
    name: DIMENSION_TRANSFORM,
    type: "value",
    // Transitive, so it runs after a reference has been resolved to the object it points at.
    transitive: true,
    filter: (token) => isDimension(tokenValue(token)),
    transform: (token) => dimensionToCss(tokenValue(token)),
  });

  StyleDictionary.registerTransform({
    name: SHADOW_TRANSFORM,
    type: "value",
    transitive: true,
    filter: (token) => isShadow(tokenValue(token)),
    transform: (token) => shadowToCss(tokenValue(token) as ShadowLike),
  });
}

/** DTCG tokens carry `$value`; Style Dictionary mirrors it onto `value` for older formats. */
function tokenValue(token: { $value?: unknown; value?: unknown }): unknown {
  return token.$value !== undefined ? token.$value : token.value;
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

export interface CssBuildOptions {
  /** Written into the comment header, so a reader knows which theme a file is. */
  themeName: string;
  /** CSS selector the block is emitted under. `:root` unless a caller needs otherwise. */
  selector?: string;
}

/**
 * The header, with no clock in it.
 *
 * Every generated file has to say it is generated — a designer or a reviewer who opens
 * `exports/css/light.css` and edits it deserves to be told the edit will be overwritten.
 */
export function header(themeName: string): string {
  return [
    "/**",
    " * Generated by Tokenvault. Do not edit directly.",
    ` * Theme: ${themeName}`,
    " */",
    "",
  ].join("\n");
}

/** Runs one Style Dictionary build and returns the CSS, without touching the filesystem. */
export async function buildCss(tokens: SdGroup, options: CssBuildOptions): Promise<string> {
  registerTransforms();

  const dictionary = new StyleDictionary(
    {
      tokens: tokens as Record<string, unknown>,
      platforms: {
        css: {
          transforms: ["name/kebab", DIMENSION_TRANSFORM, SHADOW_TRANSFORM],
          files: [
            {
              destination: "tokens.css",
              format: "css/variables",
              options: {
                showFileHeader: false,
                outputReferences: false,
                selector: options.selector ?? ":root",
              },
            },
          ],
        },
      },
    },
    { verbosity: "silent" }
  );

  const files = await dictionary.formatPlatform("css");
  const body = files.length === 0 ? "" : files[0].output;
  return header(options.themeName) + body;
}
