import type { AutopilotConfig } from "@kit/core";
import { type DraftStage, validateStageGraph } from "@kit/pack";
import { describe, expect, it } from "vitest";
import {
  type AgentDraftFacts,
  type AgentDraftValues,
  type EvolutionCycleValues,
  type WorkflowDraftFacts,
  type WorkflowDraftValues,
  composeJob,
  validateAgentDraft,
  validateWorkflowDraft,
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

describe("workflow composer", () => {
  it("falls back to a linear single-stage graph", async () => {
    const result = await composeJob({
      kind: "workflow",
      intent: "先调研再发布",
      packDir: "minimal",
      repoRoot,
      env,
    });

    const values = result.values as WorkflowDraftValues;
    expect(result.kind).toBe("workflow");
    expect(result.model).toBe("heuristic");
    expect(values.stages).toHaveLength(1);
    const [stage] = values.stages;
    expect(stage?.id).toBe("echo");
    expect(stage?.type).toBe("agent");
    expect(stage?.agent).toBe("echo");
    expect(stage?.depends).toEqual([]);
    expect(stage?.goal).toBe("先调研再发布");
    expect(validateStageGraph(values.stages, ["echo"]).ok).toBe(true);
  });

  it("preserves the current stage graph when editing", async () => {
    const current: DraftStage[] = [
      {
        id: "research",
        type: "agent",
        agent: "echo",
        inputs: ["task"],
        outputs: ["notes"],
        depends: [],
      },
      {
        id: "publish",
        type: "agent",
        agent: "echo",
        inputs: ["notes"],
        outputs: ["final"],
        depends: ["research"],
        approval: {
          mode: "required",
          position: "before",
          riskClass: "high",
          ttl: "72h",
        },
      },
    ];

    const result = await composeJob({
      kind: "workflow",
      intent: "保留现有阶段",
      packDir: "minimal",
      repoRoot,
      env,
      currentStages: current,
    });

    const values = result.values as WorkflowDraftValues;
    expect(result.model).toBe("heuristic");
    expect(values.stages.map((stage) => stage.id)).toEqual([
      "research",
      "publish",
    ]);
    expect(values.stages[1]?.depends).toEqual(["research"]);
    expect(values.stages[1]?.approval?.riskClass).toBe("high");
    expect(validateStageGraph(values.stages, ["echo"]).ok).toBe(true);
  });

  it("rejects an invalid live draft and keeps the fallback", async () => {
    const fallback: DraftStage[] = [
      {
        id: "echo",
        type: "agent",
        agent: "echo",
        inputs: ["task"],
        outputs: ["echo_output"],
        depends: [],
      },
    ];
    const facts: WorkflowDraftFacts = {
      pack: "minimal",
      workflows: [],
      agents: [
        {
          id: "echo",
          role: "builder",
          model: "deepseek-flash",
          tools: [],
          skills: [],
        },
      ],
      tools: [],
      skills: [],
      gates: [],
      current: null,
    };

    const result = validateWorkflowDraft(
      {
        stages: [
          {
            id: "research",
            type: "agent",
            agent: "ghost",
            inputs: ["task"],
            outputs: ["notes"],
            depends: [],
          },
        ],
      },
      fallback,
      facts,
    );

    expect(result.accepted).toBe(false);
    expect(result.values.stages).toEqual(fallback);
    expect(result.warnings.join(" ")).toContain("ghost");
  });
});

describe("stage graph validation", () => {
  const base: DraftStage = {
    id: "research",
    type: "agent",
    agent: "echo",
    inputs: ["task"],
    outputs: ["notes"],
    depends: [],
  };

  it("accepts an ordered single-entry DAG", () => {
    const stages: DraftStage[] = [
      base,
      {
        id: "review",
        type: "agent",
        agent: "echo",
        inputs: ["notes"],
        outputs: ["review"],
        depends: ["research"],
      },
      {
        id: "publish",
        type: "agent",
        agent: "echo",
        inputs: ["notes", "review"],
        outputs: ["final"],
        depends: ["research", "review"],
      },
    ];
    expect(validateStageGraph(stages, ["echo"])).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects unknown agents and non-slug stage ids", () => {
    const result = validateStageGraph(
      [{ ...base, id: "Bad Stage", agent: "ghost" }],
      ["echo"],
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("slug");
    expect(result.errors.join(" ")).toContain("ghost");
  });

  it("rejects forward dependencies and multiple entry stages", () => {
    const forward = validateStageGraph(
      [
        {
          id: "write",
          type: "agent",
          agent: "echo",
          inputs: ["task"],
          outputs: ["draft"],
          depends: ["research"],
        },
        base,
        {
          id: "side",
          type: "agent",
          agent: "echo",
          inputs: ["task"],
          outputs: ["aside"],
          depends: [],
        },
      ],
      ["echo"],
    );
    expect(forward.ok).toBe(false);
    expect(forward.errors.join(" ")).toContain("earlier stage");
    expect(forward.errors.join(" ")).toContain("exactly one entry stage");
  });

  it("rejects self dependencies", () => {
    const result = validateStageGraph([{ ...base, depends: ["research"] }], [
      "echo",
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("cannot depend on itself");
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
