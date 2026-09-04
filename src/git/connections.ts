// N connections and their credentials — ADR-0008 §1, §2.
//
// ADR-0006 stored one repo, one branch, one PAT. This is that record given an id and multiplied,
// with two things that are *not* multiplied: there is no primary connection (§1 — Figma and the
// local tree are where tokens are authored, and no connected repo has earned the title), and the
// PAT is shared by default (§2), with a per-connection override for repos the shared token cannot
// reach.
//
// Everything here is pure. The `clientStorage` calls stay in `code.ts` for the same reason
// `state.ts` gives: the shape logic is the part worth unit-testing, and `clientStorage` is
// sandbox-only.
//
//   tokenvault:github                       { connections, routingRules, patLastFour }
//   tokenvault:github-pat                    the shared PAT, alone
//   tokenvault:github-pat:<connection-id>    an override PAT — only for `mode: "own"`
//   tokenvault:sync:<file-id>:<connection-id> ADR-0006 §3's record, per repo

import type { RepoSettings } from "./types";
import type { RoutingRule } from "./routing";
import { normalizeTokensDir } from "./paths";
import { DEFAULT_TOKENS_DIR, PAT_KEY, SYNC_PREFIX, parseSettings } from "./state";
import { parseRoutingRules } from "./routing";

/**
 * Not a technical limit — §1. A status refresh costs one tree read per repo and the Review & push
 * screen has to stay legible with a diff per repo; ten keeps a refresh at ten calls against a
 * 5,000/hr budget and a review screen at ten top-level groups.
 */
export const MAX_ENABLED_CONNECTIONS = 10;

export type ConnectionAuth =
  | { mode: "shared" }
  /** A repo outside the shared fine-grained token's resource owner, so it carries its own (§2). */
  | { mode: "own"; patLastFour?: string };

export interface Connection {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative, trailing slash stripped. Per connection: repos genuinely differ (§1). */
  tokensDir: string;
  enabled: boolean;
  auth: ConnectionAuth;
}

export interface MultiRepoSettings {
  connections: Connection[];
  /** Not committed — they change *where a copy goes*, not what the tree contains (§5). */
  routingRules: RoutingRule[];
  /** The shared PAT's last four characters, and the only part of it ever rendered. */
  patLastFour?: string;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/**
 * Where a connection's credential lives.
 *
 * The shared token and every override are separate keys, which is the whole reason rotating one
 * cannot disturb another (§2). A connection on `shared` has no key of its own at all — an unused
 * key holding a secret is a secret nobody can see to revoke.
 */
export function patKeyFor(connection: Connection): string {
  return connection.auth.mode === "own" ? `${PAT_KEY}:${connection.id}` : PAT_KEY;
}

/** ADR-0006 §3's sync record, now per (file, connection) — §6. */
export function connectionSyncKey(fileId: string, connectionId: string): string {
  return `${SYNC_PREFIX}${fileId}:${connectionId}`;
}

/**
 * Override keys that should no longer exist, given the settings about to be saved.
 *
 * Switching a connection from `own` back to `shared` deletes its override, and so does deleting
 * the connection (§2). Computed from the *previous* settings rather than by scanning storage,
 * because `clientStorage` has no key enumeration.
 */
export function orphanedPatKeys(previous: MultiRepoSettings, next: MultiRepoSettings): string[] {
  const keep = new Set(
    next.connections.filter((connection) => connection.auth.mode === "own").map((connection) => connection.id)
  );
  return previous.connections
    .filter((connection) => connection.auth.mode === "own" && !keep.has(connection.id))
    .map((connection) => `${PAT_KEY}:${connection.id}`);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Reads the settings blob, in either shape.
 *
 * A Phase 6 file has a single flat `{owner, repo, branch, tokensDir, patLastFour}` under the same
 * key. That is a valid one-connection configuration, and migrating it in place — rather than
 * asking the user to reconnect a repo they already connected — is what makes ADR-0008 an extension
 * of ADR-0006 rather than a reset.
 */
export function parseMultiSettings(stored: unknown): MultiRepoSettings {
  if (stored === null || typeof stored !== "object") return { connections: [], routingRules: [] };
  const record = stored as Record<string, unknown>;

  if (!Array.isArray(record.connections)) {
    const legacy = parseSettings(stored);
    if (legacy === null) return { connections: [], routingRules: [] };
    return {
      connections: [connectionFromSettings(legacy)],
      routingRules: [],
      patLastFour: legacy.patLastFour,
    };
  }

  const connections: Connection[] = [];
  const seen = new Set<string>();
  for (const item of record.connections) {
    const connection = parseConnection(item);
    // A duplicate id would make two connections share one sync record and one override key, so
    // the later one is dropped rather than allowed to shadow the earlier.
    if (connection === null || seen.has(connection.id)) continue;
    seen.add(connection.id);
    connections.push(connection);
  }

  return {
    connections,
    routingRules: parseRoutingRules(record.routingRules),
    patLastFour: typeof record.patLastFour === "string" ? record.patLastFour : undefined,
  };
}

/** ADR-0006's single connection, as one entry in the new list. */
export function connectionFromSettings(settings: RepoSettings, id = "c_default"): Connection {
  return {
    id,
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch,
    tokensDir: settings.tokensDir,
    enabled: true,
    auth: { mode: "shared" },
  };
}

/** The reverse, for the parts of Phase 6 that still take one repo at a time. */
export function settingsOfConnection(
  connection: Connection,
  patLastFour?: string
): RepoSettings {
  return {
    owner: connection.owner,
    repo: connection.repo,
    branch: connection.branch,
    tokensDir: connection.tokensDir,
    patLastFour: connection.auth.mode === "own" ? connection.auth.patLastFour : patLastFour,
  };
}

function parseConnection(item: unknown): Connection | null {
  if (item === null || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (typeof record.owner !== "string" || record.owner.length === 0) return null;
  if (typeof record.repo !== "string" || record.repo.length === 0) return null;

  const auth = record.auth as Record<string, unknown> | undefined;
  const own = auth !== undefined && auth !== null && auth.mode === "own";

  return {
    id: record.id,
    owner: record.owner,
    repo: record.repo,
    branch: typeof record.branch === "string" && record.branch.length > 0 ? record.branch : "main",
    tokensDir:
      typeof record.tokensDir === "string" ? normalizeTokensDir(record.tokensDir) : DEFAULT_TOKENS_DIR,
    // Absent means enabled: a connection the user added is one they meant to use, and a missing
    // key must never quietly stop pushing to a repo.
    enabled: record.enabled !== false,
    auth: own
      ? {
          mode: "own",
          patLastFour:
            typeof (auth as Record<string, unknown>).patLastFour === "string"
              ? ((auth as Record<string, unknown>).patLastFour as string)
              : undefined,
        }
      : { mode: "shared" },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The connections a push fans out to, capped at §1's ten. */
export function enabledConnections(settings: MultiRepoSettings): Connection[] {
  return settings.connections.filter((connection) => connection.enabled).slice(0, MAX_ENABLED_CONNECTIONS);
}

/** True when enabling one more would exceed the cap — what the settings panel disables on. */
export function atConnectionCap(settings: MultiRepoSettings): boolean {
  return settings.connections.filter((connection) => connection.enabled).length >= MAX_ENABLED_CONNECTIONS;
}

export function connectionById(settings: MultiRepoSettings, id: string): Connection | undefined {
  return settings.connections.find((connection) => connection.id === id);
}

/** `owner/repo@branch` — how a per-repo result or block names its repo (§6a). */
export function connectionLabel(connection: Connection): string {
  return `${connection.owner}/${connection.repo}@${connection.branch}`;
}

/**
 * Which credential a failure was using — §2.
 *
 * ADR-0006 §10 already requires 401 and 404 to be named rather than guessed. With two possible
 * credentials in play, *"GitHub rejected the token"* has to say **which**, or the user checks the
 * wrong thing in GitHub's UI and finds nothing wrong with it.
 */
export function describeCredential(connection: Connection, sharedLastFour?: string): string {
  if (connection.auth.mode === "own") {
    const suffix = connection.auth.patLastFour;
    return suffix ? `this repo's own token (…${suffix})` : "this repo's own token";
  }
  return sharedLastFour ? `the shared token (…${sharedLastFour})` : "the shared token";
}
