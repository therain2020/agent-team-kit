import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newChangeProposal } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeChangeRollback,
  hashVariantBackup,
  readChangeRollbackAudit,
} from "../src/rollback";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const AT = "2026-11-21T00:00:00.000Z";

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-change-rollback-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function createRepo(): Promise<{ root: string; baseSha: string }> {
  const root = await tempDir("kit-rollback-repo-");
  await writeFile(path.join(root, "a.txt"), "alpha\n", "utf8");
  await writeFile(path.join(root, "b.txt"), "beta\n", "utf8");
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.eol", "lf");
  return { root, baseSha: commit(root, "baseline") };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(
    root,
    "-c",
    "user.name=kit",
    "-c",
    "user.email=kit@local",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git(root, "rev-parse", "HEAD");
}

async function codeProposal(
  store: Awaited<ReturnType<typeof localStore>>,
  id: string,
  commitSha: string,
  baseSha: string,
) {
  const proposal = newChangeProposal({
    id,
    workspaceId: "ws",
    substrate: "code",
    producer: "iterate",
    hypothesis: "change a.txt",
    acceptance: ["tests pass"],
    risk: "low",
    revertRef: `commit:${commitSha}`,
    revert: { kind: "code", commit: commitSha, baseSha, backupDir: null },
    actor: "shadow:iterate",
    now: AT,
  });
  await store.changeProposals.create(proposal);
  return proposal;
}

describe("change rollback", () => {
  it("reverts only the recorded commit and transitions to rolled_back", async () => {
    const store = await localStore();
    const { root, baseSha } = await createRepo();
    await writeFile(path.join(root, "a.txt"), "alpha\nchanged\n", "utf8");
    const changeCommit = commit(root, "autonomy: change a");
    await writeFile(path.join(root, "b.txt"), "beta\nchanged\n", "utf8");
    commit(root, "later unrelated change");

    await codeProposal(store, "chg_code_ok", changeCommit, baseSha);
    const auditPath = path.join(
      await tempDir("kit-rollback-audit-"),
      "audit.jsonl",
    );

    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: root, auditPath },
      { changeId: "chg_code_ok", actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("ok");
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("alpha\n");
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe(
      "beta\nchanged\n",
    );
    expect((await store.changeProposals.get("chg_code_ok"))?.state).toBe(
      "rolled_back",
    );

    const audit = await readChangeRollbackAudit(auditPath, 10);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.changeId).toBe("chg_code_ok");
    expect(audit[0]?.actor).toBe("kitd:operator");
    expect(audit[0]?.substrate).toBe("code");
    expect(audit[0]?.before.state).toBe("proposed");
    expect(audit[0]?.after.state).toBe("rolled_back");
    expect(audit[0]?.status).toBe("ok");
  });

  it("dry-run has no repository or state side effects", async () => {
    const store = await localStore();
    const { root, baseSha } = await createRepo();
    await writeFile(path.join(root, "a.txt"), "alpha\nchanged\n", "utf8");
    const changeCommit = commit(root, "autonomy: change a");
    const headBefore = git(root, "rev-parse", "HEAD");
    await codeProposal(store, "chg_code_dry", changeCommit, baseSha);
    const auditPath = path.join(
      await tempDir("kit-rollback-audit-"),
      "audit.jsonl",
    );

    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: root, auditPath },
      { changeId: "chg_code_dry", actor: "kitd:operator", dryRun: true },
    );

    expect(result.status).toBe("dry-run");
    expect(git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "alpha\nchanged\n",
    );
    expect((await store.changeProposals.get("chg_code_dry"))?.state).toBe(
      "proposed",
    );

    const audit = await readChangeRollbackAudit(auditPath, 10);
    expect(audit.at(-1)?.status).toBe("dry-run");
    expect(audit.at(-1)?.dryRun).toBe(true);
  });

  it("refuses a dirty worktree and records the refusal", async () => {
    const store = await localStore();
    const { root, baseSha } = await createRepo();
    await writeFile(path.join(root, "a.txt"), "alpha\nchanged\n", "utf8");
    const changeCommit = commit(root, "autonomy: change a");
    await codeProposal(store, "chg_code_dirty", changeCommit, baseSha);
    await writeFile(path.join(root, "a.txt"), "uncommitted\n", "utf8");
    const auditPath = path.join(
      await tempDir("kit-rollback-audit-"),
      "audit.jsonl",
    );

    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: root, auditPath },
      { changeId: "chg_code_dirty", actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("refused");
    expect(result.plan.refusal?.code).toBe("dirty_worktree");
    expect((await store.changeProposals.get("chg_code_dirty"))?.state).toBe(
      "proposed",
    );
    const audit = await readChangeRollbackAudit(auditPath, 10);
    expect(audit.at(-1)?.status).toBe("refused");
    expect(audit.at(-1)?.detail).toContain("not clean");
  });

  it("refuses a commit that is not in this history", async () => {
    const store = await localStore();
    const { root, baseSha } = await createRepo();
    git(root, "checkout", "-q", "-b", "side");
    await writeFile(path.join(root, "a.txt"), "side\n", "utf8");
    const sideCommit = commit(root, "side change");
    git(root, "checkout", "-q", "main");
    await codeProposal(store, "chg_code_wrong", sideCommit, baseSha);
    const auditPath = path.join(
      await tempDir("kit-rollback-audit-"),
      "audit.jsonl",
    );

    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: root, auditPath },
      { changeId: "chg_code_wrong", actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("refused");
    expect(result.plan.refusal?.code).toBe("commit_not_in_history");
    expect(git(root, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "main"));
    const audit = await readChangeRollbackAudit(auditPath, 10);
    expect(audit.at(-1)?.status).toBe("refused");
  });

  it("restores a variant backup and transitions to rolled_back", async () => {
    const store = await localStore();
    const targetDir = await tempDir("kit-rollback-target-");
    const backupDir = await tempDir("kit-rollback-backup-");
    await mkdir(path.join(backupDir, "agents"), { recursive: true });
    await writeFile(
      path.join(backupDir, "agents", "writer.md"),
      "old instructions\n",
      "utf8",
    );
    const hash = await hashVariantBackup(backupDir);
    await mkdir(path.join(targetDir, "agents"), { recursive: true });
    await writeFile(
      path.join(targetDir, "agents", "writer.md"),
      "new instructions\n",
      "utf8",
    );

    await store.changeProposals.create(
      newChangeProposal({
        id: "chg_instr_ok",
        workspaceId: "ws",
        substrate: "prompt",
        producer: "evolve",
        hypothesis: "sharpen the instruction contract",
        acceptance: ["candidate beats baseline"],
        risk: "low",
        revertRef: "variant:baseline",
        revert: {
          kind: "instruction",
          targetDir,
          backupDir,
          hash,
        },
        actor: "shadow:evolve",
        now: AT,
      }),
    );
    const auditPath = path.join(
      await tempDir("kit-rollback-audit-"),
      "audit.jsonl",
    );

    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: targetDir, auditPath },
      { changeId: "chg_instr_ok", actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("ok");
    expect(result.plan.substrate).toBe("instruction");
    expect(
      await readFile(path.join(targetDir, "agents", "writer.md"), "utf8"),
    ).toBe("old instructions\n");
    expect((await store.changeProposals.get("chg_instr_ok"))?.state).toBe(
      "rolled_back",
    );
    const audit = await readChangeRollbackAudit(auditPath, 10);
    expect(audit.at(-1)?.substrate).toBe("instruction");
    expect(audit.at(-1)?.after.state).toBe("rolled_back");
  });

  it("refuses a variant backup whose hash no longer matches", async () => {
    const store = await localStore();
    const targetDir = await tempDir("kit-rollback-target-");
    const backupDir = await tempDir("kit-rollback-backup-");
    await writeFile(path.join(backupDir, "writer.md"), "old\n", "utf8");
    const hash = await hashVariantBackup(backupDir);
    await writeFile(path.join(backupDir, "writer.md"), "tampered\n", "utf8");

    await store.changeProposals.create(
      newChangeProposal({
        id: "chg_instr_hash",
        workspaceId: "ws",
        substrate: "prompt",
        producer: "evolve",
        hypothesis: "sharpen the instruction contract",
        acceptance: ["candidate beats baseline"],
        risk: "low",
        revertRef: "variant:baseline",
        revert: { kind: "instruction", targetDir, backupDir, hash },
        actor: "shadow:evolve",
        now: AT,
      }),
    );
    const auditPath = path.join(
      await tempDir("kit-rollback-audit-"),
      "audit.jsonl",
    );

    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: targetDir, auditPath },
      { changeId: "chg_instr_hash", actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("refused");
    expect(result.plan.refusal?.code).toBe("backup_hash_mismatch");
  });
});
