#!/usr/bin/env bun
import path from "node:path";
import {
  type ChangeRollbackStatus,
  defaultChangeRollbackAuditPath,
  executeChangeRollback,
  readChangeRollbackAudit,
} from "@kit/change/rollback";
import { initStore } from "@kit/store";

/**
 * Single-change rollback for the recovery kernel (85 §3.6; issue #89).
 *
 * `kitd.ps1 rollback -Change <id>` keeps this script thin and repo-external:
 * it reads the repo-external audit sink, re-runs the idempotent plan and only
 * mutates the repository/state when `--execute` is passed. Default is dry-run.
 *
 * `--list` always prints the repo-external rollback audit; it tries the store
 * for pending proposals too and degrades gracefully if the database is down.
 */

const list = process.argv.includes("--list");
const execute = process.argv.includes("--execute");
const changeId = argValue("--change");
const repoRoot = path.resolve(argValue("--repo") ?? process.cwd());
const actor = argValue("--actor") ?? "kitd:operator";
const auditPath =
  argValue("--audit") ??
  process.env.KIT_CHANGE_AUDIT_PATH ??
  defaultChangeRollbackAuditPath();

if (list) {
  await listChanges();
} else if (!changeId) {
  console.error(
    "usage: bun run scripts/change-rollback.ts --list | --change <id> [--execute] [--repo <root>] [--actor <who>] [--audit <path>]",
  );
  process.exitCode = 2;
} else {
  await rollbackChange(changeId);
}

async function listChanges(): Promise<void> {
  const audited = await readChangeRollbackAudit(auditPath, 20);
  let proposals: unknown[] | null = null;
  let proposalsError: string | null = null;
  try {
    const store = await initStore();
    try {
      const rows = await store.changeProposals.list({ limit: 50 });
      proposals = rows.map((proposal) => ({
        changeId: proposal.id,
        workspaceId: proposal.workspaceId,
        substrate: proposal.substrate,
        producer: proposal.producer,
        state: proposal.state,
        revertRef: proposal.revertRef,
        revertKind: proposal.revert?.kind ?? null,
        updatedAt: proposal.updatedAt,
      }));
    } finally {
      await store.close();
    }
  } catch (error) {
    proposalsError = toMessage(error);
  }
  console.log(
    JSON.stringify({ auditPath, proposals, proposalsError, audited }, null, 2),
  );
}

async function rollbackChange(id: string): Promise<void> {
  const store = await initStore();
  try {
    const result = await executeChangeRollback(
      { proposals: store.changeProposals, repoRoot, auditPath },
      { changeId: id, actor, dryRun: !execute, auditPath },
    );
    console.log(JSON.stringify(result, null, 2));
    if (isFailure(result.status)) {
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

function isFailure(status: ChangeRollbackStatus): boolean {
  return status === "refused" || status === "failed";
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
