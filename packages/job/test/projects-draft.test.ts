import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { draftJob } from "../src/draft";
import { listProjects, resolveProject } from "../src/projects";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-projects-"));
  dirs.push(root);
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  await mkdir(path.join(alpha, ".git"), { recursive: true });
  await writeFile(
    path.join(alpha, "package.json"),
    JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }),
    "utf8",
  );
  await mkdir(beta, { recursive: true });
  return { root, alpha, beta };
}

describe("project registry", () => {
  it("lists the kit repo plus git workspaces and resolves by id", async () => {
    const { root, alpha, beta } = await workspace();
    const env = { KIT_PROJECTS_ROOT: root };
    const projects = await listProjects(process.cwd(), env);

    expect(projects[0]?.id).toBe("self");
    expect(projects.some((project) => project.id === "alpha")).toBe(true);
    expect(projects.some((project) => project.id === "beta")).toBe(false);

    const alphaProject = await resolveProject(process.cwd(), "alpha", env);
    expect(alphaProject.path).toBe(path.resolve(alpha));
    expect(alphaProject.checks).toEqual(["typecheck", "test"]);

    await expect(
      resolveProject(process.cwd(), "beta", env),
    ).rejects.toMatchObject({ code: "project_not_found" });
    expect(beta).toBeTruthy();
  });
});

describe("job draft", () => {
  const env = (root: string) => ({
    KIT_PROJECTS_ROOT: root,
    KIT_MODEL_MODE: "stub",
  });

  it("maps a security goal to cyber with two tasks", async () => {
    const { root } = await workspace();
    const result = await draftJob({
      goal: "尝试找到系统的安全漏洞并修复它",
      projectId: "alpha",
      repoRoot: process.cwd(),
      env: env(root),
    });

    expect(result.model).toBe("heuristic");
    expect(result.draft.domain).toBe("cyber");
    expect(result.draft.maxTasks).toBe(2);
    expect(result.draft.applyMode).toBe("low");
    expect(result.project.id).toBe("alpha");
    expect(result.warnings.some((item) => item.includes("LIVE"))).toBe(true);
  });

  it("maps a documentation goal to docs with one task", async () => {
    const { root } = await workspace();
    const result = await draftJob({
      goal: "更新 README 文档说明",
      projectId: "alpha",
      repoRoot: process.cwd(),
      env: env(root),
    });

    expect(result.draft.domain).toBe("docs");
    expect(result.draft.maxTasks).toBe(1);
  });

  it("requires a goal", async () => {
    const { root } = await workspace();
    await expect(
      draftJob({
        goal: " ",
        projectId: "alpha",
        repoRoot: process.cwd(),
        env: env(root),
      }),
    ).rejects.toMatchObject({ code: "goal_required" });
  });
});
