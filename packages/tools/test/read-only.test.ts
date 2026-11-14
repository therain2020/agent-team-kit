import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolContext, executeTool } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function context(readOnly: boolean): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-tools-ro-"));
  roots.push(root);
  const repoRoot = path.join(root, "repo");
  const sandboxRoot = path.join(root, "sandbox");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await mkdir(sandboxRoot, { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "app.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  return {
    repoRoot,
    sandboxRoot,
    runId: "run_read_only",
    workspaceId: "default",
    runMode: "LIVE",
    allowNetwork: true,
    allowLocalhost: true,
    readOnly,
  };
}

describe("read-only tool gate", () => {
  it("rejects write, execute and network tools", async () => {
    const ctx = await context(true);

    await expect(
      executeTool(
        "workspace_write",
        { path: "src/app.ts", content: "export const value = 2;\n" },
        ctx,
      ),
    ).rejects.toThrow(/side effects are paused/);

    await expect(executeTool("repo_test", {}, ctx)).rejects.toThrow(
      /side effects are paused/,
    );

    await expect(
      executeTool("http_fetch", { url: "https://example.com" }, ctx),
    ).rejects.toThrow(/side effects are paused/);
  });

  it("still allows read tools", async () => {
    const ctx = await context(true);
    const result = await executeTool("repo_read", { path: "src/app.ts" }, ctx);

    expect(result.content).toContain("export const value = 1");
  });
});
