// Repo-path helpers shared by every git module.
//
// The token tree is emitted at `tokens/**` (ADR-0002, `build.ts`'s `TOKENS_DIR`), but the settings
// panel lets the user point Tokenvault at a different folder (UX §5.2), so nothing downstream may
// assume the literal prefix. These two functions are the whole translation layer between "the path
// the build emitted" and "the path in the repo".

/** What `build.ts` emits under. Not configurable — it is the shape of the generated tree. */
export const BUILD_PREFIX = "tokens/";

/** The one file that is never committed — ADR-0006 §5. */
export const IMPORT_REPORT_PATH = "tokens/$import-report.json";

/** `tokens/`, `/tokens`, `tokens` and `` all mean the same folder. Normalised to `tokens`. */
export function normalizeTokensDir(raw: string): string {
  return raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/** `tokens/theme/light.json` → `design/theme/light.json` when the folder is `design`. */
export function toRepoPath(buildPath: string, tokensDir: string): string {
  const dir = normalizeTokensDir(tokensDir);
  const rest = buildPath.startsWith(BUILD_PREFIX) ? buildPath.slice(BUILD_PREFIX.length) : buildPath;
  return dir.length === 0 ? rest : `${dir}/${rest}`;
}

/** The inverse, for reading a fetched tree back into build-shaped paths. `null` when outside. */
export function fromRepoPath(repoPath: string, tokensDir: string): string | null {
  const dir = normalizeTokensDir(tokensDir);
  if (dir.length === 0) return `${BUILD_PREFIX}${repoPath}`;
  const prefix = `${dir}/`;
  if (!repoPath.startsWith(prefix)) return null;
  return `${BUILD_PREFIX}${repoPath.slice(prefix.length)}`;
}

/**
 * Whether a repo path is inside the configured folder.
 *
 * The blast-radius promise in UX §5.2 — *"nothing outside this folder is ever touched"* — is
 * enforced here and by `base_tree` (ADR-0006 §8), not by care at each call site.
 */
export function inTokensDir(repoPath: string, tokensDir: string): boolean {
  return fromRepoPath(repoPath, tokensDir) !== null;
}

/** Only `.json` files under the folder are token files; anything else in there is somebody's. */
export function isTokenFilePath(repoPath: string, tokensDir: string): boolean {
  return inTokensDir(repoPath, tokensDir) && repoPath.endsWith(".json");
}
