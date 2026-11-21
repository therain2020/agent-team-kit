import { isAutoApproveOriginEligible } from "@kit/core";
import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_ORIGIN_KINDS,
  autoApproveCoveredOrigins,
  autoApproveForSave,
  normalizeAutoApprove,
  requiresScopeAllConfirmation,
  resolveAutoApproveScope,
  withoutRunCost,
} from "../lib/auto-approve-scope";

describe("auto-approve scope helpers (96 §5.2)", () => {
  it("treats an absent scope as scheduled and keeps an explicit all", () => {
    expect(resolveAutoApproveScope(undefined)).toBe("scheduled");
    expect(resolveAutoApproveScope(null)).toBe("scheduled");
    expect(resolveAutoApproveScope({})).toBe("scheduled");
    expect(resolveAutoApproveScope({ scope: "scheduled" })).toBe("scheduled");
    expect(resolveAutoApproveScope({ scope: "all" })).toBe("all");
  });

  it("shows scheduled coverage as the autonomous origins only", () => {
    const origins = autoApproveCoveredOrigins("scheduled");
    expect(origins).toEqual(["schedule", "event", "information"]);
    for (const kind of INTERACTIVE_ORIGIN_KINDS) {
      expect(origins).not.toContain(kind);
      expect(isAutoApproveOriginEligible(kind, "scheduled")).toBe(false);
    }
  });

  it("shows all coverage including manual/web/cli/api", () => {
    const origins = autoApproveCoveredOrigins("all");
    for (const kind of [
      ...INTERACTIVE_ORIGIN_KINDS,
      "schedule",
      "event",
      "information",
    ] as const) {
      expect(origins).toContain(kind);
      expect(isAutoApproveOriginEligible(kind, "all")).toBe(true);
    }
    expect(origins).not.toContain("unknown");
  });

  it("requires explicit confirmation whenever scope is all", () => {
    expect(requiresScopeAllConfirmation("all")).toBe(true);
    expect(requiresScopeAllConfirmation("scheduled")).toBe(false);
  });

  it("normalizes a missing policy to scheduled and preserves an existing all", () => {
    expect(normalizeAutoApprove()).toMatchObject({
      enabled: false,
      maxRisk: "low",
      onTimeout: "wait",
      scope: "scheduled",
    });
    expect(normalizeAutoApprove({ enabled: true, scope: "all" })).toMatchObject(
      { enabled: true, scope: "all" },
    );
    expect(
      normalizeAutoApprove({
        enabled: true,
        maxRisk: "medium",
        onTimeout: "abort",
        maxRunCostCny: 3,
        scope: "all",
      }),
    ).toEqual({
      enabled: true,
      maxRisk: "medium",
      onTimeout: "abort",
      maxRunCostCny: 3,
      scope: "all",
    });
  });

  it("persists the effective scope instead of dropping it", () => {
    const base = { enabled: true, maxRisk: "low", onTimeout: "wait" } as const;
    expect(autoApproveForSave({ ...base, scope: "all" }).scope).toBe("all");
    expect(autoApproveForSave(base).scope).toBe("scheduled");
  });

  it("dropping the cost cap keeps the scope", () => {
    const cleared = withoutRunCost({
      enabled: true,
      maxRisk: "low",
      onTimeout: "wait",
      maxRunCostCny: 5,
      scope: "all",
    });
    expect(cleared).toEqual({
      enabled: true,
      maxRisk: "low",
      onTimeout: "wait",
      scope: "all",
    });
    expect("maxRunCostCny" in cleared).toBe(false);
  });
});
