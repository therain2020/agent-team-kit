import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import type { EvolutionCycleLike } from "../src/adapters";
import {
  executeChangeRollback,
  hashVariantBackup,
  readChangeRollbackAudit,
} from "../src/rollback";
import { recordEvolutionCycleProposal } from "../src/shadow";

/**
 * 85 §3.5.6: an evolution auto-promotion writes a `cycle.promote` proposal with
 * a structured instruction revert, and `kitd rollback -Change` restores the
 * original instructions by changeId.
 */

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
  const dir = await tempDir("kit-evolution-promotion-store-");
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

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function createPackRepo(): Promise<{
  root: string;
  targetDir: string;
  backupDir: string;
  original: string;
}> {
  const root = await tempDir("kit-evolution-promotion-repo-");
  const targetDir = path.join(root, "packs", "demo");
  const instructionPath = path.join(targetDir, "agents", "writer.md");
  await mkdir(path.dirname(instructionPath), { recursive: true });
  const original = "---\nmodel: stub\n---\n\noriginal instructions\n";
  await writeFile(instructionPath, original, "utf8");
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  git(root, "config", "core.autocrlf", "false");
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
    "baseline",
  );

  // Mirror `promoteVariant`: back up the existing file, then overwrite it.
  const backupDir = path.join(
    targetDir,
    ".backup",
    "evolution",
    "2026-11-21T00-00-00-000Z",
  );
  const backupPath = path.join(backupDir, "agents", "writer.md");
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(backupPath, original, "utf8");
  await writeFile(instructionPath, "promoted instructions\n", "utf8");

  return { root, targetDir, backupDir, original };
}

function promotedCycle(input: {
  targetDir: string;
  backupDir: string;
  hash: string;
  approvalRef?: string | null;
}): EvolutionCycleLike {
  return {
    cycleId: "cyc_1",
    agentId: "writer",
    hypothesis: "sharpen citation discipline",
    signalRefs: [{ signalId: "sig_1", source: "archive", signal: "low pass" }],
    baselineName: "cycle-baseline",
    candidateName: "cycle-candidate",
    baselinePass: true,
    candidatePass: true,
    baselineScore: 0.7,
    candidateScore: 0.8,
    decision: "promoted",
    rationale: "candidate passed the canary",
    autoApplied: true,
    createdAt: AT,
    variantKind: "context",
    promote: {
      targetDir: input.targetDir,
      backupDir: input.backupDir,
      hash: input.hash,
      approvalRef: input.approvalRef ?? null,
    },
  };
}

describe("evolution auto-promotion rollback", () => {
  it("promotes with a cycle.promote proposal and restores by changeId", async () => {
    const store = await localStore();
    const { root, targetDir, backupDir, original } = await createPackRepo();
    const hash = await hashVariantBackup(backupDir);

    const proposal = await recordEvolutionCycleProposal(store.changeProposals, {
      workspaceId: "ws",
      cycle: promotedCycle({ targetDir, backupDir, hash }),
      at: AT,
    });

    expect(proposal).not.toBeNull();
    if (!proposal) {
      throw new Error("expected a cycle.promote proposal");
    }
    expect(proposal.id).toBe("chg_cy_ws_cyc_1");
    expect(proposal.producer).toBe("evolve");
    expect(proposal.substrate).toBe("prompt");
    expect(proposal.state).toBe("promoted");
    expect(proposal.sourceRef).toEqual({
      kind: "evolution",
      id: "cyc_1",
      taskId: null,
    });
    expect(proposal.revert).toEqual({
      kind: "instruction",
      targetDir,
      backupDir,
      hash,
    });
    expect(proposal.history.map((entry) => entry.trigger)).toEqual([
      "submit",
      "evaluate",
      "evaluation_passed",
      "canary",
      "promote",
    ]);

    const auditPath = path.join(
      await tempDir("kit-evolution-promotion-audit-"),
      "audit.jsonl",
    );
    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: root, auditPath },
      { changeId: proposal.id, actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("ok");
    expect(result.plan.substrate).toBe("instruction");
    expect(
      await readFile(path.join(targetDir, "agents", "writer.md"), "utf8"),
    ).toBe(original);
    expect((await store.changeProposals.get(proposal.id))?.state).toBe(
      "rolled_back",
    );

    const audit = await readChangeRollbackAudit(auditPath, 10);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.changeId).toBe("chg_cy_ws_cyc_1");
    expect(audit[0]?.before.state).toBe("promoted");
    expect(audit[0]?.after.state).toBe("rolled_back");
  });

  it("refuses when unrelated paths outside the target are dirty", async () => {
    const store = await localStore();
    const { root, targetDir, backupDir, original } = await createPackRepo();
    const hash = await hashVariantBackup(backupDir);
    const proposal = await recordEvolutionCycleProposal(store.changeProposals, {
      workspaceId: "ws",
      cycle: promotedCycle({ targetDir, backupDir, hash }),
      at: AT,
    });
    if (!proposal) {
      throw new Error("expected a cycle.promote proposal");
    }
    await writeFile(path.join(root, "unrelated.txt"), "dirty\n", "utf8");

    const auditPath = path.join(
      await tempDir("kit-evolution-promotion-audit-"),
      "audit.jsonl",
    );
    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot: root, auditPath },
      { changeId: proposal.id, actor: "kitd:operator", dryRun: false },
    );

    expect(result.status).toBe("refused");
    expect(result.plan.refusal?.code).toBe("dirty_worktree");
    expect(result.plan.refusal?.message).toContain("unrelated.txt");
    expect(
      await readFile(path.join(targetDir, "agents", "writer.md"), "utf8"),
    ).toBe("promoted instructions\n");
  });
});
