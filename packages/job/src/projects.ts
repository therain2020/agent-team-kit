import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, realpathSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { JobError } from "./types";

export interface ProjectTarget {
  id: string;
  name: string;
  path: string;
  source: "kit" | "workspace";
  checks: string[];
  /** Filled by resolveProjectTarget; listProjects keeps the list cheap. */
  branch?: string | null;
  defaultBranch?: string | null;
  onDefaultBranch?: boolean;
}

export interface ProjectSelector {
  projectId?: string;
  /** Arbitrary local folder; normalized to the repository's main worktree. */
  projectPath?: string;
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

/**
 * Linked worktrees and submodules carry a `.git` file pointing at the main
 * repository. `self` must always name the main checkout: isolation is provided
 * by the coder snapshot sandbox, not by asking the operator to pick a worktree.
 */
export function resolveCanonicalRepoRoot(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", resolved, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (commonDir) {
      const absolute = path.resolve(resolved, commonDir);
      if (path.basename(absolute) === ".git") {
        return path.normalize(path.dirname(absolute));
      }
    }
  } catch {
    // Not a git repository or git unavailable: keep the given directory.
  }
  return resolved;
}

function isLinkedWorktree(dir: string): boolean {
  try {
    return statSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

function realKey(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function gitOutput(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

export function isGitWorkTree(dir: string): boolean {
  return gitOutput(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export function currentBranch(dir: string): string | null {
  const branch = gitOutput(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    return null;
  }
  return branch;
}

function hasBranch(root: string, name: string): boolean {
  return Boolean(
    gitOutput(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]),
  );
}

const remoteDefaultCache = new Map<
  string,
  { name: string | null; at: number }
>();
const REMOTE_DEFAULT_TTL_MS = 5 * 60_000;

function remoteDefaultBranch(root: string): string | null {
  const cached = remoteDefaultCache.get(root);
  if (cached && Date.now() - cached.at < REMOTE_DEFAULT_TTL_MS) {
    return cached.name;
  }
  let name: string | null = null;
  try {
    const out = execFileSync(
      "git",
      ["-C", root, "ls-remote", "--symref", "origin", "HEAD"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
      },
    );
    name = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null;
  } catch {
    name = null;
  }
  remoteDefaultCache.set(root, { name, at: Date.now() });
  return name;
}

/**
 * Ask the remote first: cached `origin/HEAD` can be stale (agent-team-kit's
 * default moved to `develop` while the local ref still names an old branch).
 * Offline fallback keeps long-lived branches ahead of the cached ref.
 */
export function resolveDefaultBranch(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const root = resolveCanonicalRepoRoot(dir);
  const configured = env.KIT_DEFAULT_BRANCH?.trim();
  if (configured && hasBranch(root, configured)) {
    return configured;
  }
  const remote = remoteDefaultBranch(root);
  if (remote && hasBranch(root, remote)) {
    return remote;
  }
  for (const name of ["main", "master", "develop"]) {
    if (hasBranch(root, name)) {
      return name;
    }
  }
  const originHead = gitOutput(root, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead) {
    const name = originHead.replace(/^origin\//, "");
    if (name && hasBranch(root, name)) {
      return name;
    }
  }
  return currentBranch(root);
}

function withBranchState(
  project: ProjectTarget,
  env: Record<string, string | undefined> = process.env,
): ProjectTarget {
  const branch = currentBranch(project.path);
  const defaultBranch = resolveDefaultBranch(project.path, env);
  return {
    ...project,
    branch,
    defaultBranch,
    onDefaultBranch:
      branch !== null && defaultBranch !== null && branch === defaultBranch,
  };
}

export async function listProjects(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectTarget[]> {
  const selfPath = resolveCanonicalRepoRoot(repoRoot);
  const root = resolveProjectsRoot(selfPath, env);
  const projects: ProjectTarget[] = [
    await describeProject("self", selfPath, "kit"),
  ];
  const seen = new Set([realKey(selfPath)]);

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
    if (isLinkedWorktree(dir)) {
      continue;
    }
    if (!existsSync(path.join(dir, ".git"))) {
      continue;
    }
    const key = realKey(dir);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    projects.push(await describeProject(entry.name, dir, "workspace"));
  }
  return projects;
}

export async function resolveProjectTarget(
  repoRoot: string,
  selector: ProjectSelector,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectTarget> {
  const requested = selector.projectPath?.trim();
  if (requested) {
    const resolved = path.resolve(repoRoot, requested);
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(resolved);
    } catch {
      stat = null;
    }
    if (!stat) {
      throw new JobError(
        "project_not_found",
        `project path does not exist: ${resolved}`,
        404,
      );
    }
    if (!stat.isDirectory()) {
      throw new JobError(
        "project_not_found",
        `project path is not a directory: ${resolved}`,
        400,
      );
    }
    const canonical = resolveCanonicalRepoRoot(resolved);
    if (!isGitWorkTree(canonical)) {
      throw new JobError(
        "not_a_git_repo",
        `project path is not a git work tree: ${resolved}`,
        400,
      );
    }
    return withBranchState(
      await describeProject(path.basename(canonical), canonical, "workspace"),
      env,
    );
  }
  return withBranchState(
    await resolveProject(repoRoot, selector.projectId, env),
    env,
  );
}

export async function resolveProject(
  repoRoot: string,
  projectId?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProjectTarget> {
  if (!projectId || projectId === "self") {
    return describeProject("self", resolveCanonicalRepoRoot(repoRoot), "kit");
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
