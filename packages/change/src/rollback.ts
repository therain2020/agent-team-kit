import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ChangeGuardError,
  type ChangeProposal,
  type ChangeState,
  assertRollbackAllowed,
} from "@kit/core";
import { FileLockTimeoutError, acquireFileLock } from "@kit/core/fs-lock";
import { defaultApplyLockPath } from "@kit/core/git-apply";
import type { ChangeProposalService } from "@kit/store";

/**
 * Single-change rollback (85 §3.6; D-48).
 *
 * A change is reverted from its persisted structured `revert` record, never by
 * resetting `HEAD`:
 * - `code`: `git revert <commit>` for that one commit only, under the same
 *   cross-process apply lock as the 86 single-writer queue.
 * - `instruction`: restore the backed-up variant files after re-verifying the
 *   recorded backup hash.
 *
 * Dry-run is the default. Every attempt — dry-run, refusal, success or failure
 * — appends one entry to the repo-external audit JSONL, in the same shape for
 * both substrates.
 *
 * This module reaches for node builtins and is intentionally not re-exported
 * from the `@kit/change` barrel; import it as `@kit/change/rollback`.
 */

const execFileAsync = promisify(execFile);

export type ChangeRollbackSubstrate = "code" | "instruction";

export type ChangeRollbackRefusalCode =
  | "not_found"
  | "missing_revert"
  | "already_rolled_back"
  | "dirty_worktree"
  | "unknown_commit"
  | "commit_not_in_history"
  | "merge_commit"
  | "missing_backup"
  | "backup_hash_mismatch"
  | "git_unavailable";

export type ChangeRollbackStatus = "dry-run" | "ok" | "refused" | "failed";

export interface ChangeRollbackSnapshot {
  state: ChangeState | null;
  head: string | null;
  revertRef: string | null;
  files: string[];
}

export interface ChangeRollbackPlan {
  changeId: string;
  workspaceId: string | null;
  substrate: ChangeRollbackSubstrate;
  state: ChangeState | null;
  revertRef: string | null;
  action:
    | { kind: "git-revert"; commit: string; head: string }
    | {
        kind: "restore-variant";
        targetDir: string;
        backupDir: string;
        files: string[];
      }
    | null;
  refusal: { code: ChangeRollbackRefusalCode; message: string } | null;
}

export interface ChangeRollbackAuditEntry {
  at: string;
  action: "rollback";
  changeId: string;
  substrate: ChangeRollbackSubstrate;
  actor: string;
  dryRun: boolean;
  status: ChangeRollbackStatus;
  before: ChangeRollbackSnapshot;
  after: ChangeRollbackSnapshot;
  detail: string;
}

export interface ChangeRollbackResult {
  status: ChangeRollbackStatus;
  changeId: string;
  plan: ChangeRollbackPlan;
  before: ChangeRollbackSnapshot;
  after: ChangeRollbackSnapshot;
  detail: string;
  auditPath: string;
}

export interface ChangeRollbackDeps {
  proposals: ChangeProposalService;
  repoRoot: string;
  /** Repo-external audit sink; defaults to `~/.agent-team-kit/audit`. */
  auditPath?: string;
  now?: () => string;
}

export interface ChangeRollbackExecuteOptions {
  changeId: string;
  actor: string;
  /** Defaults to true: a plan-only pass with no repository or state writes. */
  dryRun?: boolean;
  auditPath?: string;
  lockTimeoutMs?: number;
}

/** Repo-external audit sink for single-change rollbacks. */
export function defaultChangeRollbackAuditPath(): string {
  return path.join(
    os.homedir(),
    ".agent-team-kit",
    "audit",
    "change-rollback.jsonl",
  );
}

/**
 * Deterministic hash over a variant backup directory. Relative paths are
 * normalized to `/` and sorted, so a backup verifies identically on Windows.
 */
export async function hashVariantBackup(dir: string): Promise<string> {
  const files = await listVariantFiles(dir);
  const hash = createHash("sha256");
  for (const relative of files) {
    const content = await readFile(path.join(dir, relative));
    hash.update(relative);
    hash.update("\0");
    hash.update(createHash("sha256").update(content).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export async function appendChangeRollbackAudit(
  auditPath: string,
  entry: ChangeRollbackAuditEntry,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(auditPath)), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/** Reads the repo-external rollback audit, newest last. Malformed lines are skipped. */
export async function readChangeRollbackAudit(
  auditPath: string,
  limit = 50,
): Promise<ChangeRollbackAuditEntry[]> {
  let text: string;
  try {
    text = await readFile(auditPath, "utf8");
  } catch {
    return [];
  }
  const entries: ChangeRollbackAuditEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as ChangeRollbackAuditEntry);
    } catch {
      // Audit is append-only and best-effort readable; skip a torn line.
    }
  }
  return entries.slice(-Math.max(1, limit));
}

/** Read-only plan. Never writes the repository, state or audit. */
export async function planChangeRollback(
  deps: ChangeRollbackDeps,
  changeId: string,
): Promise<ChangeRollbackPlan> {
  const proposal = await deps.proposals.get(changeId);
  if (!proposal) {
    return refusalPlan(changeId, null, "code", null, null, {
      code: "not_found",
      message: `change proposal ${changeId} not found`,
    });
  }
  return await buildPlan(deps, proposal);
}

export async function executeChangeRollback(
  deps: ChangeRollbackDeps,
  options: ChangeRollbackExecuteOptions,
): Promise<ChangeRollbackResult> {
  const auditPath =
    options.auditPath ?? deps.auditPath ?? defaultChangeRollbackAuditPath();
  const at = deps.now?.() ?? new Date().toISOString();
  const dryRun = options.dryRun ?? true;
  let plan = await planChangeRollback(deps, options.changeId);
  let before = await snapshotBefore(deps.repoRoot, plan);
  const base = { changeId: options.changeId };

  if (plan.refusal) {
    return await finish({
      at,
      auditPath,
      actor: options.actor,
      dryRun,
      plan,
      before,
      after: before,
      status: "refused",
      detail: plan.refusal.message,
      ...base,
    });
  }

  if (dryRun) {
    return await finish({
      at,
      auditPath,
      actor: options.actor,
      dryRun: true,
      plan,
      before,
      after: before,
      status: "dry-run",
      detail: describeAction(plan),
      ...base,
    });
  }

  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(defaultApplyLockPath(deps.repoRoot), {
      owner: `rollback:${options.changeId}`,
      timeoutMs: options.lockTimeoutMs ?? 60_000,
      staleMs: 15 * 60 * 1000,
      heartbeatMs: 10_000,
    });
  } catch (error) {
    const detail =
      error instanceof FileLockTimeoutError
        ? `apply lock timeout: ${error.message}`
        : `apply lock failed: ${toMessage(error)}`;
    return await finish({
      at,
      auditPath,
      actor: options.actor,
      dryRun: false,
      plan,
      before,
      after: before,
      status: "failed",
      detail,
      ...base,
    });
  }

  try {
    // Re-plan under the lock so two writers cannot both observe a clean tree.
    plan = await planChangeRollback(deps, options.changeId);
    before = await snapshotBefore(deps.repoRoot, plan);
    if (plan.refusal) {
      return await finish({
        at,
        auditPath,
        actor: options.actor,
        dryRun: false,
        plan,
        before,
        after: before,
        status: "refused",
        detail: plan.refusal.message,
        ...base,
      });
    }
    if (!lock.isHeld()) {
      return await finish({
        at,
        auditPath,
        actor: options.actor,
        dryRun: false,
        plan,
        before,
        after: before,
        status: "failed",
        detail: "apply lock lost before rollback",
        ...base,
      });
    }

    const applied = await applyAction(deps, plan);
    if (!applied.ok) {
      return await finish({
        at,
        auditPath,
        actor: options.actor,
        dryRun: false,
        plan,
        before,
        after: before,
        status: "failed",
        detail: applied.detail,
        ...base,
      });
    }

    const transition = await deps.proposals.transition({
      proposalId: options.changeId,
      trigger: "rollback",
      actor: options.actor,
      reason: applied.detail,
      at,
    });
    if (!transition.ok) {
      return await finish({
        at,
        auditPath,
        actor: options.actor,
        dryRun: false,
        plan,
        before,
        after: { ...before, ...applied.after },
        status: "failed",
        detail: `repository reverted but state transition failed: ${transition.code}`,
        ...base,
      });
    }

    const after: ChangeRollbackSnapshot = {
      state: transition.proposal.state,
      head: applied.after.head ?? before.head,
      revertRef: plan.revertRef,
      files: applied.after.files ?? before.files,
    };
    return await finish({
      at,
      auditPath,
      actor: options.actor,
      dryRun: false,
      plan,
      before,
      after,
      status: "ok",
      detail: applied.detail,
      ...base,
    });
  } finally {
    lock.release();
  }
}

async function buildPlan(
  deps: ChangeRollbackDeps,
  proposal: ChangeProposal,
): Promise<ChangeRollbackPlan> {
  const substrate: ChangeRollbackSubstrate =
    proposal.revert?.kind ??
    (proposal.substrate === "code" ? "code" : "instruction");
  const base = {
    changeId: proposal.id,
    workspaceId: proposal.workspaceId,
    substrate,
    state: proposal.state,
    revertRef: proposal.revertRef,
  };

  try {
    assertRollbackAllowed(proposal);
  } catch (error) {
    if (error instanceof ChangeGuardError) {
      return {
        ...base,
        action: null,
        refusal: { code: "already_rolled_back", message: error.message },
      };
    }
    throw error;
  }

  const revert = proposal.revert;
  if (!revert) {
    return {
      ...base,
      action: null,
      refusal: {
        code: "missing_revert",
        message: `proposal ${proposal.id} has no structured revert record`,
      },
    };
  }

  if (revert.kind === "code") {
    return await planCodeRevert(deps.repoRoot, base, revert.commit);
  }
  return await planInstructionRestore(base, revert);
}

async function planCodeRevert(
  repoRoot: string,
  base: Omit<ChangeRollbackPlan, "action" | "refusal">,
  commitInput: string,
): Promise<ChangeRollbackPlan> {
  const status = await runGit(repoRoot, ["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    return refusalFrom(
      base,
      "git_unavailable",
      `cannot read git status: ${status.stderr.slice(0, 500)}`,
    );
  }
  if (status.stdout.trim()) {
    return refusalFrom(
      base,
      "dirty_worktree",
      "working tree is not clean; rollback refused",
    );
  }

  const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0 || !head.stdout.trim()) {
    return refusalFrom(base, "git_unavailable", "cannot resolve HEAD");
  }
  const headSha = head.stdout.trim();

  const resolved = await runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${commitInput}^{commit}`,
  ]);
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    return refusalFrom(
      base,
      "unknown_commit",
      `commit ${commitInput} does not exist`,
    );
  }
  const commit = resolved.stdout.trim();

  const ancestor = await runGit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    commit,
    "HEAD",
  ]);
  if (ancestor.exitCode !== 0) {
    return refusalFrom(
      base,
      "commit_not_in_history",
      `commit ${commit} is not in this history; refusing to revert another change`,
    );
  }

  const parents = await runGit(repoRoot, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    commit,
  ]);
  if (parents.exitCode !== 0) {
    return refusalFrom(base, "git_unavailable", "cannot inspect the commit");
  }
  if (parents.stdout.trim().split(/\s+/).length > 2) {
    return refusalFrom(
      base,
      "merge_commit",
      `commit ${commit} is a merge commit`,
    );
  }

  return {
    ...base,
    action: { kind: "git-revert", commit, head: headSha },
    refusal: null,
  };
}

async function planInstructionRestore(
  base: Omit<ChangeRollbackPlan, "action" | "refusal">,
  revert: Extract<
    NonNullable<ChangeProposal["revert"]>,
    { kind: "instruction" }
  >,
): Promise<ChangeRollbackPlan> {
  let files: string[];
  let actualHash: string;
  try {
    files = await listVariantFiles(revert.backupDir);
    actualHash = await hashVariantBackup(revert.backupDir);
  } catch {
    return refusalFrom(
      base,
      "missing_backup",
      `variant backup ${revert.backupDir} is missing or unreadable`,
    );
  }
  if (files.length === 0) {
    return refusalFrom(
      base,
      "missing_backup",
      `variant backup ${revert.backupDir} is empty`,
    );
  }
  if (actualHash !== revert.hash) {
    return refusalFrom(
      base,
      "backup_hash_mismatch",
      `variant backup hash ${actualHash} does not match the recorded ${revert.hash}`,
    );
  }

  const dirty = await repoDirty(revert.targetDir);
  if (dirty.dirty) {
    return refusalFrom(
      base,
      "dirty_worktree",
      `target ${revert.targetDir} is inside a dirty worktree`,
    );
  }
  if (dirty.error) {
    return refusalFrom(base, "git_unavailable", dirty.error);
  }

  return {
    ...base,
    action: {
      kind: "restore-variant",
      targetDir: revert.targetDir,
      backupDir: revert.backupDir,
      files,
    },
    refusal: null,
  };
}

async function applyAction(
  deps: ChangeRollbackDeps,
  plan: ChangeRollbackPlan,
): Promise<{
  ok: boolean;
  detail: string;
  after: Partial<ChangeRollbackSnapshot>;
}> {
  const action = plan.action;
  if (!action) {
    return { ok: false, detail: "no rollback action was planned", after: {} };
  }

  if (action.kind === "git-revert") {
    const reverted = await runGit(deps.repoRoot, [
      "-c",
      "user.name=kit",
      "-c",
      "user.email=kit@localhost",
      "revert",
      "--no-edit",
      action.commit,
    ]);
    if (reverted.exitCode !== 0) {
      await runGit(deps.repoRoot, ["revert", "--abort"]);
      return {
        ok: false,
        detail: `git revert ${action.commit} failed: ${reverted.stderr.slice(0, 1000)}`,
        after: {},
      };
    }
    const head = await runGit(deps.repoRoot, ["rev-parse", "HEAD"]);
    return {
      ok: true,
      detail: `reverted own commit ${action.commit} (new HEAD ${head.stdout.trim()})`,
      after: { head: head.stdout.trim() },
    };
  }

  const actualHash = await hashVariantBackup(action.backupDir);
  const proposal = await deps.proposals.get(plan.changeId);
  if (
    proposal?.revert?.kind === "instruction" &&
    actualHash !== proposal.revert.hash
  ) {
    return {
      ok: false,
      detail: `variant backup changed after planning (${actualHash} != ${proposal.revert.hash})`,
      after: {},
    };
  }
  for (const relative of action.files) {
    const content = await readFile(path.join(action.backupDir, relative));
    const destination = path.join(action.targetDir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.tmp`;
    await writeFile(temp, content);
    await rename(temp, destination);
  }
  return {
    ok: true,
    detail: `restored ${action.files.length} variant file(s) into ${action.targetDir}`,
    after: { files: [...action.files] },
  };
}

async function snapshotBefore(
  repoRoot: string,
  plan: ChangeRollbackPlan,
): Promise<ChangeRollbackSnapshot> {
  const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return {
    state: plan.state,
    head: head.exitCode === 0 ? head.stdout.trim() || null : null,
    revertRef: plan.revertRef,
    files:
      plan.action?.kind === "restore-variant" ? [...plan.action.files] : [],
  };
}

async function finish(input: {
  at: string;
  auditPath: string;
  changeId: string;
  actor: string;
  dryRun: boolean;
  plan: ChangeRollbackPlan;
  before: ChangeRollbackSnapshot;
  after: ChangeRollbackSnapshot;
  status: ChangeRollbackStatus;
  detail: string;
}): Promise<ChangeRollbackResult> {
  const entry: ChangeRollbackAuditEntry = {
    at: input.at,
    action: "rollback",
    changeId: input.changeId,
    substrate: input.plan.substrate,
    actor: input.actor,
    dryRun: input.dryRun,
    status: input.status,
    before: input.before,
    after: input.after,
    detail: input.detail,
  };
  await appendChangeRollbackAudit(input.auditPath, entry);
  return {
    status: input.status,
    changeId: input.changeId,
    plan: input.plan,
    before: input.before,
    after: input.after,
    detail: input.detail,
    auditPath: input.auditPath,
  };
}

function describeAction(plan: ChangeRollbackPlan): string {
  if (!plan.action) {
    return "nothing to roll back";
  }
  if (plan.action.kind === "git-revert") {
    return `would revert commit ${plan.action.commit} (HEAD ${plan.action.head})`;
  }
  return `would restore ${plan.action.files.length} file(s) from ${plan.action.backupDir}`;
}

function refusalPlan(
  changeId: string,
  workspaceId: string | null,
  substrate: ChangeRollbackSubstrate,
  state: ChangeState | null,
  revertRef: string | null,
  refusal: { code: ChangeRollbackRefusalCode; message: string },
): ChangeRollbackPlan {
  return {
    changeId,
    workspaceId,
    substrate,
    state,
    revertRef,
    action: null,
    refusal,
  };
}

function refusalFrom(
  base: Omit<ChangeRollbackPlan, "action" | "refusal">,
  code: ChangeRollbackRefusalCode,
  message: string,
): ChangeRollbackPlan {
  return { ...base, action: null, refusal: { code, message } };
}

async function repoDirty(
  dir: string,
): Promise<{ dirty: boolean; error?: string }> {
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) {
    // Not inside a git repository: nothing to keep clean.
    return { dirty: false };
  }
  const status = await runGit(top.stdout.trim(), ["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    return {
      dirty: false,
      error: `cannot read git status: ${status.stderr.slice(0, 500)}`,
    };
  }
  return { dirty: status.stdout.trim().length > 0 };
}

async function listVariantFiles(
  root: string,
  dir: string = root,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listVariantFiles(root, full)));
    } else if (entry.isFile()) {
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!relative.split("/").includes("..")) {
        results.push(relative);
      }
    }
  }
  return results.sort();
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
