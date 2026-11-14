import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandOnPath, runProcess } from "./process";
import type { Sandbox, SandboxChanges } from "./types";

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
  mode?: "copy" | "worktree";
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
  const mode = input.mode ?? "copy";
  const setup: string[] = [];

  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(path.dirname(sandboxRoot), { recursive: true });

  if (mode === "worktree") {
    const result = await runProcess(
      "git",
      ["-C", repoRoot, "worktree", "add", "--detach", sandboxRoot, "HEAD"],
      {
        cwd: repoRoot,
        timeoutMs: input.setupTimeoutMs ?? 60_000,
      },
    );
    setup.push(`worktree: ${result.exitCode}`);
    if (result.exitCode !== 0) {
      throw new Error(`git worktree failed: ${result.stderr.trim()}`);
    }
  } else {
    await copyRepo(repoRoot, sandboxRoot);
    const init = await runGit(sandboxRoot, [
      "-c",
      "init.defaultBranch=main",
      "init",
      "-q",
    ]);
    const add = await runGit(sandboxRoot, ["add", "-A"]);
    const commit = await runGit(sandboxRoot, [
      "-c",
      "user.name=kit",
      "-c",
      "user.email=kit@localhost",
      "commit",
      "-q",
      "-m",
      "baseline",
    ]);
    setup.push(
      `copy+git: init=${init.exitCode} add=${add.exitCode} commit=${commit.exitCode}`,
    );
    if (init.exitCode !== 0 || add.exitCode !== 0 || commit.exitCode !== 0) {
      setup.push(
        `git init/add/commit detail: ${(init.stderr || add.stderr || commit.stderr).trim()}`,
      );
    }
  }

  const rev = await runGit(sandboxRoot, ["rev-parse", "HEAD"]);
  const baselineSha = rev.stdout.trim();
  if (rev.exitCode !== 0 || !baselineSha) {
    throw new Error(`sandbox baseline missing: ${rev.stderr.trim()}`);
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
    baselineSha,
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
        baselineSha,
        "--",
      ]);
      const diff = await runGit(sandboxRoot, [
        "diff",
        "--binary",
        "--no-color",
        baselineSha,
        "--",
      ]);
      return {
        changedFiles: parseNames(names.stdout),
        diff: clamp(diff.stdout, MAX_DIFF_BYTES),
        status: status.stdout.trim(),
      };
    },
    async cleanup(): Promise<void> {
      if (input.keep || process.env.KIT_CODER_KEEP === "1") {
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
