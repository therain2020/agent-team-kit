import { describe, expect, it } from "vitest";
import { buildEvidenceSet, sourceDefinitionSchema } from "../src/index";

describe("evidence set", () => {
  it("assigns citation ids and dedupes by url", () => {
    const evidence = buildEvidenceSet(
      [
        {
          source: "hn",
          sourceId: "hn:1",
          title: "First",
          url: "https://example.com/a",
        },
        {
          source: "arxiv",
          sourceId: "arxiv:2",
          title: "Duplicate",
          url: "https://example.com/a",
        },
        {
          source: "github",
          sourceId: "gh:3",
          title: "Second",
          url: "https://example.com/b",
        },
      ],
      [],
      "2026-11-14T00:00:00.000Z",
    );

    expect(evidence.sources).toHaveLength(2);
    expect(evidence.sources[0]?.citationId).toBe("S1");
    expect(evidence.sources[1]?.citationId).toBe("S2");
    expect(evidence.generatedAt).toBe("2026-11-14T00:00:00.000Z");
  });

  it("validates a declarative source manifest", () => {
    const parsed = sourceDefinitionSchema.parse({
      apiVersion: "agentteam/source/v1",
      kind: "Source",
      metadata: {
        name: "example-feed",
        version: "1.0.0",
        description: "Example",
      },
      spec: {
        type: "rss",
        request: { url: "https://example.com/feed.xml" },
        limits: { maxItems: 5 },
      },
    });
    expect(parsed.metadata.name).toBe("example-feed");
    expect(
      sourceDefinitionSchema.safeParse({
        apiVersion: "agentteam/source/v1",
        kind: "Source",
        metadata: { name: "Bad Name", version: "1.0.0" },
        spec: { type: "rss", request: { url: "https://example.com" } },
      }).success,
    ).toBe(false);
  });
});
