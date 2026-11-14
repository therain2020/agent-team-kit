import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgent,
  createManager,
  createPack,
  createWorkflow,
  deleteAgent,
  deleteManager,
  listEditablePackFiles,
  loadPack,
  packCatalog,
  readPackFile,
  updateAgent,
  updateStageFields,
  writeValidatedPackFile,
} from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makePack(template = "minimal") {
  const root = await mkdtemp(path.join(tmpdir(), "kit-edit-"));
  roots.push(root);
  const dirName = `${template}-team`;
  await createPack({
    root,
    dirName,
    name: `${template} team`,
    template,
  });
  return path.join(root, dirName);
}

describe("workshop editing loop", () => {
  it("creates a manager-only pack from the blank template", async () => {
    const dir = await makePack("blank");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.pack.agents.map((agent) => agent.id)).toEqual(["manager"]);
    expect(loaded.workflows[0]?.stages[0]?.agent).toBe("manager");
    expect(loaded.roleRules.requireBuilder).toBe(false);
  });

  it("rejects unknown tool names when saving an agent", async () => {
    const dir = await makePack();
    const before = await readFile(
      path.join(dir, "agents", "worker.md"),
      "utf8",
    );

    await expect(
      updateAgent(dir, "worker", {
        description: "Worker",
        model: "deepseek-flash",
        role: "builder",
        tools: ["not-a-tool"],
        skills: [],
        instructions: "Do the work.",
      }),
    ).rejects.toThrow(/unknown tool/);

    const after = await readFile(path.join(dir, "agents", "worker.md"), "utf8");
    expect(after).toBe(before);
  });

  it("deletes an unreferenced agent and cleans workspace membership", async () => {
    const dir = await makePack();
    await createAgent(dir, { id: "helper", description: "Extra help" });
    await deleteAgent(dir, "helper");

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.agents.has("helper")).toBe(false);
    expect(loaded.pack.workspaces?.default?.agents).not.toContain("helper");
  });

  it("refuses to delete an agent that a workflow still references", async () => {
    const dir = await makePack();
    await expect(deleteAgent(dir, "worker")).rejects.toThrow(
      /referenced by workflow/,
    );
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.agents.has("worker")).toBe(true);
  });

  it("deletes and recreates the manager", async () => {
    const dir = await makePack();
    await deleteManager(dir);
    const withoutManager = await loadPack(dir);
    expect(withoutManager.ok).toBe(true);
    if (!withoutManager.ok) {
      return;
    }
    expect(withoutManager.pack.manager).toBeUndefined();

    await createManager(dir, { model: "deepseek-pro" });
    const restored = await loadPack(dir);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }
    expect(restored.pack.manager?.agent).toBe("agents/manager.md");
    expect(restored.agents.has("manager")).toBe(true);
  });

  it("updates structured stage fields and persists dependencies", async () => {
    const dir = await makePack();
    await createWorkflow(dir, {
      id: "extra",
      content: `id: extra
version: "1.0"
trigger:
  event: task.received
stages:
  - {id: worker, type: agent, agent: worker, inputs: [task], outputs: [out]}
  - {id: review, type: agent, agent: worker, inputs: [out], outputs: [final]}
`,
    });

    await updateStageFields(dir, "workflows/extra.yaml", "review", {
      inputsFrom: ["worker"],
      timeout: "5m",
      gate: null,
      includeInitialInput: true,
    });

    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const workflow = loaded.workflows.find((item) => item.id === "extra");
    const stage = workflow?.stages.find((item) => item.id === "review");
    expect(stage?.inputsFrom).toEqual(["worker"]);
    expect(stage?.timeout).toBe("5m");
    expect(stage?.includeInitialInput).toBe(true);
  });

  it("rolls back a stage save when a dependency is invalid", async () => {
    const dir = await makePack();
    const before = await readPackFile(dir, "workflows/starter.yaml");
    await expect(
      updateStageFields(dir, "workflows/starter.yaml", "worker", {
        inputsFrom: ["missing"],
      }),
    ).rejects.toThrow(/upstream|missing/i);
    const after = await readPackFile(dir, "workflows/starter.yaml");
    expect(after).toBe(before);
  });

  it("writes iteration.yaml and rolls back invalid content", async () => {
    const dir = await makePack();
    const valid = `apiVersion: agentteam/v1
kind: IterationPack
planner:
  model: deepseek-pro
  maxTasks: 4
domains: {}
autoApply:
  low: true
  medium: false
  high: false
`;
    await writeValidatedPackFile(dir, "iteration.yaml", valid);
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.iteration?.planner.maxTasks).toBe(4);

    await expect(
      writeValidatedPackFile(
        dir,
        "iteration.yaml",
        "planner:\n  maxTasks: 99\n",
      ),
    ).rejects.toThrow();
    expect(await readPackFile(dir, "iteration.yaml")).toBe(valid);
  });

  it("rejects secrets in validated file writes", async () => {
    const dir = await makePack();
    const before = await readPackFile(dir, "policies/autonomy.yaml");
    const fakeToken = `gh${"p_"}${"a".repeat(24)}`;
    await expect(
      writeValidatedPackFile(
        dir,
        "policies/autonomy.yaml",
        `version: 1\nactions:\n  - {match: "x", class: "A"}\n# ${fakeToken}\n`,
      ),
    ).rejects.toThrow(/possible secret/);
    expect(await readPackFile(dir, "policies/autonomy.yaml")).toBe(before);
  });

  it("lists editable files and the tool/skill catalog", async () => {
    const dir = await makePack();
    const files = await listEditablePackFiles(dir);
    expect(files).toContain("team.yaml");
    expect(files).toContain("policies/autonomy.yaml");

    const catalog = await packCatalog(dir);
    expect(catalog.tools.map((tool) => tool.name)).toContain("repo_read");
    expect(catalog.tools.some((tool) => tool.source === "builtin")).toBe(true);
    expect(Array.isArray(catalog.skills)).toBe(true);
  });
});
