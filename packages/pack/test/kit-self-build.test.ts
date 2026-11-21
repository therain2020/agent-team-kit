import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowDefinition } from "@kit/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPackRun, loadPack, rolePlanForAgents } from "../src/index";

const PACK_DIR = path.join(process.cwd(), "packs", "kit-self-build");

type Stage = WorkflowDefinition["stages"][number];

async function loadSelfBuild() {
  const loaded = await loadPack(PACK_DIR);
  if (!loaded.ok) {
    throw new Error(`pack failed to load: ${loaded.errors.join("; ")}`);
  }
  return loaded;
}

/**
 * Mirror the runtime resolution in `runPackPipeline`: a stage waits for its
 * `inputsFrom` / `inputFrom`, or for the previous stage when neither is set.
 */
function dependencyMap(stages: readonly Stage[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  stages.forEach((stage, index) => {
    const previous = stages[index - 1];
    const deps = stage.inputsFrom?.length
      ? stage.inputsFrom
      : stage.inputFrom
        ? [stage.inputFrom]
        : previous
          ? [previous.id]
          : [];
    map.set(stage.id, deps);
  });
  return map;
}

/** All stages a stage transitively depends on. */
function ancestors(map: Map<string, string[]>, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(map.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || seen.has(next)) {
      continue;
    }
    seen.add(next);
    stack.push(...(map.get(next) ?? []));
  }
  return seen;
}

/** Every stage that can never run if `id` fails. */
function descendants(map: Map<string, string[]>, id: string): string[] {
  return [...map.keys()].filter((stageId) =>
    stageId === id ? false : ancestors(map, stageId).has(id),
  );
}

describe("kit-self-build pack", () => {
  it("loads with the self-build roles and a seller-only critic", async () => {
    const loaded = await loadSelfBuild();
    const plan = rolePlanForAgents(
      loaded.agents,
      loaded.roleRules.allowCombined,
    );

    for (const id of [
      "manager",
      "architect",
      "frontend-designer",
      "backend-designer",
      "critic",
      "verifier",
    ]) {
      expect(loaded.agents.has(id)).toBe(true);
    }

    expect(loaded.roleRules.requireSeller).toBe(true);
    expect(loaded.roleRules.allowCombined).toBe(false);
    expect(plan.sellers).toEqual(["critic"]);
    expect(plan.builders.sort()).toEqual([
      "backend-designer",
      "frontend-designer",
    ]);
    expect(plan.specialists.sort()).toEqual(["architect", "verifier"]);
  });

  it("makes the critic a hard gate that blocks build, verify and observe", async () => {
    const loaded = await loadSelfBuild();
    const workflow = loaded.workflows.find((item) => item.id === "self-build");
    expect(workflow).toBeDefined();
    if (!workflow) {
      return;
    }

    const stages = workflow.stages;
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const critic = byId.get("critic");

    // The gate is wired to the critic rubric, revisions go back to the
    // architect, and `mode: never` means a gate failure throws instead of
    // silently continuing (see gateWithRevisions in @kit/engine).
    expect(critic?.gate).toBe("evals/self-build-rubrics.yaml#critic");
    expect(critic?.revisionAgent).toBe("architect");
    expect(critic?.approval?.mode).toBe("never");

    const deps = dependencyMap(stages);
    expect([...ancestors(deps, "critic")]).toEqual(
      expect.arrayContaining([
        "intake",
        "architect",
        "frontend-design",
        "backend-design",
      ]),
    );

    // A failed critic never lets the pipeline start these stages.
    expect(descendants(deps, "critic")).toEqual(
      expect.arrayContaining(["build", "verify", "observe"]),
    );

    const build = byId.get("build");
    expect(build?.type).toBe("coder");
    expect(build?.coder).toBe("dsh");
    expect(build?.inputsFrom).toEqual(expect.arrayContaining(["critic"]));
    expect(byId.get("verify")?.agent).toBe("verifier");
    expect(stages[stages.length - 1]?.id).toBe("observe");
  });

  it("builds a run spec that binds the critic gate and the dsh coder", async () => {
    const loaded = await loadSelfBuild();
    const built = await buildPackRun(loaded, {
      workflow: "self-build",
      stub: true,
    });
    const byName = new Map(
      built.input.stages.map((stage) => [stage.stageName, stage]),
    );

    const critic = byName.get("critic");
    expect(critic?.gate?.ref).toBe("evals/self-build-rubrics.yaml#critic");
    expect(critic?.revision?.agentId).toBe("architect");
    expect(critic?.approval?.mode).toBe("never");

    expect(byName.get("build")?.type).toBe("coder");
    expect(byName.get("build")?.coder).toBe("dsh");
    expect(built.input.stages.map((stage) => stage.stageName)).toEqual([
      "intake",
      "architect",
      "frontend-design",
      "backend-design",
      "critic",
      "build",
      "verify",
      "observe",
    ]);
  });

  it("ships a critic rubric with real thresholds", async () => {
    const text = await readFile(
      path.join(PACK_DIR, "evals", "self-build-rubrics.yaml"),
      "utf8",
    );
    const doc = parse(text) as {
      rubrics?: Record<
        string,
        {
          dimensions?: Record<
            string,
            {
              weight?: number;
              threshold?: number;
            }
          >;
        }
      >;
    };
    const dimensions = doc.rubrics?.critic?.dimensions ?? {};
    expect(Object.keys(dimensions).length).toBeGreaterThan(0);
    for (const dimension of Object.values(dimensions)) {
      expect(dimension.weight).toBeGreaterThan(0);
      expect(dimension.threshold).toBeGreaterThan(0);
      expect(dimension.threshold).toBeLessThanOrEqual(1);
    }
  });

  it("records the low/medium auto-merge and high-approval boundary", async () => {
    const loaded = await loadSelfBuild();
    const iteration = loaded.iteration;
    expect(iteration).toBeDefined();
    if (!iteration) {
      return;
    }

    expect(iteration.domains.frontend?.workflow).toBe("self-build");
    expect(iteration.domains.frontend?.riskCeiling).toBe("medium");
    expect(iteration.domains.backend?.workflow).toBe("self-build");
    expect(iteration.domains.backend?.riskCeiling).toBe("medium");
    expect(iteration.autoApply).toEqual({
      low: true,
      medium: true,
      high: false,
    });
  });
});
