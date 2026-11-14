import { describe, expect, it } from "vitest";
import { classifyRisk, parseTaskPlan } from "../src/iteration-activities";

describe("parseTaskPlan", () => {
  it("parses a fenced JSON plan", () => {
    const plan = parseTaskPlan(`\`\`\`json
{
  "goal": "improve the kit",
  "summary": "two tasks",
  "tasks": [
    {
      "id": "security-audit",
      "domain": "cyber",
      "goal": "fix one issue",
      "acceptance": "checks pass",
      "risk": "medium"
    }
  ]
}
\`\`\``);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.domain).toBe("cyber");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseTaskPlan("not json")).toThrow();
  });

  it("normalizes string hints and mixed-case risk from the model", () => {
    const plan = parseTaskPlan(
      JSON.stringify({
        goal: " improve ",
        summary: " one task ",
        tasks: [
          {
            id: " t1 ",
            domain: " docs ",
            goal: " do ",
            acceptance: " ok ",
            filesHint: "README.md, docs/a.md\ndocs/b.md",
            dependsOn: "t0",
            risk: "MEDIUM",
          },
        ],
      }),
    );
    expect(plan.goal).toBe("improve");
    expect(plan.tasks[0]?.id).toBe("t1");
    expect(plan.tasks[0]?.domain).toBe("docs");
    expect(plan.tasks[0]?.risk).toBe("medium");
    expect(plan.tasks[0]?.filesHint).toEqual([
      "README.md",
      "docs/a.md",
      "docs/b.md",
    ]);
    expect(plan.tasks[0]?.dependsOn).toEqual(["t0"]);
  });

  it("treats null hints as empty arrays and drops non-strings", () => {
    const plan = parseTaskPlan(
      JSON.stringify({
        goal: "g",
        summary: "s",
        tasks: [
          {
            id: "t1",
            domain: "docs",
            goal: "g",
            acceptance: "a",
            filesHint: null,
            dependsOn: ["t0", 1, null],
            risk: "low",
          },
        ],
      }),
    );
    expect(plan.tasks[0]?.filesHint).toEqual([]);
    expect(plan.tasks[0]?.dependsOn).toEqual(["t0"]);
  });
});

describe("classifyRisk", () => {
  it("keeps low-risk docs low", () => {
    const result = classifyRisk(["docs/readme.md"], "low", "medium");
    expect(result.risk).toBe("low");
    expect(result.forbidden).toBe(false);
  });

  it("treats pack README files as low-risk docs", () => {
    const result = classifyRisk(["packs/self-improve/README.md"], "low", "low");
    expect(result.risk).toBe("low");
  });

  it("marks core paths high", () => {
    const result = classifyRisk(
      ["packages/core/src/workflow.ts"],
      "low",
      "high",
    );
    expect(result.risk).toBe("high");
  });

  it("escalates when the domain ceiling is exceeded", () => {
    const result = classifyRisk(
      ["apps/web/app/(console)/office/page.tsx"],
      "medium",
      "low",
    );
    expect(result.risk).toBe("high");
  });

  it("blocks forbidden paths", () => {
    const result = classifyRisk([".env"], "low", "high");
    expect(result.forbidden).toBe(true);
  });

  it("does not downgrade a planned high risk", () => {
    const result = classifyRisk(["README.md"], "high", "high");
    expect(result.risk).toBe("high");
  });
});
