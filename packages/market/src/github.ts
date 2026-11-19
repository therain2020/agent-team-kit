/**
 * GitHub plumbing shared by every market asset type (plan 88 §3.4, D-69).
 *
 * Search, commit pinning and raw file reads used to be duplicated per package
 * (`@kit/workshop` and `@kit/source`). This module is the one implementation:
 * adapters call `resolveCommit` to pin, `fetchRawFile` to read manifests and
 * files, and `githubJson` for the search API. Nothing here knows about a
 * particular manifest schema.
 */

export const USER_AGENT = "agent-team-kit/0.9";
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const SEARCH_CACHE_MS = 60_000;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

export interface GithubRequestOptions {
  token?: string;
  timeoutMs?: number;
}

/** Throws unless `repo` is a safe GitHub `owner/name` (no path traversal). */
export function assertRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new Error("repo must be owner/name");
  }
}

export function isCommitSha(value: string): boolean {
  return COMMIT_PATTERN.test(value);
}

/** Authenticated JSON request against the GitHub API with rate-limit surfacing. */
export async function githubJson<T>(
  url: string,
  options: GithubRequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      "GitHub API rate limit exceeded; set GITHUB_TOKEN to raise the limit",
    );
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** Read a raw file at an exact ref; `ref` is normally a pinned commit. */
export async function fetchRawFile(
  repo: string,
  ref: string,
  file: string,
  options: GithubRequestOptions = {},
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
  const headers: Record<string, string> = { "user-agent": USER_AGENT };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    throw new Error(
      `raw file ${response.status} ${response.statusText}: ${file}`,
    );
  }
  return response.text();
}

export async function defaultBranch(
  repo: string,
  options: GithubRequestOptions = {},
): Promise<string> {
  const payload = await githubJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${repo}`,
    options,
  );
  if (!payload.default_branch) {
    throw new Error(`cannot resolve default branch for ${repo}`);
  }
  return payload.default_branch;
}

/**
 * Resolve a ref (branch, tag or commit) to a pinned 40-char commit sha. The
 * response is validated so a malformed API answer can never be treated as a
 * pin.
 */
export async function resolveCommit(
  repo: string,
  ref: string,
  options: GithubRequestOptions = {},
): Promise<string> {
  const payload = await githubJson<{ sha?: string }>(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    options,
  );
  if (!payload.sha || !isCommitSha(payload.sha)) {
    throw new Error(`cannot resolve commit for ${repo}@${ref}`);
  }
  return payload.sha;
}
