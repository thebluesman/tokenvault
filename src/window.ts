// The panel window's size — UX `panel-size-and-swatches.md` §3.
//
// Pure, and shared by both halves of the plugin because both have to agree about the same three
// numbers: the plugin clamps the *stored* size before `showUI`, and the UI clamps the size it
// *reports* after a drag. If only one side clamped, the other would keep handing back the number
// the first one just corrected (§3.3, §10).
//
// There is deliberately **no maximum**. Figma already clamps a plugin window to the viewport, and
// a ceiling we invent protects against nothing (§3.2).

export interface WindowSize {
  width: number;
  height: number;
}

/**
 * `640 × 720` — §3.2, settled in §9.1.
 *
 * Wide enough for the four-chip filter row and a `Review & push` diff row to breathe, tall enough
 * for ~30 tree rows instead of ~20, and chosen against a 900px-tall laptop viewport so Figma does
 * not clamp it on the smallest machine this runs on.
 */
export const DEFAULT_WINDOW_SIZE: WindowSize = { width: 640, height: 720 };

/**
 * `400 × 480` — deliberately **below** the old fixed 460, not at it (§3.2).
 *
 * 400 is where the filter chip row wraps to two lines, which is a graceful failure. Below it the
 * `Review & push` diff row stops being readable and there is no graceful version, so it is a floor
 * rather than a suggestion: §3.4's whole argument is that the minimum, not the default, is the
 * layout target.
 */
export const MIN_WINDOW_SIZE: WindowSize = { width: 400, height: 480 };

/**
 * A size the panel is allowed to open at.
 *
 * Takes anything — a parsed `clientStorage` blob, a number pair off a resize event — and answers
 * with a legal size. **A stored size is a request, not an instruction** (§3.3): a value below the
 * minimum clamps up, a non-finite or missing one falls back to the default, and an unreadable blob
 * is not distinguished from a missing one. There is nothing in a window size to recover, so it is
 * never quarantined the way the edit overlay is (§3.3, `error-states.md` §3).
 */
export function clampWindowSize(value: unknown): WindowSize {
  if (value === null || typeof value !== "object") return { ...DEFAULT_WINDOW_SIZE };
  const raw = value as { width?: unknown; height?: unknown };
  return {
    width: axis(raw.width, DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width),
    height: axis(raw.height, DEFAULT_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height),
  };
}

/** One axis: a finite number clamped up to the floor, or the default when it is not a number. */
function axis(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.round(value));
}

/**
 * How long a `resize` burst has to settle before anything acts on it — §3.3, §10.
 *
 * One number for both consumers, because they are coalescing the same burst: `main.ts` reports the
 * final size to the plugin (one `clientStorage` write per drag, not one per frame — ADR-0004 §1) and
 * `tokens.ts` rebuilds the tree when the reference budget moves with the width (§3.4). Two intervals
 * would mean two rebuild waves per drag, which is the stutter this exists to prevent.
 */
export const RESIZE_DEBOUNCE_MS = 250;
