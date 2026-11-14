import { describe, expect, it } from "vitest";
import {
  buildEvidence,
  evidenceFromIterations,
  evidenceFromSignals,
  mergeEvidence,
} from "../src/evidence";
import type { IterationSignal } from "../src/signals";

function signal(overrides: Partial<IterationSignal> = {}): IterationSignal {
  return {
    at: "2026-11-14T00:00:00.000Z",
    iterationId: "itr_1",
    taskId: "task_1",
    domain: "radar",
    coder: "dsh",
    verified: false,
    applied: false,
    risk: "low",
    tokens: 100,
    ...overrides,
  };
}

describe("evolution evidence", () => {
  it("assigns citation ids, dedupes and caps sources", () => {
    const document = buildEvidence(
      [
        { title: "a", summary: "one" },
        { title: "a", summary: "one" },
        { title: "b" },
        { title: "c" },
      ],
      { generatedFrom: "test", limit: 2 },
    );

    expect(document.sources.map((source) => source.citationId)).toEqual([
      "S1",
      "S2",
    ]);
    expect(document.sources.map((source) => source.title)).toEqual(["a", "b"]);
    expect(document.generatedFrom).toBe("test");
    expect(document.errors).toEqual([]);
  });

  it("builds evidence from failed iterations", () => {
    const document = evidenceFromIterations([
      {
        iterationId: "itr_1",
        taskId: "task_1",
        domain: "radar",
        goal: "Fix the citation gate",
        acceptance: "No invented citations",
        error: "verification failed: unknown citation S9",
        updatedAt: "2026-11-14T00:00:00.000Z",
      },
    ]);

    expect(document.generatedFrom).toBe("iterations");
    expect(document.sources).toHaveLength(1);
    const [source] = document.sources;
    expect(source).toMatchObject({
      citationId: "S1",
      title: "radar · Fix the citation gate",
      publishedAt: "2026-11-14T00:00:00.000Z",
    });
    expect(source?.summary).toContain("unknown citation S9");
  });

  it("only turns failed signals into evidence", () => {
    const document = evidenceFromSignals([
      signal({ taskId: "task_pass", verified: true }),
      signal({ taskId: "task_fail", error: "checks failed" }),
    ]);

    expect(document.generatedFrom).toBe("signals");
    expect(document.sources).toHaveLength(1);
    const [source] = document.sources;
    expect(source?.title).toContain("task_fail");
    expect(source?.title).not.toContain("task_pass");
    expect(source?.summary).toBe("checks failed");
  });

  it("merges generated documents and renumbers citations", () => {
    const document = mergeEvidence(
      [
        evidenceFromIterations([
          {
            iterationId: "itr_1",
            taskId: "task_1",
            domain: "radar",
            goal: "First",
          },
        ]),
        evidenceFromSignals([signal({ error: "second" })]),
      ],
      { limit: 10 },
    );

    expect(document.sources.map((source) => source.citationId)).toEqual([
      "S1",
      "S2",
    ]);
    expect(document.generatedFrom).toBe("iterations+signals");
  });
});
