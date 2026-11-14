import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPack,
  loadPack,
  readPackFile,
  setStageApproval,
  updateAgent,
} from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pack studio", () => {
  it("creates a template pack, edits the manager and sets a stage approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-studio-"));
    roots.push(root);
    await createPack({
      root,
      dirName: "demo-team",
      name: "Demo Team",
      template: "research",
      managerInstructions: "Handle exceptions and keep the evidence honest.",
    });

    const dir = path.join(root, "demo-team");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.pack.manager?.agent).toBe("agents/manager.md");
    expect(loaded.agents.has("writer")).toBe(true);
    expect(loaded.autopilot?.enabled).toBe(false);

    await updateAgent(dir, "manager", {
      description: "Lead the research team",
      model: "deepseek-pro",
      role: "manager",
      tools: [],
      skills: [],
      instructions: "You are the manager. Escalate only real exceptions.",
    });
    const manager = await readFile(
      path.join(dir, "agents", "manager.md"),
      "utf8",
    );
    expect(manager).toContain("Lead the research team");
    expect(manager).toContain("Escalate only real exceptions");

    await setStageApproval(dir, "workflows/starter.yaml", "researcher", {
      mode: "auto",
      position: "before",
      riskClass: "high",
      ttl: "1h",
      autoApproveWhen: { maxRunCostCny: 0.25 },
    });

    const updated = await loadPack(dir);
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }
    const stage = updated.workflows[0]?.stages[0];
    expect(stage?.approval?.mode).toBe("auto");
    expect(stage?.approval?.position).toBe("before");
    expect(stage?.approval?.riskClass).toBe("high");
    expect(stage?.approval?.autoApproveWhen?.maxRunCostCny).toBe(0.25);

    const workflow = await readPackFile(dir, "workflows/starter.yaml");
    expect(workflow).toContain("approval:");
    expect(workflow).toContain("autoApproveWhen:");
  });

  it("creates a product team with seller/builder/verifier roles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-product-"));
    roots.push(root);
    await createPack({
      root,
      dirName: "product-team",
      name: "Product Team",
      template: "product",
    });
    const dir = path.join(root, "product-team");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.agents.get("seller")?.role).toBe("seller");
    expect(loaded.agents.get("builder")?.role).toBe("builder");
    expect(loaded.agents.get("verifier")?.role).toBe("specialist");
    expect(loaded.roleRules.requireSeller).toBe(true);
    expect(loaded.roleRules.allowCombined).toBe(false);
    const workflow = loaded.workflows[0];
    expect(workflow?.stages.map((stage) => stage.id)).toEqual([
      "clarify",
      "build",
      "verify",
      "package",
    ]);
  });

  it("rejects path traversal on raw file reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kit-studio-"));
    roots.push(root);
    await createPack({
      root,
      dirName: "safe-team",
      name: "Safe Team",
      template: "minimal",
    });
    await expect(
      readPackFile(path.join(root, "safe-team"), "../team.yaml"),
    ).rejects.toThrow();
  });
});
