import { type Dirent, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { JobError } from "./types";

export interface ProjectTarget {
  id: string;
  name: string;
  path: string;
  source: "kit" | "workspace";
  checks: string[];
}

const CHECK_NAMES = ["typecheck", "lint", "test", "web:build", "build"];

export function resolveProjectsRoot(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.KIT_PROJECTS_ROOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.dirname(path.resolve(repoRoot));
}

export async function listProjects(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectTarget[]> {
  const root = resolveProjectsRoot(repoRoot, env);
  const selfPath = path.resolve(repoRoot);
  const projects: ProjectTarget[] = [
    await describeProject("self", selfPath, "kit"),
  ];

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return projects;
  }

  for (const entry of entries) {
    if (projects.length >= 50) {
      break;
    }
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (entry.name === "node_modules" || entry.name === "self") {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (path.resolve(dir) === selfPath) {
      continue;
    }
    if (!existsSync(path.join(dir, ".git"))) {
      continue;
    }
    projects.push(await describeProject(entry.name, dir, "workspace"));
  }
  return projects;
}

export async function resolveProject(
  repoRoot: string,
  projectId?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectTarget> {
  if (!projectId || projectId === "self") {
    return describeProject("self", path.resolve(repoRoot), "kit");
  }
  const projects = await listProjects(repoRoot, env);
  const found = projects.find((project) => project.id === projectId);
  if (!found) {
    throw new JobError(
      "project_not_found",
      `project ${projectId} was not found under the projects root`,
      404,
    );
  }
  return found;
}

async function describeProject(
  id: string,
  dir: string,
  source: ProjectTarget["source"],
): Promise<ProjectTarget> {
  return {
    id,
    name: path.basename(dir),
    path: path.resolve(dir),
    source,
    checks: await readChecks(dir),
  };
}

async function readChecks(dir: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    return CHECK_NAMES.filter((name) => typeof scripts[name] === "string");
  } catch {
    return [];
  }
}
