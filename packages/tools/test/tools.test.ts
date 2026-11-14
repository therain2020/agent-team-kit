import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolContext, executeTool, toolDefinitions } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function context(): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-tools-"));
  roots.push(root);
  const repoRoot = path.join(root, "repo");
  const sandboxRoot = path.join(root, "sandbox");
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await mkdir(sandboxRoot, { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "app.ts"),
    "export function run(value: string) { return eval(value); }\n",
    "utf8",
  );
  return {
    repoRoot,
    sandboxRoot,
    runId: "run_test",
    workspaceId: "default",
    runMode: "DRY_RUN",
    allowNetwork: false,
    allowLocalhost: true,
  };
}

describe("tool registry", () => {
  it("exposes only requested known tools", () => {
    const definitions = toolDefinitions([
      "repo_read",
      "security_scan_code",
      "not-a-tool",
    ]);
    expect(definitions.map((tool) => tool.name)).toEqual([
      "repo_read",
      "security_scan_code",
    ]);
  });

  it("blocks path traversal", async () => {
    const ctx = await context();
    await expect(
      executeTool("repo_read", { path: "../../secret.txt" }, ctx),
    ).rejects.toThrow(/escapes/);
  });

  it("writes a sandbox patch and shows a unified diff", async () => {
    const ctx = await context();
    await executeTool(
      "workspace_write",
      { path: "src/app.ts", content: "export const safe = true;\n" },
      ctx,
    );
    const diff = await executeTool("workspace_diff", {}, ctx);
    expect(diff.content).toContain("-export function run");
    expect(diff.content).toContain("+export const safe = true;");
  });

  it("finds code security patterns without leaking the match", async () => {
    const ctx = await context();
    const result = await executeTool("security_scan_code", {}, ctx);
    expect(result.content).toContain("eval");
    expect(result.content).toContain("src/app.ts");
    expect(result.content).not.toContain("return eval(value)");
  });

  it("flags unpinned dependencies", async () => {
    const ctx = await context();
    await writeFile(
      path.join(ctx.repoRoot, "package.json"),
      JSON.stringify({
        dependencies: { risky: "*", remote: "git:https://example.com/x" },
      }),
      "utf8",
    );
    const result = await executeTool("security_scan_dependencies", {}, ctx);
    expect(result.content).toContain("risky");
    expect(result.content).toContain("unpinned");
  });
});
