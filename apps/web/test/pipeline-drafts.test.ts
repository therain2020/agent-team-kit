import type { ComponentKind } from "@kit/core";
import type { DraftStage } from "@kit/pack";
import { describe, expect, it } from "vitest";
import {
  type PipelineComponentOption,
  type PipelineDraftValues,
  addPipelineBinding,
  addPipelineComponent,
  applyPipelineBindings,
  assignPipelineStageAgent,
  movePipelineBinding,
  movePipelineComponent,
  pipelineAssemblyComponents,
  pipelineComponentKey,
  removePipelineBinding,
  removePipelineComponent,
  replacePipelineComponent,
  updatePipelineBinding,
  validatePipelineDraftEdits,
} from "../lib/pipeline-drafts";

function option(
  kind: ComponentKind,
  id: string,
  overrides: Partial<PipelineComponentOption> = {},
): PipelineComponentOption {
  return {
    kind,
    id,
    version: "1.0.0",
    source: {
      repo: `local/${id}`,
      commit: "a".repeat(40),
      ref: "local",
      sha256: "b".repeat(64),
    },
    description: `${id} component`,
    tools: [],
    toolAdapters: {},
    workflowAgents: [],
    ...overrides,
  };
}

function stage(
  id: string,
  type: DraftStage["type"] = "agent",
  agent?: string,
): DraftStage {
  return {
    id,
    type,
    ...(agent ? { agent } : {}),
    inputs: ["task"],
    outputs: [`${id}_out`],
    depends: [],
  };
}

const AGENT = option("agent", "analyst");
const REVIEWER = option("agent", "reviewer");
const WORKFLOW = option("workflow", "brief");
const TOOLPACK = option("toolpack", "weather", {
  toolAdapters: { weather_lookup: "http" },
});

function baseValues(
  overrides: Partial<PipelineDraftValues> = {},
): PipelineDraftValues {
  return {
    id: "brief",
    name: "Brief",
    description: "daily brief",
    stages: [
      stage("research", "agent", "analyst"),
      stage("deliver", "workflow"),
    ],
    components: [
      { ref: refOf(AGENT), description: AGENT.description },
      { ref: refOf(WORKFLOW), description: WORKFLOW.description },
    ],
    bindings: [
      { node: "research", component: refOf(AGENT) },
      { node: "deliver", component: refOf(WORKFLOW) },
    ],
    issues: [],
    ...overrides,
  };
}

function refOf(entry: PipelineComponentOption) {
  return {
    kind: entry.kind,
    id: entry.id,
    version: entry.version,
    source: { ...entry.source },
  };
}

const CONTEXT = {
  library: [AGENT, REVIEWER, WORKFLOW, TOOLPACK],
  teamAgents: ["manager"],
};

describe("pipeline draft component edits", () => {
  it("adds a component once and keeps order", () => {
    const values = baseValues();
    const added = addPipelineComponent(values, TOOLPACK);
    expect(added.components.map((c) => pipelineComponentKey(c.ref))).toEqual([
      "agent/analyst",
      "workflow/brief",
      "toolpack/weather",
    ]);
    expect(addPipelineComponent(added, TOOLPACK)).toBe(added);
    expect(values.components).toHaveLength(2);
  });

  it("removes an agent component together with its binding and stage agent", () => {
    const values = baseValues();
    const next = removePipelineComponent(values, 0);
    expect(next.components.map((c) => pipelineComponentKey(c.ref))).toEqual([
      "workflow/brief",
    ]);
    expect(next.bindings.map((b) => b.node)).toEqual(["deliver"]);
    expect(next.stages[0]?.agent).toBeUndefined();
  });

  it("replaces a ref in place and follows it in bindings and stages", () => {
    const values = baseValues();
    const next = replacePipelineComponent(values, 0, REVIEWER);
    expect(next.components.at(0)?.ref.id).toBe("reviewer");
    expect(next.bindings.at(0)?.component.id).toBe("reviewer");
    expect(next.stages[0]?.agent).toBe("reviewer");
  });

  it("refuses a replacement that would duplicate another component", () => {
    const values = baseValues();
    expect(replacePipelineComponent(values, 0, WORKFLOW)).toBe(values);
  });

  it("reorders components without mutating the input", () => {
    const values = baseValues();
    const next = movePipelineComponent(values, 1, -1);
    expect(next.components.map((c) => pipelineComponentKey(c.ref))).toEqual([
      "workflow/brief",
      "agent/analyst",
    ]);
    expect(values.components.map((c) => pipelineComponentKey(c.ref))).toEqual([
      "agent/analyst",
      "workflow/brief",
    ]);
    expect(movePipelineComponent(values, 0, -1)).toBe(values);
  });
});

describe("pipeline draft binding edits", () => {
  it("adds a binding and points the agent stage at it", () => {
    const values = baseValues({
      components: [
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(REVIEWER), description: "" },
      ],
      bindings: [],
    });
    const next = addPipelineBinding(values, "research", "agent/reviewer");
    expect(next.bindings).toHaveLength(1);
    expect(next.stages[0]?.agent).toBe("reviewer");
  });

  it("replaces the binding of the same stage instead of stacking", () => {
    const values = baseValues();
    values.components.push({ ref: refOf(REVIEWER), description: "" });
    const next = addPipelineBinding(values, "research", "agent/reviewer");
    expect(next.bindings).toHaveLength(2);
    expect(next.bindings[0]?.component.id).toBe("reviewer");
    expect(next.stages[0]?.agent).toBe("reviewer");
  });

  it("moves a binding to another stage and clears the old stage agent", () => {
    const values = baseValues({
      stages: [stage("research", "agent", "analyst"), stage("write", "agent")],
      bindings: [{ node: "research", component: refOf(AGENT) }],
    });
    const next = updatePipelineBinding(values, 0, { node: "write" });
    expect(next.bindings[0]?.node).toBe("write");
    expect(next.stages[0]?.agent).toBeUndefined();
    expect(next.stages[1]?.agent).toBe("analyst");
  });

  it("removes a binding and clears the stage agent", () => {
    const values = baseValues();
    const next = removePipelineBinding(values, 0);
    expect(next.bindings.map((b) => b.node)).toEqual(["deliver"]);
    expect(next.stages[0]?.agent).toBeUndefined();
  });

  it("binds a stage back to a team member by dropping its component binding", () => {
    const values = baseValues();
    const next = assignPipelineStageAgent(values, "research", "manager");
    expect(next.bindings.map((b) => b.node)).toEqual(["deliver"]);
    expect(next.stages[0]?.agent).toBe("manager");
  });

  it("reorders bindings and ignores out-of-range moves", () => {
    const values = baseValues();
    const next = movePipelineBinding(values, 1, -1);
    expect(next.bindings.map((b) => b.node)).toEqual(["deliver", "research"]);
    expect(movePipelineBinding(values, 0, -1)).toBe(values);
  });

  it("builds the assembly request in order without duplicates", () => {
    const values = baseValues({
      components: [
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(WORKFLOW), description: "" },
      ],
    });
    expect(pipelineAssemblyComponents(values)).toEqual([
      { kind: "agent", id: "analyst" },
      { kind: "workflow", id: "brief" },
    ]);
  });

  it("applies agent bindings to a fresh stage array (no side effects)", () => {
    const values = baseValues({
      components: [
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(REVIEWER), description: "" },
      ],
      bindings: [],
    });
    const stages = applyPipelineBindings(
      addPipelineBinding(values, "research", "agent/reviewer"),
    );
    expect(stages[0]?.agent).toBe("reviewer");
    expect(values.stages[0]?.agent).toBe("analyst");
    expect(stages).not.toBe(values.stages);
  });
});

describe("pipeline draft edit validation", () => {
  it("accepts a fully bound draft", () => {
    const result = validatePipelineDraftEdits(baseValues(), CONTEXT);
    expect(result.issues).toEqual([]);
  });

  it("skips library membership checks when the snapshot failed to load", () => {
    const result = validatePipelineDraftEdits(baseValues(), {
      library: [],
      teamAgents: ["manager"],
    });
    expect(result.issues).toEqual([]);
  });

  it("rejects refs that are not in the library", () => {
    const ghost = option("agent", "ghost");
    const values = baseValues({
      components: [{ ref: refOf(ghost), description: "" }],
      bindings: [],
      stages: [stage("research", "agent", "ghost")],
    });
    const codes = validatePipelineDraftEdits(values, CONTEXT).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain("component_not_found");
  });

  it("rejects a binding to an unassembled component", () => {
    const values = baseValues();
    values.bindings.push({ node: "deliver", component: refOf(REVIEWER) });
    const codes = validatePipelineDraftEdits(values, CONTEXT).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain("duplicate_binding");
    expect(codes).toContain("binding_component_missing");
  });

  it("rejects a kind mismatch between stage and component", () => {
    const values = baseValues({
      components: [{ ref: refOf(REVIEWER), description: "" }],
      bindings: [{ node: "deliver", component: refOf(REVIEWER) }],
      stages: [
        stage("research", "agent", "manager"),
        stage("deliver", "workflow"),
      ],
    });
    const codes = validatePipelineDraftEdits(values, CONTEXT).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain("component_kind_mismatch");
  });

  it("reports a missing stage and an unbound agent stage", () => {
    const values = baseValues({
      stages: [stage("research", "agent")],
      bindings: [{ node: "deliver", component: refOf(WORKFLOW) }],
    });
    const codes = validatePipelineDraftEdits(values, CONTEXT).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain("stage_not_found");
    expect(codes).toContain("agent_missing");
  });

  it("rejects an agent that neither the team nor the assembly provides", () => {
    const values = baseValues({
      components: [],
      bindings: [],
      stages: [stage("research", "agent", "ghost")],
    });
    const codes = validatePipelineDraftEdits(values, CONTEXT).issues.map(
      (issue) => issue.code,
    );
    expect(codes).toContain("agent_not_found");
  });

  it("rejects locked-version drift and command toolpacks", () => {
    const locked = option("agent", "analyst", { lockedVersion: "0.9.0" });
    const command = option("toolpack", "shell", {
      toolAdapters: { run: "command" },
    });
    const values = baseValues({
      components: [
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(command), description: "" },
      ],
      bindings: [{ node: "research", component: refOf(AGENT) }],
    });
    const codes = validatePipelineDraftEdits(values, {
      library: [locked, command],
      teamAgents: ["manager"],
    }).issues.map((issue) => issue.code);
    expect(codes).toContain("version_conflict");
    expect(codes).toContain("tool_consent_required");
  });

  it("rejects workflow components that reference unavailable agents", () => {
    const workflow = option("workflow", "brief", {
      workflowAgents: ["ghost"],
    });
    const values = baseValues({
      components: [
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(workflow), description: "" },
      ],
      bindings: [
        { node: "research", component: refOf(AGENT) },
        { node: "deliver", component: refOf(workflow) },
      ],
    });
    const codes = validatePipelineDraftEdits(values, {
      library: [AGENT, workflow],
      teamAgents: ["manager"],
    }).issues.map((issue) => issue.code);
    expect(codes).toContain("workflow_agent_missing");
  });

  it("warns about components that are not bound to any stage", () => {
    const values = baseValues({
      components: [
        { ref: refOf(AGENT), description: "" },
        { ref: refOf(REVIEWER), description: "" },
      ],
      bindings: [{ node: "research", component: refOf(AGENT) }],
      stages: [stage("research", "agent", "analyst")],
    });
    const result = validatePipelineDraftEdits(values, CONTEXT);
    expect(result.issues).toEqual([]);
    expect(result.warnings.join("\n")).toContain("agent/reviewer");
  });
});
