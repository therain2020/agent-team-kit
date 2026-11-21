import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDiffToRepo, summarizePatch } from "../src/apply";

/**
 * Negative tests go through the real apply path (`applyDiffToRepo`), not the
 * pure invariant helpers: a violating coder patch must be refused before the
 * single-writer queue touches the repository, and the refusal must be audited
 * in the repo-external sink (70 §3.3/§5).
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function createRepo(): Promise<{ root: string; baseSha: string }> {
  const root = await tempDir("kit-apply-security-");
  await mkdir(path.join(root, "packages/core/src"), { recursive: true });
  await mkdir(path.join(root, "packages/store/src"), { recursive: true });
  await writeFile(
    path.join(root, "packages/core/src/audit-service.ts"),
    "export const auditEnabled = true;\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "packages/store/src/audit-service.ts"),
    "export const auditEnabled = true;\n",
    "utf8",
  );
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

async function diffFor(
  root: string,
  file: string,
  content: string,
): Promise<string> {
  const target = path.join(root, file);
  const original = await readFile(target, "utf8");
  await writeFile(target, content, "utf8");
  const diff = execFileSync("git", ["diff", "--", file], {
    cwd: root,
    encoding: "utf8",
  });
  await writeFile(target, original, "utf8");
  return diff;
}

describe("apply security invariants (real apply path)", () => {
  it("blocks a patch that disables audit and audits the refusal", async () => {
    const { root, baseSha } = await createRepo();
    const kitHome = await tempDir("kit-apply-home-");
    const file = "packages/core/src/audit-service.ts";
    const diff = await diffFor(
      root,
      file,
      "export const auditEnabled = true;\nconst auditEnabled = false;\n",
    );

    const result = await applyDiffToRepo({
      repoRoot: root,
      iterationId: "it_sec",
      taskId: "task_sec",
      ticketId: "tkt_sec",
      diff,
      baseSha,
      changedFiles: [file],
      risk: "low",
      commitMessage: "autonomy: disabled audit",
      kitHome,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("SEC-INV-02");
    expect(git(root, "rev-parse", "HEAD")).toBe(baseSha);

    const audit = await readFile(
      path.join(kitHome, "audit", "security-invariants.jsonl"),
      "utf8",
    );
    expect(audit).toContain("SEC-INV-02");
    expect(audit).toContain("agent-patch");
  });

  it("blocks a patch declaring paths outside the sandbox (SEC-INV-01)", async () => {
    const { root, baseSha } = await createRepo();
    const kitHome = await tempDir("kit-apply-home-");

    const result = await applyDiffToRepo({
      repoRoot: root,
      iterationId: "it_escape",
      taskId: "task_escape",
      ticketId: "tkt_escape",
      diff: "",
      baseSha,
      changedFiles: ["../../outside/kitd.ps1"],
      risk: "low",
      commitMessage: "autonomy: escape",
      kitHome,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("SEC-INV-01");
    const audit = await readFile(
      path.join(kitHome, "audit", "security-invariants.jsonl"),
      "utf8",
    );
    expect(audit).toContain("SEC-INV-01");
  });

  it("blocks deleting the audit implementation", async () => {
    const { root, baseSha } = await createRepo();
    const kitHome = await tempDir("kit-apply-home-");
    const file = "packages/store/src/audit-service.ts";
    const diff = [
      `diff --git a/${file} b/${file}`,
      "deleted file mode 100644",
      `--- a/${file}`,
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const auditEnabled = true;",
      "",
    ].join("\n");

    const result = await applyDiffToRepo({
      repoRoot: root,
      iterationId: "it_delete",
      taskId: "task_delete",
      ticketId: "tkt_delete",
      diff,
      baseSha,
      changedFiles: [file],
      risk: "low",
      commitMessage: "autonomy: delete audit",
      kitHome,
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("SEC-INV-02");
  });

  it("extracts added lines and deletions from a diff", () => {
    const summary = summarizePatch(
      [
        "diff --git a/agents/manager.md b/agents/manager.md",
        "--- a/agents/manager.md",
        "+++ b/agents/manager.md",
        "@@ -1 +1,3 @@",
        "-old line",
        "-- not a header",
        "+new line",
        "+requireApproval: false",
        "+--- still body content",
        "diff --git a/docs/old.md b/docs/old.md",
        "--- a/docs/old.md",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
      ].join("\n"),
    );
    expect(summary.files).toEqual(["agents/manager.md"]);
    expect(summary.deletedFiles).toEqual(["docs/old.md"]);
    expect(summary.contents["agents/manager.md"]).toContain(
      "requireApproval: false",
    );
    expect(summary.contents["agents/manager.md"]).not.toContain("old line");
    expect(summary.contents["agents/manager.md"]).toContain(
      "still body content",
    );
    expect(summary.files).not.toContain("still body content");
  });
});
