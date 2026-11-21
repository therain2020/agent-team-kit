import {
  type InstalledSource,
  type SourceCandidate,
  SourceManufactureError,
  type SourceProposal,
  type SourceRetirementProposal,
  type SourceYieldHealth,
  listInstalledSources,
  listRetirementProposals,
  listSourceProposals,
  searchSources,
} from "@kit/source";
import { NextResponse } from "next/server";
import { ensureStoreSchema, getStore } from "./store";

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

export interface SourceProposalSurface {
  proposals: SourceProposal[];
  retirements: SourceRetirementProposal[];
  health: SourceYieldHealth[];
}

/** Per-source yield read model used by retirement proposals (98 I-5). */
export async function loadSourceHealth(): Promise<SourceYieldHealth[]> {
  await ensureStoreSchema();
  const rows = await getStore().information.listSourceHealth();
  return rows.map((row) => ({
    sourceId: row.sourceId,
    runs: row.runs,
    successes: row.successes,
    failures: row.failures,
    itemsCollected: row.itemsCollected,
    eventsCreated: row.eventsCreated,
    consecutiveFailures: row.consecutiveFailures,
    degraded: row.degraded,
  }));
}

export async function loadSourceProposalSurface(): Promise<SourceProposalSurface> {
  // The source library must still render (and stored proposals stay reviewable)
  // when the store is unavailable; yield signals simply go quiet.
  const health = await loadSourceHealth().catch(() => []);
  const [proposals, retirements] = await Promise.all([
    listSourceProposals(),
    listRetirementProposals({ health }),
  ]);
  return { proposals, retirements, health };
}

export function sourceErrorResponse(error: unknown): NextResponse {
  if (error instanceof SourceManufactureError) {
    return NextResponse.json(
      { error: error.message, code: error.code, issues: error.issues },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "source action failed" },
    { status: 500 },
  );
}
