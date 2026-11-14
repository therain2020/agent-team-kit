import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("creates the branch and updates it on a second publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kit-pages-test-"));
    roots.push(root);
    const remote = path.join(root, "remote.git");
    const site = path.join(root, "site");
    git(["init", "--bare", remote]);
    await mkdir(site, { recursive: true });
    await writeFile(path.join(site, "index.html"), "v1", "utf8");

    await publishSiteToBranch({
      siteDir: site,
      remoteUrl: remote,
      branch: "gh-pages",
    });

    expect(show(remote, "gh-pages:index.html")).toContain("v1");

    await writeFile(path.join(site, "index.html"), "v2", "utf8");
    await publishSiteToBranch({
      siteDir: site,
      remoteUrl: remote,
      branch: "gh-pages",
    });

    expect(show(remote, "gh-pages:index.html")).toContain("v2");
  }, 30_000);
});

function git(args: string[]): void {
  execFileSync("git", args, { stdio: "pipe" });
}

function show(remote: string, file: string): string {
  return execFileSync("git", ["--git-dir", remote, "show", file], {
    encoding: "utf8",
  });
}
