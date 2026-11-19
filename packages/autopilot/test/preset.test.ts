import {
  type AutopilotConfig,
  evaluateIterationApply,
  resolveIterationApplyMode,
} from "@kit/core";
import type { AutonomyPresetRecord } from "@kit/ops";
import { describe, expect, it } from "vitest";
import { applyAutonomyPreset } from "../src/preset";

const CONFIG: AutopilotConfig = {
  version: 1,
  enabled: false,
  timezone: "Asia/Shanghai",
  schedules: [],
  iterations: [
    {
      id: "system-iterate",
      cron: "0 3 * * *",
      goal: "find and fix",
      maxTasks: 4,
      maxRepair: 1,
      mode: "DRY_RUN",
      applyMode: "none",
      coder: "dsh",
      budget: { dailyRuns: 1, dailyCostCny: 1 },
    },
  ],
  approval: {
    autoApprove: { enabled: false, maxRisk: "low", onTimeout: "wait" },
  },
};

function preset(
  overrides: Partial<AutonomyPresetRecord["config"]> = {},
): AutonomyPresetRecord {
  return {
    presetId: "aps_test",
    workspaceId: "default",
    level: "self-hosted-live",
    status: "active",
    config: {
      applyMode: "low-medium",
      dailyCostCny: 5,
      dailyRuns: 2,
      maxTasks: 2,
      allowNight: true,
      ...overrides,
    },
    appliedBy: "operator:test",
    appliedAt: "2026-11-15T00:00:00.000Z",
    rolledBackBy: null,
    rolledBackAt: null,
    rollbackReason: null,
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
}

describe("applyAutonomyPreset", () => {
  it("returns the pack config untouched without a preset", () => {
    expect(applyAutonomyPreset(CONFIG, null)).toBe(CONFIG);
  });

  it("enables LIVE iterations with the preset budget and apply mode", () => {
    const effective = applyAutonomyPreset(CONFIG, preset());

    expect(effective.enabled).toBe(true);
    expect(effective.iterations[0]).toMatchObject({
      mode: "LIVE",
      applyMode: "low-medium",
      maxTasks: 2,
      budget: { dailyRuns: 2, dailyCostCny: 5 },
    });
  });

  it("keeps the pack file defaults intact", () => {
    applyAutonomyPreset(CONFIG, preset());

    expect(CONFIG.enabled).toBe(false);
    expect(CONFIG.iterations[0]?.mode).toBe("DRY_RUN");
    expect(CONFIG.iterations[0]?.applyMode).toBe("none");
  });

  it("never raises maxTasks above the pack declaration", () => {
    const effective = applyAutonomyPreset(CONFIG, preset({ maxTasks: 10 }));

    expect(effective.iterations[0]?.maxTasks).toBe(4);
  });

  it("leaves approval policy and schedules alone", () => {
    const effective = applyAutonomyPreset(CONFIG, preset());

    expect(effective.approval).toEqual(CONFIG.approval);
    expect(effective.schedules).toEqual(CONFIG.schedules);
  });

  it("cannot auto-apply agent instructions even when the preset forces low-medium", () => {
    const effective = applyAutonomyPreset(CONFIG, preset());
    const iteration = effective.iterations[0];
    if (!iteration) {
      throw new Error("planned iteration missing");
    }
    const applyMode = resolveIterationApplyMode(
      iteration.mode,
      iteration.applyMode,
    );

    expect(applyMode).toBe("low-medium");
    const decision = evaluateIterationApply({
      runMode: iteration.mode,
      applyMode,
      risk: "medium",
      changedFiles: ["packs/self-improve/agents/patcher.md"],
    });
    expect(decision.action).toBe("block");
  });

  it("keeps low-risk autopilot iterations auto-appliable", () => {
    const effective = applyAutonomyPreset(CONFIG, preset());
    const iteration = effective.iterations[0];
    if (!iteration) {
      throw new Error("planned iteration missing");
    }
    const applyMode = resolveIterationApplyMode(
      iteration.mode,
      iteration.applyMode,
    );

    const decision = evaluateIterationApply({
      runMode: iteration.mode,
      applyMode,
      risk: "low",
      changedFiles: ["docs/readme.md"],
    });
    expect(decision.action).toBe("apply");
  });
});
