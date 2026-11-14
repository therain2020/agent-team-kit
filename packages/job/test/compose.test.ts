import type { AutopilotConfig } from "@kit/core";
import { describe, expect, it } from "vitest";
import { type EvolutionCycleValues, composeJob } from "../src/compose";

const repoRoot = process.cwd();
const env = { KIT_MODEL_MODE: "stub" };

describe("autopilot composer", () => {
  it("drafts a conservative dry-run schedule", async () => {
    const result = await composeJob({
      kind: "autopilot",
      intent: "每个工作日早上九点跑一次",
      packDir: "minimal",
      repoRoot,
      env,
    });

    const values = result.values as AutopilotConfig;
    expect(result.kind).toBe("autopilot");
    expect(values.version).toBe(1);
    expect(values.enabled).toBe(false);
    expect(values.approval?.autoApprove?.enabled).toBe(false);
    expect(values.schedules.length).toBeGreaterThan(0);
    for (const schedule of values.schedules) {
      expect(schedule.workflow.length).toBeGreaterThan(0);
      expect(schedule.cron.split(/\s+/)).toHaveLength(5);
      expect(schedule.mode).toBe("DRY_RUN");
    }
    expect(result.model).toBe("heuristic");
  });

  it("rejects a pack outside packs/", async () => {
    await expect(
      composeJob({
        kind: "autopilot",
        intent: "每天跑一次",
        packDir: "../etc",
        repoRoot,
        env,
      }),
    ).rejects.toMatchObject({ code: "pack_outside_root" });
  });
});

describe("evolution composer", () => {
  it("picks a non-manager agent and a checkable hypothesis", async () => {
    const result = await composeJob({
      kind: "evolutionCycle",
      intent: "让角色先核验引用再输出",
      packDir: "self-improve",
      repoRoot,
      env,
    });

    const values = result.values as EvolutionCycleValues;
    expect(result.kind).toBe("evolutionCycle");
    expect(values.packDir).toBe("self-improve");
    expect(values.agentId).not.toBe("manager");
    expect(values.agentId.length).toBeGreaterThan(0);
    expect(values.hypothesis).toContain(values.agentId);
    expect(values.stub).toBe(true);
    expect(values.autoApply).toBe(false);
  });

  it("requires an intent", async () => {
    await expect(
      composeJob({
        kind: "evolutionCycle",
        intent: "  ",
        packDir: "self-improve",
        repoRoot,
        env,
      }),
    ).rejects.toMatchObject({ code: "intent_required" });
  });
});
