import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPack,
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  loadPack,
  renameWorkflow,
} from "../src";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makePack() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-flow-"));
  roots.push(root);
  await createPack({
    root,
    dirName: "demo-team",
    name: "Demo Team",
    template: "research",
  });
  return path.join(root, "demo-team");
}

describe("workflow CRUD", () => {
  it("creates, lists, renames and deletes a workflow", async () => {
    const dir = await makePack();

    const created = await createWorkflow(dir, { id: "review-loop" });
    expect(created.file).toBe("workflows/review-loop.yaml");
    expect((await listWorkflows(dir)).map((item) => item.id)).toEqual(
      expect.arrayContaining(["starter", "review-loop"]),
    );

    const renamed = await renameWorkflow(dir, {
      file: "workflows/review-loop.yaml",
      newFile: "workflows/review-v2.yaml",
      newId: "review-v2",
    });
    expect(renamed.id).toBe("review-v2");
    const afterRename = await listWorkflows(dir);
    expect(afterRename.map((item) => item.id)).toContain("review-v2");
    expect(afterRename.map((item) => item.id)).not.toContain("review-loop");

    await deleteWorkflow(dir, "workflows/review-v2.yaml");
    const afterDelete = await listWorkflows(dir);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.id).toBe("starter");

    const team = await readFile(path.join(dir, "team.yaml"), "utf8");
    expect(team).not.toContain("review-v2");
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
  });

  it("refuses to delete the last workflow", async () => {
    const dir = await makePack();
    await expect(deleteWorkflow(dir, "workflows/starter.yaml")).rejects.toThrow(
      "at least one workflow",
    );
    const loaded = await loadPack(dir);
    expect(loaded.ok).toBe(true);
  });

  it("rejects invalid ids and duplicate files", async () => {
    const dir = await makePack();
    await expect(createWorkflow(dir, { id: "Bad Id" })).rejects.toThrow();
    await expect(
      createWorkflow(dir, {
        id: "starter",
        file: "workflows/starter.yaml",
      }),
    ).rejects.toThrow();
  });
});
