import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPack, simulatePack } from "@kit/pack";
import { describe, expect, it } from "vitest";

describe("team packs", () => {
  it("validates the minimal pack", async () => {
    const result = await loadPack("packs/minimal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agents.size).toBe(1);
      expect(result.workflows).toHaveLength(1);
    }
  });

  it("validates the tech-radar pack", async () => {
    const result = await loadPack("packs/tech-radar");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agents.size).toBe(3);
      expect(result.skills.size).toBe(1);
      expect(result.workflows).toHaveLength(2);
    }
  });

  it("simulates agent stages and cost", async () => {
    const result = await loadPack("packs/tech-radar");
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }

    const report = simulatePack(result);
    const daily = report.workflows.find(
      (workflow) => workflow.id === "daily-radar",
    );

    expect(daily).toBeDefined();
    if (!daily) {
      throw new Error("daily-radar missing");
    }
    expect(daily.stages.filter((stage) => stage.type === "agent")).toHaveLength(
      3,
    );
    expect(daily.totalCostCny).toBeGreaterThan(0);
  });

  it("rejects a pack with a missing agent file", async () => {
    const dir = path.resolve(".tmp/invalid-pack");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "team.yaml"),
      `apiVersion: agentteam/v1
kind: TeamPack
metadata:
  name: invalid
  version: 1.0.0
  compatibility:
    kit: ">=0.1 <2.0"
agents:
  - id: ghost
    file: agents/ghost.md
    model: deepseek-flash
workflows:
  - workflows/demo.yaml
policies: []
`,
      "utf8",
    );

    const result = await loadPack(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("agent file missing");
    }
  });
});
