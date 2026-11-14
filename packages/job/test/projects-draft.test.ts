import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { draftJob } from "../src/draft";
import {
  listProjects,
  resolveCanonicalRepoRoot,
  resolveProject,
  resolveProjectTarget,
} from "../src/projects";

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
  const linked = path.join(root, "linked");
  await mkdir(path.join(alpha, ".git"), { recursive: true });
  await writeFile(
    path.join(alpha, "package.json"),
    JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }),
    "utf8",
  );
  await mkdir(beta, { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(
    path.join(linked, ".git"),
    "gitdir: ../alpha/.git/worktrees/linked\n",
    "utf8",
  );
  return { root, alpha, beta, linked };
}

describe("project registry", () => {
  it("lists the kit repo plus git workspaces and resolves by id", async () => {
    const { root, alpha, beta, linked } = await workspace();
    const env = { KIT_PROJECTS_ROOT: root };
    const projects = await listProjects(process.cwd(), env);

    expect(projects[0]?.id).toBe("self");
    expect(projects[0]?.path).toBe(resolveCanonicalRepoRoot(process.cwd()));
    expect(projects.some((project) => project.id === "alpha")).toBe(true);
    expect(projects.some((project) => project.id === "beta")).toBe(false);
    expect(projects.some((project) => project.id === "linked")).toBe(false);

    const alphaProject = await resolveProject(process.cwd(), "alpha", env);
    expect(alphaProject.path).toBe(path.resolve(alpha));
    expect(alphaProject.checks).toEqual(["typecheck", "test"]);

    await expect(
      resolveProject(process.cwd(), "beta", env),
    ).rejects.toMatchObject({ code: "project_not_found" });
    await expect(
      resolveProject(process.cwd(), "linked", env),
    ).rejects.toMatchObject({ code: "project_not_found" });
    expect(beta).toBeTruthy();
    expect(linked).toBeTruthy();
  });
});

describe("canonical repo root", () => {
  it("maps a linked worktree to the main checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-canonical-"));
    dirs.push(root);
    git(["init", "-q"], root);
    git(["config", "user.email", "test@example.com"], root);
    git(["config", "user.name", "test"], root);
    await writeFile(path.join(root, "README.md"), "# test\n", "utf8");
    git(["add", "."], root);
    git(["commit", "-qm", "init"], root);
    const worktree = path.join(root, "linked-wt");
    git(["worktree", "add", "--detach", worktree], root);

    expect(realpathSync.native(resolveCanonicalRepoRoot(worktree))).toBe(
      realpathSync.native(root),
    );
    expect(realpathSync.native(resolveCanonicalRepoRoot(root))).toBe(
      realpathSync.native(root),
    );
  });
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function gitRepo(branch: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-target-"));
  dirs.push(root);
  git(["init", "-q"], root);
  git(["symbolic-ref", "HEAD", `refs/heads/${branch}`], root);
  git(["config", "user.email", "test@example.com"], root);
  git(["config", "user.name", "test"], root);
  await writeFile(path.join(root, "README.md"), "# target\n", "utf8");
  git(["add", "."], root);
  git(["commit", "-qm", "init"], root);
  return root;
}

describe("project path and branch guard", () => {
  it("accepts any local git folder and reports its branch", async () => {
    const root = await gitRepo("main");
    const project = await resolveProjectTarget(process.cwd(), {
      projectPath: root,
    });

    expect(realpathSync.native(project.path)).toBe(realpathSync.native(root));
    expect(project.id).toBe(path.basename(root));
    expect(project.branch).toBe("main");
    expect(project.defaultBranch).toBe("main");
    expect(project.onDefaultBranch).toBe(true);
  });

  it("warns when the target is not on the default branch", async () => {
    const root = await gitRepo("main");
    git(["checkout", "-q", "-b", "feature"], root);
    const project = await resolveProjectTarget(process.cwd(), {
      projectPath: root,
    });
    expect(project.branch).toBe("feature");
    expect(project.defaultBranch).toBe("main");
    expect(project.onDefaultBranch).toBe(false);

    const result = await draftJob({
      goal: "更新 README 文档说明",
      projectPath: root,
      repoRoot: process.cwd(),
      env: { KIT_MODEL_MODE: "stub" },
    });
    expect(result.project.onDefaultBranch).toBe(false);
    expect(result.warnings.some((item) => item.includes("不是默认分支"))).toBe(
      true,
    );
  });

  it("rejects a folder that is not a git work tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-not-git-"));
    dirs.push(root);
    await expect(
      resolveProjectTarget(process.cwd(), { projectPath: root }),
    ).rejects.toMatchObject({ code: "not_a_git_repo" });
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
