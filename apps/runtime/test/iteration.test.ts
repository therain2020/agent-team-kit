import { describe, expect, it } from "vitest";
import {
  classifyRisk,
  parseTaskPlan,
} from "../src/temporal/iteration-activities";

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
});

describe("classifyRisk", () => {
  it("keeps low-risk docs low", () => {
    const result = classifyRisk(["docs/readme.md"], "low", "medium");
    expect(result.risk).toBe("low");
    expect(result.forbidden).toBe(false);
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
