import {
  type SourceCandidateInput,
  type SourceCandidateSummary,
  type SourceManifestFacts,
  credentialHeaderNames,
  heuristicSourcePick,
  selectSourceCandidate,
  selectableCandidates,
  summarizeSourceCandidates,
  summarizeSourceRisk,
} from "@kit/job";
import { describe, expect, it } from "vitest";

function manifestFacts(
  overrides: Partial<SourceManifestFacts> = {},
): SourceManifestFacts {
  return {
    name: "blog",
    version: "1.0.0",
    type: "rss",
    endpoint: "https://example.com/feed.xml",
    headerNames: [],
    credentialHeaders: [],
    tos: "https://example.com/terms",
    attribution: "optional",
    ...overrides,
  };
}

function candidate(
  repo: string,
  overrides: Partial<SourceCandidateInput> = {},
): SourceCandidateInput {
  return {
    repo,
    htmlUrl: `https://github.com/${repo}`,
    description: "A community source adapter",
    stars: 120,
    topics: ["agent-team-source"],
    updatedAt: new Date().toISOString(),
    manifest: manifestFacts(),
    ...overrides,
  };
}

function summarize(
  repo: string,
  overrides: Partial<SourceCandidateInput> = {},
) {
  return summarizeSourceRisk(candidate(repo, overrides));
}

describe("source draft risk mapper", () => {
  it("flags credential-like header names without echoing values", () => {
    expect(
      credentialHeaderNames({
        Authorization: "Bearer sk-live-abcdefghijklmnop",
        "x-api-key": "abc",
        Accept: "application/rss+xml",
        "User-Agent": "agent-team-kit/0.1",
      }),
    ).toEqual(["Authorization", "x-api-key"]);
    expect(
      credentialHeaderNames({ "X-Custom": "0123456789abcdef0123456789abcdef" }),
    ).toEqual(["X-Custom"]);
    expect(credentialHeaderNames(undefined)).toEqual([]);
  });

  it("scores a clean https source with a ToS link as low risk", () => {
    const risk = summarize("acme/blog");
    expect(risk.level).toBe("low");
    expect(risk.network).toContain("example.com");
    expect(risk.endpoint).toBe("https://example.com/feed.xml");
    expect(risk.secret).toContain("未发现");
    expect(risk.tos).toContain("https://example.com/terms");
  });

  it("raises risk for credential headers and plaintext endpoints", () => {
    const credential = summarize("acme/private", {
      manifest: manifestFacts({
        headerNames: ["Authorization"],
        credentialHeaders: ["Authorization"],
      }),
    });
    expect(credential.level).toBe("high");
    expect(credential.auth).toContain("Authorization");
    expect(credential.secret).toContain("Authorization");

    const http = summarize("acme/plain", {
      manifest: manifestFacts({ endpoint: "http://example.com/feed.xml" }),
    });
    expect(http.level).toBe("high");
    expect(http.notes.join(" ")).toContain("HTTPS");
  });

  it("lowers confidence for missing manifests, stale repos and small stars", () => {
    const missing = summarize("acme/ghost", {
      manifest: undefined,
      manifestError: "manifest 404",
    });
    expect(missing.level).toBe("high");
    expect(missing.credibility).toContain("manifest 404");
    expect(missing.endpoint).toBe("");

    const stale = summarize("acme/old", {
      stars: 3,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(stale.level).toBe("medium");
    expect(stale.notes.join(" ")).toContain("一年");
  });

  it("keeps every candidate summary but only selectable ones for installs", () => {
    const summaries = summarizeSourceCandidates([
      candidate("acme/blog"),
      candidate("acme/ghost", {
        manifest: undefined,
        manifestError: "manifest 404",
      }),
    ]);
    expect(summaries).toHaveLength(2);
    expect(selectableCandidates(summaries).map((item) => item.repo)).toEqual([
      "acme/blog",
    ]);
  });
});

describe("source draft selection", () => {
  const summaries = summarizeSourceCandidates([
    candidate("acme/arxiv-feed", {
      description: "Daily arxiv paper feed",
      topics: ["agent-team-source", "arxiv"],
      stars: 40,
    }),
    candidate("acme/generic-rss", { stars: 900 }),
    candidate("acme/ghost", {
      manifest: undefined,
      manifestError: "manifest 404",
    }),
  ]);

  it("picks the candidate that matches the intent keywords", () => {
    const picked = heuristicSourcePick("daily arxiv papers", summaries);
    expect(picked.candidate?.repo).toBe("acme/arxiv-feed");
    expect(picked.reason).toContain("arxiv");
  });

  it("falls back to popularity when no keyword matches", () => {
    const picked = heuristicSourcePick("完全无关的一句话", summaries);
    expect(picked.candidate?.repo).toBe("acme/generic-rss");
    expect(picked.reason).toContain("热度");
  });

  it("returns an empty pick when the market is empty", () => {
    expect(heuristicSourcePick("anything", []).candidate).toBeNull();
    expect(
      heuristicSourcePick("anything", [summaries[2] as SourceCandidateSummary])
        .candidate,
    ).toBeNull();
  });

  it("accepts only repos that exist in the candidate list", () => {
    const accepted = selectSourceCandidate(
      { repo: "acme/arxiv-feed", reason: "matches papers" },
      summaries,
    );
    expect(accepted.repo).toBe("acme/arxiv-feed");
    expect(accepted.reason).toBe("matches papers");

    const fabricated = selectSourceCandidate(
      { repo: "evil/backdoor-source" },
      summaries,
    );
    expect(fabricated.repo).toBeNull();
    expect(fabricated.warnings).toHaveLength(1);

    const uninstallable = selectSourceCandidate(
      { repo: "acme/ghost" },
      summaries,
    );
    expect(uninstallable.repo).toBeNull();
  });
});
