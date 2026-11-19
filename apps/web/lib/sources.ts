import {
  type InstalledSource,
  type SourceCandidate,
  listInstalledSources,
  searchSources,
} from "@kit/source";

export async function loadInstalledSources(): Promise<InstalledSource[]> {
  return listInstalledSources();
}

export async function searchSourceMarket(query?: string) {
  return searchSources({
    query,
    token: process.env.GITHUB_TOKEN,
    limit: 12,
  });
}

/**
 * Candidate search for the intent composer (#123): merge keyword hits with the
 * topic-wide list so a natural-language intent still receives real candidates
 * even when GitHub's repo search would return nothing. Deduplicated by repo.
 */
export async function searchSourceMarketForIntent(
  intent: string,
): Promise<SourceCandidate[]> {
  const keyword = intent
    .toLowerCase()
    .split(/[^a-z0-9+-]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 4)
    .join(" ");
  const token = process.env.GITHUB_TOKEN;
  const [topicHits, keywordHits] = await Promise.all([
    searchSources({ token, limit: 12 }),
    keyword
      ? searchSources({ query: keyword, token, limit: 12 })
      : Promise.resolve<SourceCandidate[]>([]),
  ]);
  const seen = new Set<string>();
  const merged: SourceCandidate[] = [];
  for (const candidate of [...keywordHits, ...topicHits]) {
    if (seen.has(candidate.repo)) {
      continue;
    }
    seen.add(candidate.repo);
    merged.push(candidate);
  }
  return merged;
}
