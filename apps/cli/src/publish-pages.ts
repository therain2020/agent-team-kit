import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PublishSiteOptions {
  remoteUrl: string;
  branch: string;
  message?: string;
  prepare: (dir: string) => Promise<void>;
}

export async function publishSiteToBranch(
  options: PublishSiteOptions,
): Promise<boolean> {
  const exists =
    gitExit([
      "ls-remote",
      "--exit-code",
      "--heads",
      options.remoteUrl,
      options.branch,
    ]) === 0;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kit-pages-"));

  try {
    if (exists) {
      git(
        [
          "clone",
          "--depth",
          "1",
          "--branch",
          options.branch,
          "--single-branch",
          options.remoteUrl,
          tempDir,
        ],
        process.cwd(),
        { quiet: true },
      );
    } else {
      await mkdir(tempDir, { recursive: true });
      git(["init", tempDir], process.cwd(), { quiet: true });
      git(["-C", tempDir, "checkout", "--orphan", options.branch]);
      git(["-C", tempDir, "remote", "add", "origin", options.remoteUrl]);
    }

    await options.prepare(tempDir);

    const changes = git(["-C", tempDir, "status", "--porcelain"]);
    if (!changes) {
      return false;
    }

    const name =
      gitOptional(["-C", tempDir, "config", "--get", "user.name"]) ?? "kit";
    const email =
      gitOptional(["-C", tempDir, "config", "--get", "user.email"]) ??
      "kit@localhost";

    git(["-C", tempDir, "add", "-A"]);
    git([
      "-C",
      tempDir,
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "-m",
      options.message ?? "publish site",
    ]);

    if (exists) {
      git(["-C", tempDir, "push", "origin", options.branch]);
    } else {
      git(["-C", tempDir, "push", "-u", "origin", options.branch]);
    }

    return true;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function getRemoteUrl(remoteName: string): string | null {
  return gitOptional(["remote", "get-url", remoteName]);
}

export function githubWebUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return `https://github.com/${match[1]}/${match[2]}`;
}

export function pagesUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return `https://${match[1]}.github.io/${match[2]}/`;
}

interface GitOptions {
  quiet?: boolean;
}

function git(args: string[], cwd?: string, options: GitOptions = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(detail || `git ${args.join(" ")} failed`);
  }
  if (options.quiet) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

function gitOptional(args: string[], cwd?: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout ?? "").trim() || null;
}

function gitExit(args: string[]): number {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status ?? 1;
}
