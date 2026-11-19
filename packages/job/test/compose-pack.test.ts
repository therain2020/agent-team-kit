import { describe, expect, it } from "vitest";
import { composeJob } from "../src/compose";
import {
  MAX_PACK_AGENTS,
  type PackComposeDraft,
  type PackDraftValues,
  composePackDraft,
  validatePackCreation,
} from "../src/compose-pack";

const repoRoot = process.cwd();
const env = { KIT_MODEL_MODE: "stub" };

function expectValidDraft(draft: PackComposeDraft) {
  const values = draft.values;
  expect(values.dirName).toMatch(/^[a-z][a-z0-9-]*$/);
  expect(values.name.length).toBeGreaterThan(0);
  expect(values.template.length).toBeGreaterThan(0);
  expect(values.manager.model.length).toBeGreaterThan(0);
  expect(values.manager.instructions.length).toBeGreaterThan(0);
  expect(values.agents.length).toBeGreaterThan(0);
  expect(values.agents.length).toBeLessThanOrEqual(MAX_PACK_AGENTS);
  for (const agent of values.agents) {
    expect(agent.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(agent.id).not.toBe("manager");
    expect(["builder", "seller", "specialist"]).toContain(agent.role);
    expect(agent.model.length).toBeGreaterThan(0);
    expect(agent.instructions.length).toBeGreaterThan(0);
  }
}

describe("pack composer", () => {
  it("drafts a new pack via composeJob without an existing directory", async () => {
    const result = await composeJob({
      kind: "pack",
      intent: "research team that tracks papers and writes short briefs",
      packDir: "",
      repoRoot,
      env,
    });

    expect(result.kind).toBe("pack");
    expect(result.model).toBe("heuristic");
    expectValidDraft({
      values: result.values as PackDraftValues,
      rationale: result.rationale,
      warnings: result.warnings,
      model: result.model,
    });
  });

  it("picks a template whose name appears in the intent", async () => {
    const draft = await composePackDraft(
      "research team that tracks papers and writes short briefs",
      { env },
    );
    expect(draft.values.template).toBe("research");
    expect(draft.model).toBe("heuristic");
    expectValidDraft(draft);
  });

  it("honours an explicitly requested template", async () => {
    const draft = await composePackDraft("build a small content team", {
      templateId: "content",
      env,
    });
    expect(draft.values.template).toBe("content");
    expectValidDraft(draft);
  });

  it("requires an intent", async () => {
    await expect(composePackDraft("   ", { env })).rejects.toMatchObject({
      code: "intent_required",
    });
  });
});

describe("pack creation validation", () => {
  const base = {
    dirName: "my-team",
    name: "My Team",
    managerModel: "deepseek-pro",
    agents: [
      { id: "worker", role: "builder", model: "deepseek-flash" },
      { id: "reviewer", role: "specialist", model: "deepseek-pro" },
    ],
  };

  it("accepts a valid draft", () => {
    expect(validatePackCreation(base, env)).toEqual([]);
  });

  it("rejects an invalid dirName", () => {
    const errors = validatePackCreation({ ...base, dirName: "Bad Dir" }, env);
    expect(errors.join(" ")).toContain("dirName");
  });

  it("rejects the reserved manager id and role", () => {
    const errors = validatePackCreation(
      {
        ...base,
        agents: [{ id: "manager", role: "builder", model: "deepseek-flash" }],
      },
      env,
    );
    const text = errors.join(" ");
    expect(text).toContain("reserved");
  });

  it("rejects an invalid role", () => {
    const errors = validatePackCreation(
      {
        ...base,
        agents: [{ id: "wizard", role: "wizard", model: "deepseek-flash" }],
      },
      env,
    );
    expect(errors.join(" ")).toContain("role is invalid");
  });

  it("rejects a model outside the whitelist", () => {
    const errors = validatePackCreation(
      {
        ...base,
        agents: [{ id: "worker", role: "builder", model: "gpt-4" }],
      },
      env,
    );
    expect(errors.join(" ")).toContain("model is not allowed");
  });

  it("rejects duplicate ids and more than the agent cap", () => {
    const tooMany = Array.from({ length: MAX_PACK_AGENTS + 1 }, (_, index) => ({
      id: index <= 1 ? "worker" : `worker-${index}`,
      role: "builder",
      model: "deepseek-flash",
    }));
    const errors = validatePackCreation({ ...base, agents: tooMany }, env);
    const text = errors.join(" ");
    expect(text).toContain("duplicated");
    expect(text).toContain(`at most ${MAX_PACK_AGENTS} agents`);
  });
});
