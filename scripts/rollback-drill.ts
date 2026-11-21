#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type ChangeRollbackStatus,
  executeChangeRollback,
  hashVariantBackup,
  readChangeRollbackAudit,
} from "@kit/change/rollback";
import {
  type ChangeProposal,
  newChangeProposal,
  newRecoveryDrill,
} from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { GATE_RTO_TARGET_MINUTES } from "./gate-report/model";

/**
 * Rollback drill for the evolution plane (70 §5; 85 §3.5.6).
 *
 * Runs one code-change rollback and one instruction-change rollback through the
 * SAME executor used by `kitd rollback -Change` (`executeChangeRollback`), so
 * there is no second rollback path:
 * - code: `git revert` of exactly the recorded commit, under the apply lock;
 * - instruction: restore the variant backup after re-verifying its hash.
 *
 * The drill is deterministic and isolated: temporary git repositories, a
 * temporary workspace variant and a temporary SQLite store. It never touches
 * the checkout, the operator's store or a live kitd.
 *
 * Measured RTO is the worst of the two rollbacks (a single degraded state needs
 * one rollback), compared against the G6 target imported from the gate report,
 * so there is one judgment. The report JSON uses the shape the gate report
 * collector already reads (`finishedAt`, `outcome`, `recoverySeconds`,
 * `checks[].pass`) and is written to `<home>/audit/rollback-drill-<stamp>.json`
 * by default. A `RecoveryDrill` row is recorded through the existing
 * `newRecoveryDrill` + `store.drills` persistence.
 *
 * Dry-run by default; `--execute` runs the drill.
 *
 * Run: `bun run drill:rollback --execute [--out docs/evidence/<file>.json]`
 */

const DRILL_SCRIPT = "scripts/rollback-drill.ts" as const;
const DEFAULT_WORKSPACE = "drill-rollback";

type StoreHandle = Pick<
  Awaited<ReturnType<typeof initStore>>,
  "changeProposals" | "drills"
>;

export interface RollbackDrillCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ChangeRollbackMeasurement {
  substrate: "code" | "instruction";
  changeId: string;
  status: ChangeRollbackStatus;
  seconds: number;
  startedAt: string;
  finishedAt: string;
  headBefore: string | null;
  headAfter: string | null;
  commits: { base?: string; change?: string; revert?: string } | null;
  pass: boolean;
  checks: RollbackDrillCheck[];
}

export interface RollbackDrillReport {
  drillId: string;
  mode: "rollback";
  script: typeof DRILL_SCRIPT;
  outcome: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
  /** Worst-case rollback seconds; what G6 reads as the measured RTO. */
  recoverySeconds: number;
  deadlineSeconds: number;
  source: {
    repoRoot: string;
    gitSha: string | null;
    branch: string | null;
    dirty: boolean | null;
  };
  rto: {
    codeSeconds: number | null;
    instructionSeconds: number | null;
    worstCaseSeconds: number;
    worstCaseMinutes: number;
    targetMinutes: number;
  };
  integrityPass: boolean;
  storeRecorded: boolean;
  workdir: string | null;
  reportPath: string | null;
  changes: {
    code: ChangeRollbackMeasurement | null;
    instruction: ChangeRollbackMeasurement | null;
  };
  checks: RollbackDrillCheck[];
}

export interface RollbackDrillOptions {
  workspaceId?: string;
  executedBy?: string;
  /** Checkout whose commit SHA is recorded. Defaults to the current directory. */
  sourceRepo?: string;
  /** G6-compatible report; defaults to `<home>/audit/rollback-drill-<stamp>.json`. */
  reportPath?: string;
  /** Deterministic start timestamp for tests. */
  now?: string;
  /** Keep the temporary repositories and audit for inspection. */
  keepWorkdir?: boolean;
}

const execFileAsync = promisify(execFile);

export function defaultRollbackDrillReportPath(
  now: Date = new Date(),
  home: string = process.env.KIT_HOME ??
    path.join(os.homedir(), ".agent-team-kit"),
): string {
  return path.join(
    path.resolve(home),
    "audit",
    `rollback-drill-${utcStamp(now)}.json`,
  );
}

/**
 * Runs both rollbacks, records the drill and writes the report. The store is
 * supplied by the caller so tests can use a throwaway SQLite database.
 */
export async function runRollbackDrill(
  store: StoreHandle,
  options: RollbackDrillOptions = {},
): Promise<RollbackDrillReport> {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE;
  const executedBy = options.executedBy ?? "operator:rollback-drill";
  const sourceRepo = path.resolve(options.sourceRepo ?? process.cwd());
  const reportPath = path.resolve(
    options.reportPath ?? defaultRollbackDrillReportPath(),
  );
  const startedAt = options.now ?? new Date().toISOString();
  const startedMs = performance.now();
  const source = await readSource(sourceRepo);
  const checks: RollbackDrillCheck[] = [
    {
      name: "source-commit-recorded",
      pass: source.gitSha !== null,
      detail: source.gitSha
        ? `source commit ${source.gitSha}`
        : `could not read a commit SHA from ${source.repoRoot}`,
    },
  ];

  let root: string | null = null;
  let code: ChangeRollbackMeasurement | null = null;
  let instruction: ChangeRollbackMeasurement | null = null;
  let auditPath: string | null = null;
  try {
    root = await mkdtemp(path.join(os.tmpdir(), "kit-rollback-drill-"));
    const auditDir = path.join(root, "audit");
    await mkdir(auditDir, { recursive: true });
    auditPath = path.join(auditDir, "change-rollback.jsonl");

    try {
      code = await runCodeRollback({
        store,
        root,
        auditPath,
        workspaceId,
        actor: executedBy,
        now: startedAt,
      });
    } catch (error) {
      checks.push({
        name: "code-drill",
        pass: false,
        detail: `code rollback drill aborted: ${errorMessage(error)}`,
      });
    }

    try {
      instruction = await runInstructionRollback({
        store,
        root,
        auditPath,
        workspaceId,
        actor: executedBy,
        now: startedAt,
      });
    } catch (error) {
      checks.push({
        name: "instruction-drill",
        pass: false,
        detail: `instruction rollback drill aborted: ${errorMessage(error)}`,
      });
    }

    if (code) {
      checks.push(...code.checks);
    }
    if (instruction) {
      checks.push(...instruction.checks);
    }

    const codeSeconds = code?.seconds ?? null;
    const instructionSeconds = instruction?.seconds ?? null;
    const worstCaseSeconds = Math.max(
      Math.ceil(codeSeconds ?? 0),
      Math.ceil(instructionSeconds ?? 0),
    );
    const worstCaseMinutes = Math.ceil(worstCaseSeconds / 60);
    const bothOk = code?.status === "ok" && instruction?.status === "ok";
    checks.push({
      name: "substrates-rolled-back",
      pass: bothOk,
      detail: `code=${code?.status ?? "missing"} instruction=${instruction?.status ?? "missing"}`,
    });
    checks.push({
      name: "rto-target",
      pass:
        code !== null &&
        instruction !== null &&
        worstCaseMinutes <= GATE_RTO_TARGET_MINUTES,
      detail: `worst-case ${worstCaseMinutes} <= ${GATE_RTO_TARGET_MINUTES} minute(s)`,
    });
    const auditEntries = await readChangeRollbackAudit(auditPath, 20);
    const audited = new Set(
      auditEntries
        .filter((entry) => entry.status === "ok")
        .map((entry) => `${entry.changeId}:${entry.substrate}`),
    );
    checks.push({
      name: "audit-trail",
      pass:
        code !== null &&
        instruction !== null &&
        audited.has(`${code.changeId}:code`) &&
        audited.has(`${instruction.changeId}:instruction`),
      detail: `${auditEntries.length} change-rollback audit entr${auditEntries.length === 1 ? "y" : "ies"}`,
    });

    const integrityPass = checks.every((check) => check.pass);
    const finishedAt = new Date().toISOString();
    const drill = newRecoveryDrill({
      executedBy,
      script: DRILL_SCRIPT,
      rtoTargetMinutes: GATE_RTO_TARGET_MINUTES,
      measuredRtoMinutes: worstCaseMinutes,
      measuredRpoMinutes: null,
      kitdRollbackRef: code ? `change:${code.changeId}` : null,
      integrityPass,
      notes: `rollback drill: code=${codeSeconds ?? "n/a"}s instruction=${instructionSeconds ?? "n/a"}s source=${source.gitSha ?? "unknown"} audit=${auditPath}`,
      outcome: integrityPass ? "pass" : "fail",
      now: finishedAt,
    });
    await store.drills.recordRecoveryDrill(drill);
    const persisted = (await store.drills.listRecoveryDrills(50)).some(
      (item) => item.drillId === drill.drillId,
    );
    checks.push({
      name: "drill-recorded",
      pass: persisted,
      detail: persisted
        ? `recovery drill ${drill.drillId} persisted`
        : "recovery drill was not persisted",
    });

    const outcome = checks.every((check) => check.pass) ? "passed" : "failed";
    const report: RollbackDrillReport = {
      drillId: drill.drillId,
      mode: "rollback",
      script: DRILL_SCRIPT,
      outcome,
      startedAt,
      finishedAt,
      elapsedSeconds: roundSeconds((performance.now() - startedMs) / 1000),
      recoverySeconds: worstCaseSeconds,
      deadlineSeconds: GATE_RTO_TARGET_MINUTES * 60,
      source,
      rto: {
        codeSeconds,
        instructionSeconds,
        worstCaseSeconds,
        worstCaseMinutes,
        targetMinutes: GATE_RTO_TARGET_MINUTES,
      },
      integrityPass,
      storeRecorded: persisted,
      workdir: options.keepWorkdir ? root : null,
      reportPath,
      changes: { code, instruction },
      checks,
    };
    await writeReport(reportPath, report);
    return report;
  } finally {
    if (root && !options.keepWorkdir) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function runCodeRollback(input: {
  store: StoreHandle;
  root: string;
  auditPath: string;
  workspaceId: string;
  actor: string;
  now: string;
}): Promise<ChangeRollbackMeasurement> {
  const repo = path.join(input.root, "repo");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "a.txt"), "alpha\n", "utf8");
  await writeFile(path.join(repo, "b.txt"), "beta\n", "utf8");
  await git(repo, ["-c", "init.defaultBranch=main", "init", "-q"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "core.eol", "lf"]);
  const baseSha = await commitAll(repo, "baseline");

  await writeFile(path.join(repo, "a.txt"), "alpha\ndrill change\n", "utf8");
  const changeSha = await commitAll(repo, "drill: code change");
  await writeFile(path.join(repo, "b.txt"), "beta\nunrelated change\n", "utf8");
  await commitAll(repo, "drill: unrelated later change");

  const proposal: ChangeProposal = newChangeProposal({
    workspaceId: input.workspaceId,
    substrate: "code",
    producer: "iterate",
    hypothesis: "rollback drill: change a.txt",
    acceptance: ["rollback restores a.txt"],
    risk: "low",
    revertRef: `commit:${changeSha}`,
    revert: { kind: "code", commit: changeSha, baseSha, backupDir: null },
    actor: input.actor,
    now: input.now,
  });
  await input.store.changeProposals.create(proposal);

  const headBefore = await git(repo, ["rev-parse", "HEAD"]);
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const result = await executeChangeRollback(
    {
      proposals: input.store.changeProposals,
      repoRoot: repo,
      auditPath: input.auditPath,
    },
    { changeId: proposal.id, actor: input.actor, dryRun: false },
  );
  const seconds = roundSeconds((performance.now() - startedMs) / 1000);
  const finishedAt = new Date().toISOString();

  const headAfter = await git(repo, ["rev-parse", "HEAD"]);
  const reverted = await readFile(path.join(repo, "a.txt"), "utf8");
  const unrelated = await readFile(path.join(repo, "b.txt"), "utf8");
  const stored = await input.store.changeProposals.get(proposal.id);
  const entry = (await readChangeRollbackAudit(input.auditPath, 10))
    .filter((item) => item.changeId === proposal.id)
    .at(-1);

  const checks: RollbackDrillCheck[] = [
    {
      name: "code-rollback-status",
      pass: result.status === "ok",
      detail: `status=${result.status} ${result.detail}`,
    },
    {
      name: "code-own-commit-reverted",
      pass: reverted === "alpha\n",
      detail:
        reverted === "alpha\n"
          ? "a.txt restored to the baseline content"
          : `a.txt is ${JSON.stringify(reverted)}`,
    },
    {
      name: "code-unrelated-change-preserved",
      pass: unrelated === "beta\nunrelated change\n",
      detail:
        unrelated === "beta\nunrelated change\n"
          ? "later unrelated commit untouched"
          : "later unrelated commit was changed",
    },
    {
      name: "code-head-advanced",
      pass: headAfter !== headBefore && headAfter !== changeSha,
      detail: `HEAD ${headBefore.slice(0, 12)} -> ${headAfter.slice(0, 12)}`,
    },
    {
      name: "code-state-rolled-back",
      pass: stored?.state === "rolled_back",
      detail: `state=${stored?.state ?? "missing"}`,
    },
    {
      name: "code-audit",
      pass: entry?.status === "ok" && entry.substrate === "code",
      detail: entry
        ? `audit ${entry.status} substrate=${entry.substrate}`
        : "no audit entry",
    },
  ];

  return {
    substrate: "code",
    changeId: proposal.id,
    status: result.status,
    seconds,
    startedAt,
    finishedAt,
    headBefore,
    headAfter,
    commits: { base: baseSha, change: changeSha, revert: headAfter },
    pass: checks.every((check) => check.pass),
    checks,
  };
}

async function runInstructionRollback(input: {
  store: StoreHandle;
  root: string;
  auditPath: string;
  workspaceId: string;
  actor: string;
  now: string;
}): Promise<ChangeRollbackMeasurement> {
  const targetDir = path.join(input.root, "workspace", "target");
  const backupDir = path.join(input.root, "workspace", "backup");
  await mkdir(path.join(backupDir, "agents"), { recursive: true });
  await mkdir(path.join(targetDir, "agents"), { recursive: true });
  await writeFile(
    path.join(backupDir, "agents", "writer.md"),
    "old instructions\n",
    "utf8",
  );
  await writeFile(
    path.join(targetDir, "agents", "writer.md"),
    "new instructions\n",
    "utf8",
  );
  const hash = await hashVariantBackup(backupDir);

  const proposal: ChangeProposal = newChangeProposal({
    workspaceId: input.workspaceId,
    substrate: "prompt",
    producer: "evolve",
    hypothesis: "rollback drill: sharpen the writer instruction",
    acceptance: ["rollback restores the baseline instruction"],
    risk: "low",
    revertRef: "variant:drill-baseline",
    revert: { kind: "instruction", targetDir, backupDir, hash },
    actor: input.actor,
    now: input.now,
  });
  await input.store.changeProposals.create(proposal);

  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const result = await executeChangeRollback(
    {
      proposals: input.store.changeProposals,
      repoRoot: targetDir,
      auditPath: input.auditPath,
    },
    { changeId: proposal.id, actor: input.actor, dryRun: false },
  );
  const seconds = roundSeconds((performance.now() - startedMs) / 1000);
  const finishedAt = new Date().toISOString();

  const restored = await readFile(
    path.join(targetDir, "agents", "writer.md"),
    "utf8",
  );
  const backupAfter = await hashVariantBackup(backupDir);
  const stored = await input.store.changeProposals.get(proposal.id);
  const entry = (await readChangeRollbackAudit(input.auditPath, 10))
    .filter((item) => item.changeId === proposal.id)
    .at(-1);

  const checks: RollbackDrillCheck[] = [
    {
      name: "instruction-rollback-status",
      pass: result.status === "ok",
      detail: `status=${result.status} restored ${result.after.files.length} variant file(s)`,
    },
    {
      name: "instruction-restored",
      pass: restored === "old instructions\n",
      detail:
        restored === "old instructions\n"
          ? "writer.md restored from the backup"
          : `writer.md is ${JSON.stringify(restored)}`,
    },
    {
      name: "instruction-backup-integrity",
      pass: backupAfter === hash,
      detail: `backup hash ${backupAfter === hash ? "unchanged" : "changed"}`,
    },
    {
      name: "instruction-state-rolled-back",
      pass: stored?.state === "rolled_back",
      detail: `state=${stored?.state ?? "missing"}`,
    },
    {
      name: "instruction-audit",
      pass: entry?.status === "ok" && entry.substrate === "instruction",
      detail: entry
        ? `audit ${entry.status} substrate=${entry.substrate}`
        : "no audit entry",
    },
  ];

  return {
    substrate: "instruction",
    changeId: proposal.id,
    status: result.status,
    seconds,
    startedAt,
    finishedAt,
    headBefore: null,
    headAfter: null,
    commits: null,
    pass: checks.every((check) => check.pass),
    checks,
  };
}

async function readSource(
  repoRoot: string,
): Promise<RollbackDrillReport["source"]> {
  try {
    const [gitSha, branch, status] = await Promise.all([
      git(repoRoot, ["rev-parse", "HEAD"]),
      git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(repoRoot, ["status", "--porcelain"]),
    ]);
    return {
      repoRoot,
      gitSha: gitSha || null,
      branch: branch || null,
      dirty: status.length > 0,
    };
  } catch {
    return { repoRoot, gitSha: null, branch: null, dirty: null };
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, [
    "-c",
    "user.name=kit",
    "-c",
    "user.email=kit@local",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function writeReport(
  file: string,
  report: RollbackDrillReport,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function utcStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "-");
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function runCli(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const keepWorkdir = process.argv.includes("--keep-workdir");
  const executedBy = argValue("--executed-by") ?? "operator:rollback-drill";
  const workspaceId = argValue("--workspace") ?? DEFAULT_WORKSPACE;
  const sourceRepo = path.resolve(argValue("--repo") ?? process.cwd());
  const reportPath = path.resolve(
    argValue("--out") ?? defaultRollbackDrillReportPath(),
  );

  if (!execute) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          reuses: "executeChangeRollback (same path as kitd rollback -Change)",
          changes: [
            "code: git revert of the recorded commit",
            "instruction: restore the variant backup after hash re-verification",
          ],
          isolated: {
            gitRepos: "temporary",
            store: "temporary SQLite",
            audit: "temporary change-rollback.jsonl",
          },
          rtoTargetMinutes: GATE_RTO_TARGET_MINUTES,
          reportPath,
          hint: "pass --execute to run the drill and write the G6-compatible report",
        },
        null,
        2,
      ),
    );
    return;
  }

  const storeRoot = await mkdtemp(
    path.join(os.tmpdir(), "kit-rollback-store-"),
  );
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: path.join(storeRoot, "home"),
      KIT_BLOB_ROOT: path.join(storeRoot, "blobs"),
    }),
  );
  try {
    const report = await runRollbackDrill(store, {
      workspaceId,
      executedBy,
      sourceRepo,
      reportPath,
      keepWorkdir,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome !== "passed") {
      process.exitCode = 1;
    }
  } finally {
    await store.close();
    if (!keepWorkdir) {
      await rm(storeRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const invokedPath = process.argv[1];
const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (invokedPath !== undefined &&
    path.resolve(invokedPath) === fileURLToPath(import.meta.url));

if (isMain) {
  await runCli();
}
