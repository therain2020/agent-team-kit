import { DEFAULT_INTEREST_PROFILE } from "@kit/core";
import { describe, expect, it } from "vitest";
import { draftProfile, parseSaveProfileBody } from "../lib/information";

const valid = {
  topics: ["ai"],
  entities: ["OpenAI"],
  exclusions: ["crypto"],
  thresholds: { relevance: 0.6, novelty: 0.4, urgency: 0.5 },
  dailyBudgetCny: 2,
  updatedBy: "human",
  rationale: "Track AI labs and keep crypto out.",
};

describe("interest profile web helpers (#128)", () => {
  it("accepts a complete save body and trims lists", () => {
    const parsed = parseSaveProfileBody({
      ...valid,
      topics: [" ai ", ""],
      expectedVersion: 1,
    });
    expect(parsed.topics).toEqual(["ai"]);
    expect(parsed.thresholds).toEqual({
      relevance: 0.6,
      novelty: 0.4,
      urgency: 0.5,
    });
    expect(parsed.expectedVersion).toBe(1);
    expect(parsed.updatedBy).toBe("human");
  });

  it("rejects missing thresholds, bad ratios and empty rationale", () => {
    expect(() =>
      parseSaveProfileBody({ ...valid, thresholds: undefined }),
    ).toThrow(/thresholds/);
    expect(() =>
      parseSaveProfileBody({
        ...valid,
        thresholds: { relevance: 1.5, novelty: 0.4, urgency: 0.5 },
      }),
    ).toThrow(/between 0 and 1/);
    expect(() => parseSaveProfileBody({ ...valid, rationale: "   " })).toThrow(
      /rationale/,
    );
    expect(() =>
      parseSaveProfileBody({ ...valid, updatedBy: "robot" }),
    ).toThrow(/updatedBy/);
  });

  it("drafts with the current profile as context and a heuristic label", () => {
    const draft = draftProfile("watch ai agents", {
      ...DEFAULT_INTEREST_PROFILE,
      topics: ["security"],
    });
    expect(draft.model).toBe("heuristic");
    expect(draft.topics).toEqual(
      expect.arrayContaining(["security", "ai", "agents"]),
    );
    expect(draft.rationale).toMatch(/^Heuristic draft/);
  });
});
