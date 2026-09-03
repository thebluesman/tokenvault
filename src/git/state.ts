// Sync settings and sync state — ADR-0006 §3.
//
// The functions here are pure: parsing, normalising and validating the three `clientStorage` values
// Phase 6 adds. The `clientStorage` calls themselves live in `code.ts`, because `clientStorage` is
// sandbox-only, and keeping the shape logic out of the sandbox is what makes it unit-testable.
//
// Three keys, and the split between them is a decision rather than an accident:
//
//   tokenvault:github        { owner, repo, branch, tokensDir, patLastFour }   user-scoped
//   tokenvault:github-pat    the PAT, alone                                    user-scoped
//   tokenvault:sync:<file>   { owner, repo, branch, baseCommitSha, blobShas }  file-scoped
//
// A credential and a repo belong to the person; a *connection* belongs to the Figma file, because
// two files can legitimately sync to two repos. The PAT is stored alone so it can be cleared
// without disturbing the settings around it.

import type { RepoSettings, SyncState } from "./types";
import { normalizeTokensDir } from "./paths";

export const SETTINGS_KEY = "tokenvault:github";
export const PAT_KEY = "tokenvault:github-pat";
export const SYNC_PREFIX = "tokenvault:sync:";

export function syncKey(fileId: string): string {
  return SYNC_PREFIX + fileId;
}

/** The default, and the folder `build.ts` already emits into. */
export const DEFAULT_TOKENS_DIR = "tokens";

/**
 * `owner/repo` out of whatever the user pasted — UX §5.2.
 *
 * *"Nobody has `owner/repo` on their clipboard; they have `https://github.com/owner/repo`."*
 * Accepting only the short form would make the panel's parsing the user's problem, so every shape
 * GitHub hands out is accepted and normalised to the short one, which is then what is shown back.
 */
export function parseRepo(raw: string): { owner: string; repo: string } | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const stripped = text
    .replace(/^git@github\.com:/i, "")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");

  const parts = stripped.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1];
  // GitHub's own rule, applied here so a typo fails in the panel rather than as a 404 the user then
  // has to tell apart from "the token can't see it" — which §11 says are indistinguishable.
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export function parseSettings(stored: unknown): RepoSettings | null {
  if (stored === null || typeof stored !== "object") return null;
  const record = stored as Partial<RepoSettings>;
  if (typeof record.owner !== "string" || record.owner.length === 0) return null;
  if (typeof record.repo !== "string" || record.repo.length === 0) return null;
  return {
    owner: record.owner,
    repo: record.repo,
    branch: typeof record.branch === "string" && record.branch.length > 0 ? record.branch : "main",
    tokensDir:
      typeof record.tokensDir === "string"
        ? normalizeTokensDir(record.tokensDir)
        : DEFAULT_TOKENS_DIR,
    patLastFour: typeof record.patLastFour === "string" ? record.patLastFour : undefined,
  };
}

export function parseSyncState(stored: unknown): SyncState | null {
  if (stored === null || typeof stored !== "object") return null;
  const record = stored as Partial<SyncState>;
  if (typeof record.owner !== "string" || typeof record.repo !== "string") return null;
  if (typeof record.branch !== "string" || typeof record.baseCommitSha !== "string") return null;
  if (typeof record.tokensDir !== "string" || record.tokensDir.length === 0) return null;

  const blobShas: Record<string, string> = {};
  const raw = record.blobShas;
  if (raw !== null && typeof raw === "object") {
    for (const path of Object.keys(raw as Record<string, unknown>)) {
      const sha = (raw as Record<string, unknown>)[path];
      if (typeof sha === "string" && sha.length > 0) blobShas[path] = sha;
    }
  }

  return {
    owner: record.owner,
    repo: record.repo,
    branch: record.branch,
    tokensDir: record.tokensDir,
    baseCommitSha: record.baseCommitSha,
    blobShas,
    at: typeof record.at === "string" ? record.at : "",
  };
}

/**
 * Whether a stored connection still describes the configured repo.
 *
 * Changing branch invalidates the sync state (§9) — *"a different branch is a different base"* —
 * and so does changing repo or owner. A changed tokens folder invalidates it for the same reason:
 * every blob SHA in `blobShas` is keyed to a repo path built from the *old* folder, so comparing it
 * against paths built from the new one would make every file misread as diverged. Rather than
 * deleting on every settings save, the state is checked for relevance on read: a user who switches
 * branch and back (or folder and back) has not lost anything they had, and a user who switches away
 * gets a base that correctly reads as absent.
 */
export function syncStateApplies(state: SyncState | null, settings: RepoSettings | null): boolean {
  if (state === null || settings === null) return false;
  return (
    state.owner === settings.owner &&
    state.repo === settings.repo &&
    state.branch === settings.branch &&
    state.tokensDir === settings.tokensDir
  );
}

/**
 * The four characters the settings field renders — ADR-0006 §1.
 *
 * Derived once, at save time, and stored *beside* the token rather than computed from it on demand,
 * so that rendering the field never requires the PAT to be read out of storage at all. Short or
 * empty tokens produce an empty string rather than leaking a larger fraction of a short secret.
 */
export function lastFour(token: string): string {
  const trimmed = token.trim();
  return trimmed.length >= 8 ? trimmed.slice(-4) : "";
}
