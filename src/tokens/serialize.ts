// Deterministic JSON serialization — ADR-0002 §7.
//
// `JSON.stringify` cannot be used with a plain sort, because JavaScript objects enumerate
// integer-like keys first, in ascending numeric order, regardless of insertion order. A token
// group keyed by spacing steps (`"4"`, `"8"`, `"12"`) would therefore serialize in numeric
// order while `"base"` sorts after them — not the alphabetical order §7 requires, and not
// stable against a group gaining its first non-numeric sibling. So we emit keys ourselves.

/** Byte-comparison ordering. Deliberately not `localeCompare`, which is locale-dependent. */
export function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function serializeValue(value: unknown, indent: string): string {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + "  ";
    const items = value.map((item) => inner + serializeValue(item, inner));
    return "[\n" + items.join(",\n") + "\n" + indent + "]";
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // `undefined`-valued keys are omitted, matching JSON.stringify.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareKeys);
    if (keys.length === 0) return "{}";
    const inner = indent + "  ";
    const entries = keys.map(
      (key) => inner + JSON.stringify(key) + ": " + serializeValue(record[key], inner)
    );
    return "{\n" + entries.join(",\n") + "\n" + indent + "}";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number: ${String(value)}`);
    }
    // Avoid "-0" round-tripping to a different literal than 0.
    return Object.is(value, -0) ? "0" : String(value);
  }

  return JSON.stringify(value) ?? "null";
}

/** 2-space indent, alphabetically sorted keys at every level, trailing newline. */
export function stableStringify(value: unknown): string {
  return serializeValue(value, "") + "\n";
}
