// Figma variable value → DTCG `$value` conversion — ADR-0002 §2, §3.

import type { AliasSnapshot, RgbaSnapshot, VariableValueSnapshot } from "./types";

export function isAlias(value: VariableValueSnapshot): value is AliasSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AliasSnapshot).type === "VARIABLE_ALIAS" &&
    typeof (value as AliasSnapshot).id === "string"
  );
}

export function isRgba(value: VariableValueSnapshot): value is RgbaSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as RgbaSnapshot;
  return (
    typeof candidate.r === "number" &&
    typeof candidate.g === "number" &&
    typeof candidate.b === "number" &&
    (candidate.a === undefined || typeof candidate.a === "number")
  );
}

function channelToHex(channel: number): string {
  const clamped = Math.min(1, Math.max(0, channel));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * `#rrggbb`, or `#rrggbbaa` when alpha < 1 (ADR §3).
 *
 * Figma stores channels as 0–1 floats but its UI authors 8-bit hex, so the 8-bit round-trip is
 * exact in practice for anything a human typed (ADR §4).
 */
export function rgbaToHex(color: RgbaSnapshot): string {
  const alpha = color.a === undefined ? 1 : color.a;
  const base = `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
  return alpha >= 1 ? base : `${base}${channelToHex(alpha)}`;
}

/**
 * Recovers the decimal a human actually typed from Figma's float32 storage.
 *
 * Figma stores FLOAT variable values as 32-bit floats, so a variable set to `0.4` in the UI is
 * handed back as `0.4000000059604645`. Writing that straight into `$value` is technically the
 * "raw number" ADR §3 asks for, but it is noise no one authored: it makes every numeric token
 * unreadable and turns any Figma-side re-save into a spurious git diff, which is the opposite
 * of what §7 wants.
 *
 * The fix is exact rather than a rounding guess: find the shortest decimal whose float32
 * rounding is bit-identical to the stored value. If a human typed it, that decimal *is* what
 * they typed, and the value still round-trips back into Figma unchanged.
 */
export function normalizeFloat(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;

  const target = Math.fround(value);
  for (let precision = 1; precision <= 17; precision += 1) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.fround(candidate) === target) return candidate;
  }
  return value;
}

/** The `{dot.path}` reference form of an alias target's `/`-delimited name (ADR §2). */
export function toReference(targetName: string): string {
  const dotted = targetName
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(".");
  return `{${dotted}}`;
}
