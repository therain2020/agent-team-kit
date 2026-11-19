import type { AutopilotConfig } from "@kit/core";
import { describe, expect, it } from "vitest";
import {
  type AgentDraftFacts,
  type AgentDraftValues,
  type EvolutionCycleValues,
  composeJob,
  validateAgentDraft,
} from "../src/compose";

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

describe("agent composer", () => {
  it("drafts a new member with an inferred role", async () => {
    const result = await composeJob({
      kind: "agent",
      intent: "审阅发布前的引用与数据",
      packDir: "minimal",
      repoRoot,
      env,
      agentId: "reviewer",
    });

    const values = result.values as AgentDraftValues;
    expect(result.kind).toBe("agent");
    expect(result.model).toBe("heuristic");
    expect(values.role).toBe("specialist");
    expect(values.model).toBe("deepseek-flash");
    expect(values.description.length).toBeGreaterThan(0);
    expect(values.instructions.length).toBeGreaterThan(0);
    expect(values.tools).toEqual([]);
    expect(values.skills).toEqual([]);
  });

  it("preserves current fields when the model is unavailable", async () => {
    const result = await composeJob({
      kind: "agent",
      intent: "让它更适合审阅",
      packDir: "minimal",
      repoRoot,
      env,
      agentId: "echo",
      current: {
        description: "Existing teammate",
        model: "deepseek-flash",
        role: "builder",
        instructions: "Keep these instructions",
        tools: ["repo_read"],
        skills: [],
      },
    });

    const values = result.values as AgentDraftValues;
    expect(result.model).toBe("heuristic");
    expect(values.description).toBe("Existing teammate");
    expect(values.instructions).toBe("Keep these instructions");
    expect(values.role).toBe("builder");
    expect(values.model).toBe("deepseek-flash");
    expect(values.tools).toEqual(["repo_read"]);
    expect(values.skills).toEqual([]);
  });

  it("drops invalid values and reports warnings", async () => {
    const result = await composeJob({
      kind: "agent",
      intent: "补全成员",
      packDir: "minimal",
      repoRoot,
      env,
      agentId: "echo",
      current: {
        role: "wizard" as AgentDraftValues["role"],
        model: "made-up-model",
        tools: ["not_a_tool"],
        skills: ["not_a_skill"],
      },
    });

    const values = result.values as AgentDraftValues;
    expect(values.role).toBe("builder");
    expect(values.model).toBe("deepseek-flash");
    expect(values.tools).toEqual([]);
    expect(values.skills).toEqual([]);
    const combined = result.warnings.join(" ");
    expect(combined).toContain("not_a_tool");
    expect(combined).toContain("not_a_skill");
    expect(combined).toContain("made-up-model");
  });

  it("validates live drafts against the pack catalog", () => {
    const facts: AgentDraftFacts = {
      pack: "test",
      workflows: [],
      agents: [],
      tools: ["repo_read"],
      skills: ["review"],
      models: ["deepseek-flash"],
      agentId: "reviewer",
      current: null,
      isManager: false,
    };
    const fallback: AgentDraftValues = {
      description: "fallback",
      model: "deepseek-flash",
      role: "specialist",
      instructions: "fallback instructions",
      tools: [],
      skills: [],
    };

    const result = validateAgentDraft(
      {
        description: "Reviews releases before delivery",
        instructions: "Check every citation.",
        model: "gpt-4",
        role: "manager",
        tools: ["repo_read", "evil_tool"],
        skills: ["review", "ghost_skill"],
      },
      fallback,
      facts,
    );

    expect(result.accepted).toBe(true);
    expect(result.values.description).toBe("Reviews releases before delivery");
    expect(result.values.instructions).toBe("Check every citation.");
    expect(result.values.model).toBe("deepseek-flash");
    expect(result.values.role).toBe("specialist");
    expect(result.values.tools).toEqual(["repo_read"]);
    expect(result.values.skills).toEqual(["review"]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
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
