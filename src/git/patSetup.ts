// Everything about *setting up* a personal access token — UX `onboarding-polish.md` §4.
//
// Pure by construction, like the rest of `src/git/` apart from `api.ts`: this module turns
// GitHub's answers into the three sentences the settings screen says, and knows nothing about the
// DOM or about `fetch`. The credential itself never reaches here — only what GitHub said *about*
// one (a permissions block and two response headers), which is why an expiry date is safe to hold
// as panel state while the token behind it is not.
//
// The section this exists for is §4.3. A token scoped to Contents: **Read** used to pass
// `[ Test connection ]`, populate the branch picker, connect, and fail hours later on the first
// push — after the user had scanned, confirmed a hundred subtypes, staged files and written a
// commit message. The permission is knowable at paste time, so it is named at paste time.

import type { RepoSettings } from "./types";

/** GitHub's new fine-grained token form — the page, not a doc about the page (§4.2). */
export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * How long before expiry the panel starts saying so — §4.4, §10 Q2.
 *
 * Seven, as recommended: long enough to act on, short enough not to be ambient. Thirty would light
 * the gear's `⚑` for 8% of every token's life, which is how a state mark stops being read.
 */
export const EXPIRY_WARNING_DAYS = 7;

// ---------------------------------------------------------------------------
// What GitHub told us about the token
// ---------------------------------------------------------------------------

/**
 * The raw signals one `GET /repos/{owner}/{repo}` carries about the credential that made it.
 *
 * Produced by `api.ts` and never rendered directly: every sentence below is written here from a
 * boolean and a date, in keeping with ADR-0006 §10's rule that GitHub's own words never reach the
 * screen.
 */
export interface TokenProbe {
  /**
   * The repo response's `permissions` block, when there is one.
   *
   * This is the signal §4.3 asks for. GitHub reports a token's effective access to a repository in
   * the legacy admin/push/pull triple, and a fine-grained token with Contents: Read comes back with
   * `push: false`. There is no endpoint that answers "may I write?" more directly without actually
   * writing, so this is the authoritative signal available — and when it is missing, `write` is
   * `"unknown"` and the copy downgrades from a verdict to a warning rather than guessing.
   */
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean; maintain?: boolean } | null;
  /** `github-authentication-token-expiration`, verbatim. Absent for a token that never expires. */
  expirationHeader?: string | null;
  /** `x-oauth-scopes` — classic tokens only. Recorded so a classic token is recognisable as one. */
  scopesHeader?: string | null;
}

/** Three answers, not two: *no* and *we couldn't tell* are different things to say (§4.3). */
export type WriteAccess = "yes" | "no" | "unknown";

export interface TokenCheck {
  write: WriteAccess;
  /** ISO 8601, or `null` when the token doesn't expire or GitHub didn't say. */
  expiresAt: string | null;
  /** True when GitHub sent an `x-oauth-scopes` header — i.e. this is a classic token. */
  classic: boolean;
}

export function analyzeToken(probe: TokenProbe): TokenCheck {
  const permissions = probe.permissions ?? null;
  let write: WriteAccess = "unknown";
  if (permissions !== null && typeof permissions === "object") {
    // `push` is the write bit; `admin` and `maintain` both imply it, and a repo response that
    // carries one without the other is a shape we have no reason to trust over the explicit flag.
    if (permissions.push === true || permissions.admin === true || permissions.maintain === true) {
      write = "yes";
    } else if (permissions.push === false) {
      write = "no";
    }
  }
  return {
    write,
    expiresAt: parseTokenExpiry(probe.expirationHeader ?? null),
    classic: (probe.scopesHeader ?? "").length > 0,
  };
}

/**
 * `github-authentication-token-expiration` → ISO, or `null`.
 *
 * GitHub sends `2026-12-03 21:44:31 UTC`. Parsed by hand rather than handed to `Date`, whose
 * treatment of that shape differs between engines — and a date parsed differently in the iframe
 * than in a test is exactly the bug this whole section exists to avoid producing.
 */
export function parseTokenExpiry(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  const spaced = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\s*(UTC|Z|[+-]\d{2}:?\d{2}))?$/.exec(
    text
  );
  if (spaced === null) return null;

  const [, year, month, day, hour, minute, second, zone] = spaced;
  // Range-checked rather than left to `Date.UTC`, which silently rolls month 13 into January of the
  // next year. A date we can't read has to come back `null` — a *wrong* expiry is worse than none,
  // because it either warns for nothing or stays quiet through the week that mattered.
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > 31 ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 60
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (zone !== undefined && zone !== "UTC" && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }

  const stamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  if (!Number.isFinite(stamp)) return null;
  return new Date(stamp - offsetMinutes * 60000).toISOString();
}

// ---------------------------------------------------------------------------
// Expiry as a state the panel holds — §4.4
// ---------------------------------------------------------------------------

export type ExpiryState = "none" | "soon" | "expired";

export interface Expiry {
  state: ExpiryState;
  /** Whole days remaining, floored. Negative once it has lapsed; `0` on the last day. */
  days: number;
}

export function expiryStatus(expiresAt: string | null | undefined, now: number): Expiry {
  if (expiresAt === null || expiresAt === undefined || expiresAt.length === 0) {
    return { state: "none", days: 0 };
  }
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return { state: "none", days: 0 };

  const ms = at - now;
  if (ms <= 0) return { state: "expired", days: Math.ceil(ms / 86400000) };

  const days = Math.floor(ms / 86400000);
  return { state: days < EXPIRY_WARNING_DAYS ? "soon" : "none", days };
}

/** `Your GitHub token expires in 5 days.` — the Repo tab's `.entry` headline (§4.4). */
export function expiryHeadline(expiry: Expiry): string | null {
  if (expiry.state === "expired") return "Your GitHub token has expired.";
  if (expiry.state !== "soon") return null;
  if (expiry.days === 0) return "Your GitHub token expires today.";
  return `Your GitHub token expires in ${expiry.days} day${expiry.days === 1 ? "" : "s"}.`;
}

export function expiryDetail(expiry: Expiry): string {
  return expiry.state === "expired"
    ? "Make a new one on GitHub and paste it in settings — pushes and pulls will fail until you do."
    : "Replace it before it lapses, or pushes will start failing.";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `3 Dec 2026` — read once, in the token field's result line (§4.3). */
export function formatExpiry(expiresAt: string): string {
  const at = new Date(expiresAt);
  if (!Number.isFinite(at.getTime())) return expiresAt;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// The three lines the token field says back — §4.3
// ---------------------------------------------------------------------------

export interface TokenVerdict {
  tone: "ok" | "warn";
  headline: string;
  /** Zero or more supporting lines, in order. */
  detail: string[];
  /** Whether to offer `[ Open GitHub ↗ ]` under the verdict. */
  offerGitHub: boolean;
}

/**
 * What the panel says the moment a token lands in the field.
 *
 * Three shapes, and the middle one is the whole point of §4.3. The third is the fallback the design
 * doc itself authorised: where the write permission cannot be established, this is a **warning, not
 * a verdict** — it says what we don't know rather than inventing an answer, and it still beats
 * discovering the same thing at first push.
 */
export function tokenVerdict(check: TokenCheck, repoLabel: string): TokenVerdict {
  const expires =
    check.expiresAt === null ? [] : [`Expires ${formatExpiry(check.expiresAt)}.`];

  if (check.write === "yes") {
    return {
      tone: "ok",
      headline: `This token can read and write ${repoLabel}.`,
      detail: expires,
      offerGitHub: false,
    };
  }

  if (check.write === "no") {
    return {
      tone: "warn",
      headline: `This token can read ${repoLabel}, but not write to it.`,
      // Names the step number: the checklist is three lines above and still on screen, which turns
      // a diagnosis into an instruction.
      detail: ["Step 2 above is the one to change — Contents needs Read and write, not Read."].concat(
        expires
      ),
      offerGitHub: true,
    };
  }

  return {
    tone: "warn",
    headline: `We couldn't confirm this token can push to ${repoLabel}.`,
    detail: [
      "GitHub didn't say, so you'll find out at your first push if it can't. Step 2 above is the one to check — Contents needs Read and write.",
    ].concat(expires),
    offerGitHub: true,
  };
}

// ---------------------------------------------------------------------------
// The checklist — §4.2
// ---------------------------------------------------------------------------

/** GitHub's own control names, not a paraphrase: the reader is about to go looking for them. */
export function patChecklist(repoLabel: string): string[] {
  return [
    `Repository access → Only select repositories → ${repoLabel}`,
    "Repository permissions → Contents → Read and write",
    "Expiration → your call. Tokenvault warns you a week before it lapses.",
  ];
}

/**
 * `[ Copy these 3 ]` — the one moment in the product where the instructions and the work happen in
 * different applications, and a checklist you cannot see is not a checklist (§4.2).
 */
export function patChecklistText(repoLabel: string): string {
  const steps = patChecklist(repoLabel)
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  return `Make a GitHub fine-grained token for Tokenvault\n\n${steps}\n\n${NEW_TOKEN_URL}`;
}

// ---------------------------------------------------------------------------
// The status line — §4.5
// ---------------------------------------------------------------------------

export interface ConnectState {
  settings: RepoSettings | null;
  /** A token is stored, or one has been typed into the field and not yet saved. */
  hasToken: boolean;
  /** This file has a connection — a base was seeded. */
  connectedForFile: boolean;
  /** A repo was typed but not saved yet, so `settings` is still null while a repo exists. */
  draftRepo: boolean;
  failure: boolean;
  /** Whether anything has actually asked GitHub with this combination yet. */
  checked: boolean;
}

/**
 * *"Same slot, same dot, one more sentence's worth of information for zero pixels"* — §4.5.
 *
 * A disabled `[ Test connection ]` explains nothing about why it is disabled. This says what is
 * missing instead, which is the only thing the user can act on.
 */
export function statusLine(state: ConnectState): string {
  const hasRepo = state.settings !== null || state.draftRepo;
  if (!hasRepo && !state.hasToken) return "● Needs a repo and a token";
  if (!hasRepo) return "● Needs a repo";
  if (!state.hasToken) return "● Needs a token";
  if (state.settings === null) return "● Not saved yet";
  if (state.failure) return "⚑ Connection problem";
  if (!state.connectedForFile) {
    return state.checked ? "● Not connected for this file" : "● Not checked yet";
  }
  return `● Connected · ${state.settings.branch}`;
}
