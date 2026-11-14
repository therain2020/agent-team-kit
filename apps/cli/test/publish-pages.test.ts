import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishSiteToBranch } from "../src/publish-pages";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("publish to a branch", () => {
  it("creates the branch, updates it, and reports no-op publishes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-pages-test-"));
    roots.push(root);
    const remote = path.join(root, "remote.git");
    git(["init", "--bare", remote]);

    const changed = await publishSiteToBranch({
      remoteUrl: remote,
      branch: "gh-pages",
      prepare: async (dir) => {
        await writeFile(path.join(dir, "index.html"), "v1", "utf8");
      },
    });
    expect(changed).toBe(true);
    expect(show(remote, "gh-pages:index.html")).toContain("v1");

    const updated = await publishSiteToBranch({
      remoteUrl: remote,
      branch: "gh-pages",
      prepare: async (dir) => {
        await writeFile(path.join(dir, "index.html"), "v2", "utf8");
      },
    });
    expect(updated).toBe(true);
    expect(show(remote, "gh-pages:index.html")).toContain("v2");

    const unchanged = await publishSiteToBranch({
      remoteUrl: remote,
      branch: "gh-pages",
      prepare: async (dir) => {
        await writeFile(path.join(dir, "index.html"), "v2", "utf8");
      },
    });
    expect(unchanged).toBe(false);
  }, 20_000);
});

function git(args: string[]): void {
  execFileSync("git", args, { stdio: "pipe" });
}

function show(remote: string, file: string): string {
  return execFileSync("git", ["--git-dir", remote, "show", file], {
    encoding: "utf8",
  });
}
