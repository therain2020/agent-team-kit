import { describe, expect, it } from "vitest";
import {
  ManifestBudget,
  OFFICE_MANIFEST_LIMIT,
  OFFICE_RUN_LIMIT,
  selectOfficeRuns,
} from "../lib/office-budget";

function run(workflowId: string, runId: string) {
  return { workflowId, runId };
}

describe("office snapshot budget", () => {
  it("keeps only Pack workflows in newest-first order and caps at 12", () => {
    const runs = Array.from({ length: 30 }, (_, index) =>
      run(index % 2 === 0 ? "flow-a" : "flow-b", `run_${index}`),
    );
    const picked = selectOfficeRuns(runs, new Set(["flow-a"]));
    expect(picked).toHaveLength(OFFICE_RUN_LIMIT);
    expect(picked.every((entry) => entry.workflowId === "flow-a")).toBe(true);
    expect(picked[0]?.runId).toBe("run_0");
    expect(picked.at(-1)?.runId).toBe("run_22");

    const capped = selectOfficeRuns(runs, new Set(["flow-a", "flow-b"]), 3);
    expect(capped.map((entry) => entry.runId)).toEqual([
      "run_0",
      "run_1",
      "run_2",
    ]);
  });

  it("counts distinct manifest reads up to 60 and refetches are free", () => {
    const budget = new ManifestBudget();
    expect(budget.claim("m0")).toBe(true);
    expect(budget.claim("m0")).toBe(true);
    expect(budget.size).toBe(1);

    for (let index = 1; index < OFFICE_MANIFEST_LIMIT; index += 1) {
      expect(budget.claim(`m${index}`)).toBe(true);
    }
    expect(budget.size).toBe(OFFICE_MANIFEST_LIMIT);
    expect(budget.remaining).toBe(0);
    expect(budget.claim("m_new")).toBe(false);
    expect(budget.claim("m0")).toBe(true);
    expect(budget.size).toBe(OFFICE_MANIFEST_LIMIT);
  });
});
