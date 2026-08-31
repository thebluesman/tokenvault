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

/** The `{dot.path}` reference form of an alias target's `/`-delimited name (ADR §2). */
export function toReference(targetName: string): string {
  const dotted = targetName
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(".");
  return `{${dotted}}`;
}
