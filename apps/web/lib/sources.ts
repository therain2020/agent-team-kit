import {
  type InstalledSource,
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
