import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatchToRepo } from "../src/index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRepo(): Promise<{ root: string; baseSha: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kit-apply-test-"));
  roots.push(root);
  await writeFile(path.join(root, "a.txt"), "alpha\n", "utf8");
  await writeFile(path.join(root, "b.txt"), "beta\n", "utf8");
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.eol", "lf");
  git(root, "-c", "user.name=kit", "-c", "user.email=kit@local", "add", "-A");
  git(
    root,
    "-c",
    "user.name=kit",
    "-c",
    "user.email=kit@local",
    "commit",
    "-q",
    "-m",
    "baseline",
  );
  return { root, baseSha: git(root, "rev-parse", "HEAD") };
}

async function makePatch(
  root: string,
  file: string,
  content: string,
): Promise<string> {
  const target = path.join(root, file);
  const original = await readFile(target, "utf8");
  await writeFile(target, content, "utf8");
  const patch = gitRaw(root, "diff", "--", file);
  await writeFile(target, original, "utf8");
  const patchDir = await mkdtemp(path.join(os.tmpdir(), "kit-patch-"));
  roots.push(patchDir);
  const patchFile = path.join(patchDir, `${file}.patch`);
  await writeFile(patchFile, patch, "utf8");
  return patchFile;
}

describe("applyPatchToRepo", () => {
  it("applies a patch and commits it", async () => {
    const { root, baseSha } = await createRepo();
    const patchFile = await makePatch(root, "a.txt", "alpha\nchanged\n");
    const result = await applyPatchToRepo({
      repoRoot: root,
      patchFile,
      baseSha,
      changedFiles: ["a.txt"],
      ticketId: "tkt_apply",
      commitMessage: "autonomy: change alpha",
    });

    expect(result.status, result.reason).toBe("applied");
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "alpha\nchanged\n",
    );
    expect(git(root, "log", "-1", "--format=%s")).toBe(
      "autonomy: change alpha",
    );
  });

  it("serializes concurrent disjoint patches", async () => {
    const { root, baseSha } = await createRepo();
    const patchA = await makePatch(root, "a.txt", "alpha\nA\n");
    const patchB = await makePatch(root, "b.txt", "beta\nB\n");

    const [first, second] = await Promise.all([
      applyPatchToRepo({
        repoRoot: root,
        patchFile: patchA,
        baseSha,
        changedFiles: ["a.txt"],
        ticketId: "tkt_a",
        commitMessage: "autonomy: a",
      }),
      applyPatchToRepo({
        repoRoot: root,
        patchFile: patchB,
        baseSha,
        changedFiles: ["b.txt"],
        ticketId: "tkt_b",
        commitMessage: "autonomy: b",
      }),
    ]);

    expect(first.status).toBe("applied");
    expect(second.status).toBe("applied");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("alpha\nA\n");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("beta\nB\n");
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("3");
  });

  it("blocks overlapping patches instead of overwriting", async () => {
    const { root, baseSha } = await createRepo();
    const patchA = await makePatch(root, "a.txt", "alpha\nA\n");
    const patchB = await makePatch(root, "a.txt", "alpha\nB\n");

    const results = await Promise.all([
      applyPatchToRepo({
        repoRoot: root,
        patchFile: patchA,
        baseSha,
        changedFiles: ["a.txt"],
        ticketId: "tkt_a",
        commitMessage: "autonomy: a",
      }),
      applyPatchToRepo({
        repoRoot: root,
        patchFile: patchB,
        baseSha,
        changedFiles: ["a.txt"],
        ticketId: "tkt_b",
        commitMessage: "autonomy: b",
      }),
    ]);

    expect(results.map((item) => item.status).sort()).toEqual([
      "applied",
      "blocked",
    ]);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("reverts only its own commit when post-checks fail", async () => {
    const { root, baseSha } = await createRepo();
    const patchA = await makePatch(root, "a.txt", "alpha\nA\n");
    const patchB = await makePatch(root, "b.txt", "beta\nB\n");

    const failed = await applyPatchToRepo({
      repoRoot: root,
      patchFile: patchA,
      baseSha,
      changedFiles: ["a.txt"],
      ticketId: "tkt_a",
      commitMessage: "autonomy: a",
      postCheck: async () => ({ ok: false, feedback: "injected failure" }),
    });
    expect(failed.status).toBe("reverted");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("alpha\n");

    const passed = await applyPatchToRepo({
      repoRoot: root,
      patchFile: patchB,
      baseSha,
      changedFiles: ["b.txt"],
      ticketId: "tkt_b",
      commitMessage: "autonomy: b",
    });
    expect(passed.status).toBe("applied");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("beta\nB\n");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("blocks a stale base instead of forcing a merge", async () => {
    const { root, baseSha } = await createRepo();
    const patchA = await makePatch(root, "a.txt", "alpha\nstale\n");
    await writeFile(path.join(root, "a.txt"), "alpha\nnewer\n", "utf8");
    git(
      root,
      "-c",
      "user.name=kit",
      "-c",
      "user.email=kit@local",
      "add",
      "a.txt",
    );
    git(
      root,
      "-c",
      "user.name=kit",
      "-c",
      "user.email=kit@local",
      "commit",
      "-q",
      "-m",
      "advance",
    );

    const result = await applyPatchToRepo({
      repoRoot: root,
      patchFile: patchA,
      baseSha,
      changedFiles: ["a.txt"],
      ticketId: "tkt_stale",
      commitMessage: "autonomy: stale",
    });

    expect(result.status).toBe("blocked");
    expect(result.baseDrifted).toBe(true);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "alpha\nnewer\n",
    );
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("2");
  });
});

function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args).trim();
}

function gitRaw(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
