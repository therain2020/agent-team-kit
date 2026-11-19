import {
  type AutoApproveScope,
  type RunOriginKind,
  autopilotSchema,
  isAutoApproveOriginEligible,
} from "@kit/core";
import { describe, expect, it } from "vitest";

const ALL_KINDS: RunOriginKind[] = [
  "cli",
  "web",
  "api",
  "manual",
  "schedule",
  "event",
  "information",
  "autopilot",
  "unknown",
];

function eligible(scope: AutoApproveScope): RunOriginKind[] {
  return ALL_KINDS.filter((kind) => isAutoApproveOriginEligible(kind, scope));
}

describe("auto-approval origin scope", () => {
  it("defaults to scheduled: only autonomous origins are eligible", () => {
    expect(eligible("scheduled")).toEqual(["schedule", "event", "information"]);
  });

  it("never auto-approves manual, web, or cli jobs by default", () => {
    for (const kind of ["manual", "web", "cli"] as const) {
      expect(isAutoApproveOriginEligible(kind, "scheduled")).toBe(false);
      expect(isAutoApproveOriginEligible(kind)).toBe(false);
    }
  });

  it("treats unknown or missing origins as ineligible by default", () => {
    expect(isAutoApproveOriginEligible("unknown")).toBe(false);
    expect(isAutoApproveOriginEligible("api")).toBe(false);
    expect(isAutoApproveOriginEligible(undefined)).toBe(false);
  });

  it("covers every origin only when scope is explicitly all", () => {
    expect(eligible("all")).toEqual(ALL_KINDS);
  });

  it("parses scope from autopilot.yaml and keeps it optional", () => {
    const base = {
      version: 1,
      approval: { autoApprove: { enabled: true } },
    } as const;
    const scheduled = autopilotSchema.parse(base);
    expect(scheduled.approval?.autoApprove?.scope).toBeUndefined();

    const all = autopilotSchema.parse({
      version: 1,
      approval: { autoApprove: { enabled: true, scope: "all" } },
    });
    expect(all.approval?.autoApprove?.scope).toBe("all");
  });
});
