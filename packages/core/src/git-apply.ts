import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FileLockTimeoutError, acquireFileLock } from "./fs-lock";

const execFileAsync = promisify(execFile);

export interface ApplyPatchOptions {
  repoRoot: string;
  patchFile: string;
  baseSha: string;
  changedFiles: string[];
  ticketId: string;
  commitMessage: string;
  lockPath?: string;
  lockTimeoutMs?: number;
  staleMs?: number;
  format?: (repoRoot: string) => Promise<void>;
  postCheck?: (repoRoot: string) => Promise<{ ok: boolean; feedback: string }>;
}

export interface ApplyPatchResult {
  status: "applied" | "blocked" | "reverted";
  reason: string;
  headBefore: string;
  baseDrifted: boolean;
  commitSha?: string;
}

export async function applyPatchToRepo(
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const result = (
    status: ApplyPatchResult["status"],
    reason: string,
    extra: {
      headBefore?: string;
      baseDrifted?: boolean;
      commitSha?: string;
    } = {},
  ): ApplyPatchResult => ({
    status,
    reason,
    headBefore: extra.headBefore ?? "",
    baseDrifted: extra.baseDrifted ?? false,
    ...(extra.commitSha ? { commitSha: extra.commitSha } : {}),
  });

  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(
      options.lockPath ?? defaultLockPath(repoRoot),
      {
        owner: `apply:${options.ticketId}`,
        timeoutMs: options.lockTimeoutMs ?? 45 * 60 * 1000,
        staleMs: options.staleMs ?? 15 * 60 * 1000,
        heartbeatMs: 10_000,
      },
    );
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      return result("blocked", `apply lock timeout: ${error.message}`);
    }
    throw error;
  }

  let headBefore = "";
  let baseDrifted = false;
  try {
    const status = await runGit(repoRoot, ["status", "--porcelain"]);
    if (status.exitCode !== 0) {
      return result(
        "blocked",
        `cannot read git status: ${status.stderr.slice(0, 1000)}`,
      );
    }
    if (status.stdout.trim()) {
      return result(
        "blocked",
        "working tree is not clean; patch left for review",
      );
    }

    const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
    headBefore = head.stdout.trim();
    if (head.exitCode !== 0 || !headBefore) {
      return result("blocked", "cannot resolve HEAD");
    }
    baseDrifted = headBefore !== options.baseSha;

    const check = await runGit(repoRoot, [
      "apply",
      "--check",
      "--3way",
      options.patchFile,
    ]);
    if (check.exitCode !== 0) {
      return result(
        "blocked",
        `${baseDrifted ? "stale base; " : ""}patch does not apply cleanly: ${check.stderr.slice(0, 1000)}`,
        { headBefore, baseDrifted },
      );
    }

    if (!lock.isHeld()) {
      return result("blocked", "apply lock lost before patch", {
        headBefore,
        baseDrifted,
      });
    }

    const applied = await runGit(repoRoot, [
      "apply",
      "--index",
      "--3way",
      options.patchFile,
    ]);
    if (applied.exitCode !== 0) {
      await restorePatchFiles(repoRoot, options.changedFiles);
      return result(
        "blocked",
        `git apply failed: ${applied.stderr.slice(0, 1000)}`,
        {
          headBefore,
          baseDrifted,
        },
      );
    }

    if (options.format) {
      await options.format(repoRoot);
      const formatted = await runGit(repoRoot, ["diff", "--name-only", "HEAD"]);
      const formattedFiles = normalizeFiles(formatted.stdout);
      if (formattedFiles.length > 0) {
        await runGit(repoRoot, ["add", "--", ...formattedFiles]);
      }
    }

    const staged = await runGit(repoRoot, ["diff", "--cached", "--name-only"]);
    const expected = normalizeFiles(options.changedFiles.join("\n"));
    if (!sameSet(normalizeFiles(staged.stdout), expected)) {
      await restorePatchFiles(repoRoot, options.changedFiles);
      return result("blocked", "staged files do not match patch", {
        headBefore,
        baseDrifted,
      });
    }
    if (!lock.isHeld()) {
      await restorePatchFiles(repoRoot, options.changedFiles);
      return result("blocked", "apply lock lost before commit", {
        headBefore,
        baseDrifted,
      });
    }

    const commit = await runGit(repoRoot, [
      "-c",
      "user.name=kit",
      "-c",
      "user.email=kit@localhost",
      "commit",
      "-m",
      options.commitMessage,
    ]);
    if (commit.exitCode !== 0) {
      await restorePatchFiles(repoRoot, options.changedFiles);
      return result(
        "blocked",
        `commit failed: ${commit.stderr.slice(0, 1000)}`,
        {
          headBefore,
          baseDrifted,
        },
      );
    }
    const headAfter = await runGit(repoRoot, ["rev-parse", "HEAD"]);
    const commitSha = headAfter.stdout.trim();

    const post = options.postCheck
      ? await options.postCheck(repoRoot)
      : { ok: true, feedback: "" };
    if (!post.ok) {
      const current = await runGit(repoRoot, ["rev-parse", "HEAD"]);
      const currentSha = current.stdout.trim();
      const dirty = await runGit(repoRoot, ["status", "--porcelain"]);
      if (currentSha !== commitSha) {
        return result(
          "blocked",
          `post-apply checks failed; HEAD moved to ${currentSha}, refusing to revert`,
          { headBefore, baseDrifted, commitSha },
        );
      }
      if (dirty.stdout.trim()) {
        return result(
          "blocked",
          "post-apply checks failed; worktree dirty, refusing to revert",
          { headBefore, baseDrifted, commitSha },
        );
      }
      const revert = await runGit(repoRoot, ["revert", "--no-edit", commitSha]);
      return result(
        revert.exitCode === 0 ? "reverted" : "blocked",
        revert.exitCode === 0
          ? `post-apply checks failed; reverted own commit: ${post.feedback.slice(0, 1500)}`
          : `post-apply checks failed; revert failed: ${revert.stderr.slice(0, 1000)}: ${post.feedback.slice(0, 1500)}`,
        { headBefore, baseDrifted, commitSha },
      );
    }

    if (!lock.isHeld()) {
      return result(
        "blocked",
        "apply lock lost after commit; commit left for review",
        { headBefore, baseDrifted, commitSha },
      );
    }

    return result("applied", "verified and committed", {
      headBefore,
      baseDrifted,
      commitSha,
    });
  } finally {
    lock.release();
  }
}

function defaultLockPath(repoRoot: string): string {
  const key = createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), "agent-team-kit", "locks", `apply-${key}.lock`);
}

async function restorePatchFiles(
  repoRoot: string,
  files: string[],
): Promise<void> {
  const unique = normalizeFiles(files.join("\n")).filter(
    (file) => !path.isAbsolute(file) && !file.split("/").includes(".."),
  );
  if (unique.length === 0) {
    return;
  }
  await runGit(repoRoot, ["reset"]);
  for (const file of unique) {
    const inHead = await runGit(repoRoot, ["cat-file", "-e", `HEAD:${file}`]);
    if (inHead.exitCode === 0) {
      await runGit(repoRoot, [
        "restore",
        "--source=HEAD",
        "--worktree",
        "--",
        file,
      ]);
      continue;
    }
    await rm(path.join(repoRoot, file), { force: true });
  }
}

function normalizeFiles(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter(Boolean),
    ),
  ].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

export async function writeApplyPatch(
  repoRoot: string,
  iterationId: string,
  taskId: string,
  diff: string,
): Promise<{ patchFile: string; backupDir: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const taskDir = path.join(
    repoRoot,
    ".tmp",
    "iterations",
    iterationId,
    taskId,
  );
  await mkdir(taskDir, { recursive: true });
  const patchFile = path.join(taskDir, "patch.diff");
  const backupDir = path.join(
    repoRoot,
    ".backup",
    "iterations",
    iterationId,
    stamp,
  );
  await mkdir(backupDir, { recursive: true });
  await writeFile(patchFile, diff, "utf8");
  await writeFile(path.join(backupDir, `${taskId}.diff`), diff, "utf8");
  return { patchFile, backupDir };
}
