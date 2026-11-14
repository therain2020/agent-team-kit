import { describe, expect, it } from "vitest";
import {
  inferAgentRole,
  rolePlanForAgents,
  validateRolePlan,
} from "../src/role-plan";

describe("role plan", () => {
  it("infers roles from ids and descriptions", () => {
    expect(inferAgentRole("manager", "")).toBe("manager");
    expect(inferAgentRole("seller", "owns requirements")).toBe("seller");
    expect(inferAgentRole("cyber-auditor", "security review")).toBe(
      "specialist",
    );
    expect(inferAgentRole("builder", "writes code")).toBe("builder");
  });

  it("requires seller and builder when the Pack says so", () => {
    const agents = new Map([
      ["seller", { role: "seller" as const }],
      ["builder", { role: "builder" as const }],
    ]);
    const errors = validateRolePlan({
      agents,
      rules: {
        requireSeller: true,
        requireBuilder: true,
        allowCombined: false,
      },
      sellers: [],
      builders: ["builder"],
      allowCombined: false,
    });
    expect(errors).toContain("this Pack requires at least one Seller");
  });

  it("rejects combined roles when disallowed", () => {
    const agents = new Map([["seller", { role: "seller" as const }]]);
    const errors = validateRolePlan({
      agents,
      rules: {
        requireSeller: true,
        requireBuilder: true,
        allowCombined: false,
      },
      sellers: ["seller"],
      builders: ["seller"],
      allowCombined: false,
    });
    expect(errors.some((error) => error.includes("does not allow"))).toBe(true);
  });

  it("builds a default plan from roles", () => {
    const plan = rolePlanForAgents(
      new Map([
        ["seller", { role: "seller" as const }],
        ["builder", { role: "builder" as const }],
        ["verifier", { role: "specialist" as const }],
        ["manager", { role: "manager" as const }],
      ]),
      false,
    );
    expect(plan.sellers).toEqual(["seller"]);
    expect(plan.builders).toEqual(["builder"]);
    expect(plan.specialists).toEqual(["verifier"]);
  });
});
