import {
  type GithubRequestOptions,
  SEARCH_CACHE_MS,
  fetchRawFile,
  githubJson,
} from "./github";

/**
 * Generic GitHub-topic market search (plan 88 §3.4, D-69).
 *
 * The query/API/raw-manifest/caching loop is identical for every asset type;
 * only the manifest filename and its parser differ. Adapters pass a `parse`
 * callback and map the returned candidate into their own shape.
 */

export interface MarketCandidate<M> {
  repo: string;
  htmlUrl: string;
  description: string | null;
  stars: number;
  defaultBranch: string;
  topics: string[];
  updatedAt: string;
  manifest?: M;
  manifestError?: string;
}

export type MarketSearchCache<M> = Map<
  string,
  { expiresAt: number; candidates: MarketCandidate<M>[] }
>;

export interface MarketSearchOptions<M> extends GithubRequestOptions {
  topic: string;
  /** File to read from each repository, e.g. `workshop.yaml` or `source.yaml`. */
  manifestFile: string;
  query?: string;
  limit?: number;
  parse: (raw: string) => { manifest: M } | { error: string };
  cache?: MarketSearchCache<M>;
}

export function createMarketSearchCache<M>(): MarketSearchCache<M> {
  return new Map();
}

export async function searchMarket<M>(
  options: MarketSearchOptions<M>,
): Promise<MarketCandidate<M>[]> {
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 30);
  const query = [`topic:${options.topic}`, options.query ?? ""]
    .filter(Boolean)
    .join(" ");
  const cacheKey = `${options.manifestFile}:${query}:${limit}`;
  const cached = options.cache?.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.candidates;
  }

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query || options.topic,
  )}&sort=stars&order=desc&per_page=${limit}`;
  const payload = await githubJson<{
    items?: Array<{
      full_name: string;
      html_url: string;
      description: string | null;
      stargazers_count: number;
      default_branch: string;
      updated_at: string;
      topics?: string[];
    }>;
  }>(url, options);

  const candidates = await Promise.all(
    (payload.items ?? []).map(async (repo) => {
      const candidate: MarketCandidate<M> = {
        repo: repo.full_name,
        htmlUrl: repo.html_url,
        description: repo.description,
        stars: repo.stargazers_count,
        defaultBranch: repo.default_branch,
        topics: repo.topics ?? [],
        updatedAt: repo.updated_at,
      };
      try {
        const raw = await fetchRawFile(
          repo.full_name,
          repo.default_branch,
          options.manifestFile,
          options,
        );
        const parsed = options.parse(raw);
        if ("manifest" in parsed) {
          candidate.manifest = parsed.manifest;
        } else {
          candidate.manifestError = parsed.error;
        }
      } catch (error) {
        candidate.manifestError =
          error instanceof Error ? error.message : String(error);
      }
      return candidate;
    }),
  );

  options.cache?.set(cacheKey, {
    expiresAt: Date.now() + SEARCH_CACHE_MS,
    candidates,
  });
  return candidates;
}
