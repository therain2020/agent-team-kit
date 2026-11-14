import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandOnPath, runProcess } from "./process";
import type { Sandbox, SandboxChanges, SandboxMode } from "./types";

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".tmp",
  ".backup",
  ".next",
  "dist",
  "variants",
  ".gstack",
]);

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

export interface CreateSandboxInput {
  repoRoot: string;
  sandboxRoot: string;
  mode?: SandboxMode;
  baseSha?: string;
  installDeps?: boolean;
  keep?: boolean;
  setupTimeoutMs?: number;
}

export async function createSandbox(
  input: CreateSandboxInput,
): Promise<Sandbox> {
  const repoRoot = path.resolve(input.repoRoot);
  const sandboxRoot = path.resolve(input.sandboxRoot);
  assertSafeSandbox(repoRoot, sandboxRoot);
  const mode = input.mode ?? "snapshot";
  const setup: string[] = [];

  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(path.dirname(sandboxRoot), { recursive: true });

  const sourceSha = await resolveSourceSha(
    repoRoot,
    input.baseSha,
    input.setupTimeoutMs ?? 60_000,
  );

  let sandboxBaseline: string;
  if (mode === "worktree") {
    const result = await runProcess(
      "git",
      ["-C", repoRoot, "worktree", "add", "--detach", sandboxRoot, sourceSha],
      {
        cwd: repoRoot,
        timeoutMs: input.setupTimeoutMs ?? 60_000,
      },
    );
    setup.push(`worktree: ${result.exitCode}`);
    if (result.exitCode !== 0) {
      throw new Error(`git worktree failed: ${result.stderr.trim()}`);
    }
    sandboxBaseline = sourceSha;
  } else if (mode === "snapshot") {
    await extractSnapshot(
      repoRoot,
      sandboxRoot,
      sourceSha,
      input.setupTimeoutMs ?? 300_000,
      setup,
    );
    sandboxBaseline = await initSandboxGit(
      sandboxRoot,
      input.setupTimeoutMs ?? 60_000,
      setup,
    );
  } else {
    await copyRepo(repoRoot, sandboxRoot);
    sandboxBaseline = await initSandboxGit(
      sandboxRoot,
      input.setupTimeoutMs ?? 60_000,
      setup,
    );
  }

  if (
    input.installDeps !== false &&
    existsSync(path.join(sandboxRoot, "bun.lock"))
  ) {
    const bun = commandOnPath("bun") ?? "bun";
    const install = await runProcess(
      bun,
      ["install", "--frozen-lockfile", "--no-progress"],
      {
        cwd: sandboxRoot,
        timeoutMs: input.setupTimeoutMs ?? 300_000,
        maxOutputBytes: 1 * 1024 * 1024,
      },
    );
    setup.push(
      `deps: exit=${install.exitCode}${install.timedOut ? " timeout" : ""}`,
    );
    if (install.exitCode !== 0) {
      setup.push(`deps detail: ${install.stderr.trim().slice(0, 2000)}`);
    }
  }

  return {
    dir: sandboxRoot,
    mode,
    baselineSha: sourceSha,
    setupLog: setup.join("\n"),
    async collect(): Promise<SandboxChanges> {
      const add = await runGit(sandboxRoot, ["add", "-A"]);
      if (add.exitCode !== 0) {
        return {
          changedFiles: [],
          diff: "",
          status: `git add failed: ${add.stderr.trim()}`,
        };
      }
      const status = await runGit(sandboxRoot, ["status", "--porcelain=v1"]);
      const names = await runGit(sandboxRoot, [
        "diff",
        "--name-status",
        sandboxBaseline,
        "--",
      ]);
      const diff = await runGit(sandboxRoot, [
        "diff",
        "--binary",
        "--no-color",
        sandboxBaseline,
        "--",
      ]);
      return {
        changedFiles: parseNames(names.stdout),
        diff: clamp(diff.stdout, MAX_DIFF_BYTES),
        status: status.stdout.trim(),
      };
    },
    async cleanup(): Promise<void> {
      if (input.keep) {
        return;
      }
      if (mode === "worktree") {
        const removed = await runGit(repoRoot, [
          "worktree",
          "remove",
          "--force",
          sandboxRoot,
        ]);
        if (removed.exitCode === 0) {
          return;
        }
      }
      await rm(sandboxRoot, { recursive: true, force: true });
    },
  };
}

async function resolveSourceSha(
  repoRoot: string,
  baseSha: string | undefined,
  timeoutMs: number,
): Promise<string> {
  const rev = await runProcess(
    "git",
    ["-C", repoRoot, "rev-parse", baseSha ?? "HEAD"],
    { cwd: repoRoot, timeoutMs },
  );
  const sha = rev.stdout.trim();
  if (rev.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`cannot resolve source commit: ${rev.stderr.trim()}`);
  }
  return sha;
}

async function extractSnapshot(
  repoRoot: string,
  sandboxRoot: string,
  baseSha: string,
  timeoutMs: number,
  setup: string[],
): Promise<void> {
  const tarPath = path.join(
    path.dirname(sandboxRoot),
    `${path.basename(sandboxRoot)}.${process.pid}.tar`,
  );
  try {
    const archive = await runProcess(
      "git",
      [
        "-C",
        repoRoot,
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "archive",
        "--format=tar",
        "--output",
        tarPath,
        baseSha,
      ],
      { cwd: repoRoot, timeoutMs },
    );
    setup.push(`archive: ${archive.exitCode}`);
    if (archive.exitCode !== 0) {
      throw new Error(`git archive failed: ${archive.stderr.trim()}`);
    }

    await mkdir(sandboxRoot, { recursive: true });
    const tar = commandOnPath("tar") ?? "tar";
    const extract = await runProcess(tar, ["-xf", tarPath, "-C", sandboxRoot], {
      cwd: sandboxRoot,
      timeoutMs,
    });
    setup.push(`extract: ${extract.exitCode}`);
    if (extract.exitCode !== 0) {
      throw new Error(`tar extract failed: ${extract.stderr.trim()}`);
    }

    await removeExcluded(sandboxRoot);
  } finally {
    await rm(tarPath, { force: true });
  }
}

async function removeExcluded(root: string): Promise<void> {
  for (const name of EXCLUDED_DIRS) {
    if (name === ".git") {
      continue;
    }
    const target = path.join(root, name);
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
    }
  }
  for (const secret of [".env", ".env.local"]) {
    const target = path.join(root, secret);
    if (existsSync(target)) {
      await rm(target, { force: true });
    }
  }
}

async function initSandboxGit(
  root: string,
  timeoutMs: number,
  setup: string[],
): Promise<string> {
  const init = await runGit(root, [
    "-c",
    "init.defaultBranch=main",
    "init",
    "-q",
  ]);
  const autocrlf = await runGit(root, ["config", "core.autocrlf", "false"]);
  const eol = await runGit(root, ["config", "core.eol", "lf"]);
  const add = await runGit(root, ["add", "-A"]);
  const commit = await runGit(root, [
    "-c",
    "user.name=kit",
    "-c",
    "user.email=kit@localhost",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
  setup.push(
    `snapshot git: init=${init.exitCode} eol=${autocrlf.exitCode}/${eol.exitCode} add=${add.exitCode} commit=${commit.exitCode}`,
  );
  if (
    init.exitCode !== 0 ||
    autocrlf.exitCode !== 0 ||
    eol.exitCode !== 0 ||
    add.exitCode !== 0 ||
    commit.exitCode !== 0
  ) {
    throw new Error(
      `snapshot git init failed: ${(init.stderr || autocrlf.stderr || eol.stderr || add.stderr || commit.stderr).trim()}`,
    );
  }
  const rev = await runGit(root, ["rev-parse", "HEAD"]);
  const sha = rev.stdout.trim();
  if (rev.exitCode !== 0 || !sha) {
    throw new Error(`snapshot baseline missing: ${rev.stderr.trim()}`);
  }
  return sha;
}

async function copyRepo(repoRoot: string, destRoot: string): Promise<void> {
  const walk = async (sourceDir: string, destDir: string): Promise<void> => {
    await mkdir(destDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (!shouldCopy(repoRoot, source)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(source, dest);
      } else if (entry.isFile()) {
        await copyFile(source, dest);
      }
    }
  };
  await walk(repoRoot, destRoot);
}

function shouldCopy(repoRoot: string, source: string): boolean {
  const relative = path.relative(repoRoot, source);
  if (!relative) {
    return true;
  }
  const parts = relative.split(path.sep);
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return false;
  }
  const name = parts[parts.length - 1] ?? "";
  if (name === ".env" || name === ".env.local") {
    return false;
  }
  if (name.endsWith(".log") || name === "tsconfig.tsbuildinfo") {
    return false;
  }
  return true;
}

function assertSafeSandbox(repoRoot: string, sandboxRoot: string): void {
  if (repoRoot === sandboxRoot) {
    throw new Error("sandbox must not be the repository root");
  }
  const inRepo = sandboxRoot.startsWith(`${repoRoot}${path.sep}`);
  const inTemp = sandboxRoot.startsWith(
    `${path.resolve(os.tmpdir())}${path.sep}`,
  );
  if (!inRepo && !inTemp) {
    throw new Error("sandbox must live under the repository or the temp dir");
  }
}

async function runGit(cwd: string, args: string[]) {
  return await runProcess("git", args, {
    cwd,
    timeoutMs: 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
}

function parseNames(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const file = parts[parts.length - 1] ?? "";
    if (file) {
      files.add(file);
    }
  }
  return [...files].sort();
}

function clamp(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n[truncated at ${max} bytes]`;
}
