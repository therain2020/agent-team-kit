import { describe, expect, it } from "vitest";
import {
  type IterationSignal,
  proposeImprovements,
  summarizeSignals,
} from "../src/signals";

function signal(
  domain: string,
  verified: boolean,
  applied = false,
): IterationSignal {
  return {
    at: "2026-11-14T00:00:00.000Z",
    iterationId: "it_1",
    taskId: `${domain}-task`,
    domain,
    coder: "dsh",
    verified,
    applied,
    risk: "medium",
    tokens: 1000,
  };
}

describe("iteration signals", () => {
  it("summarizes per-domain pass/apply rates", () => {
    const summary = summarizeSignals([
      signal("cyber", true, false),
      signal("cyber", false),
      signal("docs", true, true),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.verified).toBe(2);
    const cyber = summary.domains.find((item) => item.domain === "cyber");
    expect(cyber?.passRate).toBe(0.5);
    const docs = summary.domains.find((item) => item.domain === "docs");
    expect(docs?.applyRate).toBe(1);
  });

  it("proposes changes for low-pass domains", () => {
    const summary = summarizeSignals([
      signal("cyber", false),
      signal("cyber", false),
      signal("docs", true, true),
    ]);
    const proposals = proposeImprovements(summary);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.domain).toBe("cyber");
    expect(proposals[0]?.suggestedRules.length).toBeGreaterThan(0);
  });

  it("does not propose with too little evidence", () => {
    const summary = summarizeSignals([signal("cyber", false)]);
    expect(proposeImprovements(summary)).toHaveLength(0);
  });
});
