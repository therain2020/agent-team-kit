import { createHash } from "node:crypto";
import type { ComponentKind, ComponentRef } from "@kit/core";
import { type DraftStage, validateStageGraph } from "@kit/pack";
import { describe, expect, it } from "vitest";
import {
  type PipelineComponentEntry,
  type PipelineDraftFacts,
  type PipelineDraftValues,
  type PipelineInventory,
  composeJob,
  validatePipelineDraft,
} from "../src/compose";

const repoRoot = process.cwd();
const env = { KIT_MODEL_MODE: "stub" };

const baseStage: DraftStage = {
  id: "echo",
  type: "agent",
  agent: "echo",
  inputs: ["task"],
  outputs: ["result"],
  depends: [],
};

function makeRef(
  kind: ComponentKind,
  id: string,
  version: string,
  seed = "1",
): ComponentRef {
  const sha256 = createHash("sha256")
    .update(`${kind}/${id}@${version}:${seed}`)
    .digest("hex");
  return {
    kind,
    id,
    version,
    source: {
      repo: `local/${id}`,
      commit: sha256.slice(0, 40),
      ref: "local",
      sha256,
    },
  };
}

function entry(
  kind: ComponentKind,
  id: string,
  overrides: Partial<PipelineComponentEntry> = {},
): PipelineComponentEntry {
  const ref = makeRef(kind, id, "1.0.0");
  return {
    kind,
    id,
    version: ref.version,
    source: ref.source,
    description: id,
    tools: [],
    toolAdapters: {},
    workflowAgents: [],
    ...overrides,
  };
}

function inventory(
  components: PipelineComponentEntry[] = [],
  locked: ComponentRef[] = [],
): PipelineInventory {
  return { components, invalid: [], locked };
}

function facts(
  overrides: Partial<PipelineDraftFacts> = {},
): PipelineDraftFacts {
  return {
    pack: "minimal",
    agents: [{ id: "echo", role: "builder", tools: [] }],
    tools: [],
    skills: [],
    gates: [],
    workflows: [{ id: "demo", stages: [baseStage] }],
    inventory: inventory(),
    current: null,
    ...overrides,
  };
}

describe("pipeline composer", () => {
  it("falls back to the pack's existing stages when the library is empty", async () => {
    const result = await composeJob({
      kind: "pipeline",
      intent: "每日研究简报",
      packDir: "minimal",
      repoRoot,
      env,
    });

    const values = result.values as PipelineDraftValues;
    expect(result.kind).toBe("pipeline");
    expect(result.model).toBe("heuristic");
    expect(values.components).toEqual([]);
    expect(values.stages.map((stage) => stage.id)).toEqual(["echo"]);
    expect(values.stages[0]?.agent).toBe("echo");
    expect(validateStageGraph(values.stages, ["echo"]).ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("组件库为空");
  });

  it("binds a matching agent component from the inventory", async () => {
    const result = await composeJob({
      kind: "pipeline",
      intent: "use the analyst to research a daily brief",
      packDir: "minimal",
      repoRoot,
      env,
      pipeline: inventory([
        entry("agent", "analyst", { description: "Research analyst" }),
      ]),
    });

    const values = result.values as PipelineDraftValues;
    expect(result.model).toBe("heuristic");
    expect(values.components.map((component) => component.ref.id)).toEqual([
      "analyst",
    ]);
    expect(values.bindings).toHaveLength(1);
    expect(values.bindings[0]?.node).toBe("echo");
    expect(values.bindings[0]?.component.id).toBe("analyst");
    expect(values.stages[0]?.agent).toBe("analyst");
    expect(validateStageGraph(values.stages, ["analyst"]).ok).toBe(true);
  });

  it("rejects components that are not in the library", () => {
    const result = validatePipelineDraft(
      {
        id: "brief",
        stages: [baseStage],
        bindings: [{ node: "echo", kind: "agent", id: "ghost" }],
      },
      {
        id: "fallback",
        name: "Fallback",
        description: "",
        stages: [baseStage],
        components: [],
        bindings: [],
        issues: [],
      },
      facts(),
    );

    expect(result.accepted).toBe(true);
    expect(result.values.components).toEqual([]);
    expect(result.values.bindings).toEqual([]);
    expect(result.values.issues[0]).toMatchObject({
      code: "component_not_found",
      path: "agent/ghost",
    });
  });

  it("rejects a version that conflicts with the lockfile", () => {
    const locked = makeRef("agent", "analyst", "1.0.0", "old");
    const candidate = entry("agent", "analyst", {
      version: "2.0.0",
      source: makeRef("agent", "analyst", "2.0.0").source,
    });

    const result = validatePipelineDraft(
      {
        stages: [baseStage],
        bindings: [{ node: "echo", kind: "agent", id: "analyst" }],
      },
      {
        id: "fallback",
        name: "Fallback",
        description: "",
        stages: [baseStage],
        components: [],
        bindings: [],
        issues: [],
      },
      facts({ inventory: inventory([candidate], [locked]) }),
    );

    expect(result.values.components).toEqual([]);
    expect(result.values.issues[0]?.code).toBe("version_conflict");
    expect(result.values.stages[0]?.agent).toBe("echo");
  });

  it("rejects an agent component that overreaches on tools", () => {
    const candidate = entry("agent", "rogue", {
      tools: ["net_runner"],
    });

    const result = validatePipelineDraft(
      {
        stages: [baseStage],
        bindings: [{ node: "echo", kind: "agent", id: "rogue" }],
      },
      {
        id: "fallback",
        name: "Fallback",
        description: "",
        stages: [baseStage],
        components: [],
        bindings: [],
        issues: [],
      },
      facts({ inventory: inventory([candidate]) }),
    );

    expect(result.values.components).toEqual([]);
    expect(result.values.issues[0]?.code).toBe("tool_overreach");
    expect(result.warnings.join(" ")).toContain("net_runner");
  });

  it("rejects a command toolpack without explicit consent", () => {
    const candidate = entry("toolpack", "shell", {
      toolAdapters: { run_shell: "command" },
    });

    const result = validatePipelineDraft(
      {
        stages: [baseStage],
        bindings: [{ kind: "toolpack", id: "shell" }],
      },
      {
        id: "fallback",
        name: "Fallback",
        description: "",
        stages: [baseStage],
        components: [],
        bindings: [],
        issues: [],
      },
      facts({ inventory: inventory([candidate]) }),
    );

    expect(result.values.components).toEqual([]);
    expect(result.values.issues[0]?.code).toBe("tool_consent_required");
  });

  it("falls back when the live stage graph is invalid", () => {
    const fallbackValues: PipelineDraftValues = {
      id: "fallback",
      name: "Fallback",
      description: "",
      stages: [baseStage],
      components: [],
      bindings: [],
      issues: [],
    };
    const result = validatePipelineDraft(
      {
        stages: [
          {
            id: "bad",
            type: "agent",
            agent: "ghost",
            inputs: ["task"],
            outputs: ["out"],
            depends: [],
          },
        ],
      },
      fallbackValues,
      facts(),
    );

    expect(result.accepted).toBe(false);
    expect(result.values).toBe(fallbackValues);
    expect(result.warnings.join(" ")).toContain("ghost");
  });
});
