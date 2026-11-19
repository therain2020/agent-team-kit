import { appendActivity } from "@kit/activity";
import { emitAlert } from "@kit/ops";
import {
  type OpLogEntry,
  type RunIntegrityReport,
  appendOp,
  type initStore,
  verifyRunArtifacts,
} from "@kit/store";
import { assertWriteLeaseActive, writeLeaseOptions } from "./write-lease";

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Recovery gate (61 §3.5): a run reclaimed by a new owner may only continue
 * after its committed ArtifactVersions verify against sha256 + Manifest. On
 * failure the run is stopped, the reason is audited, and an alert is raised;
 * the next owner never resumes from an unverified checkpoint.
 */
export interface RecoveryIntegrityInput {
  store: Store;
  runId: string;
  workspaceId: string;
  /** The run request being executed under the new claim. */
  requestId?: string;
  owner?: string;
  leaseVersion?: number;
  /**
   * Verify even when the run produced no artifacts yet. Defaults to true so
   * every recovery is recorded, including the vacuous pass.
   */
  recordWhenEmpty?: boolean;
}

export interface RecoveryIntegrityOutcome {
  ok: boolean;
  report: RunIntegrityReport;
  /** `continue` when verification passed, `failed` when the run was stopped. */
  action: "continue" | "failed";
  failureReason?: string;
}

function summarizeFailures(report: RunIntegrityReport): string {
  return report.failures
    .map(
      (failure) =>
        `${failure.artifactId}@${failure.version} (${failure.stageId ?? "unknown stage"}): ${failure.problems
          .map((problem) => `${problem.code}=${problem.detail}`)
          .join("; ")}`,
    )
    .join(" | ");
}

async function safeAudit(store: Store, entry: OpLogEntry): Promise<void> {
  try {
    await appendOp(store, entry);
  } catch (error) {
    console.error(
      `[recovery] audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function safeActivity(
  store: Store,
  input: Parameters<typeof appendActivity>[1],
): Promise<void> {
  try {
    await appendActivity(store, input);
  } catch (error) {
    console.error(
      `[recovery] activity failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function safeAlert(
  store: Store,
  input: Parameters<typeof emitAlert>[1],
): Promise<void> {
  try {
    await emitAlert(store, input);
  } catch (error) {
    console.error(
      `[recovery] alert failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Runs the integrity check for a recovered run and records the outcome. This
 * function does not execute the pipeline; the caller decides whether to
 * continue based on `action`.
 */
export async function verifyRunRecoveryIntegrity(
  input: RecoveryIntegrityInput,
): Promise<RecoveryIntegrityOutcome> {
  assertWriteLeaseActive();

  const report = await verifyRunArtifacts(input.store, input.runId);

  if (report.ok && report.checked === 0 && input.recordWhenEmpty === false) {
    return { ok: true, report, action: "continue" };
  }

  const leasePayload = {
    requestId: input.requestId ?? null,
    owner: input.owner ?? null,
    leaseVersion: input.leaseVersion ?? null,
  };

  if (report.ok) {
    await safeAudit(input.store, {
      workspaceId: input.workspaceId,
      entityKind: "run",
      entityId: input.runId,
      op: "run.recovery.verified",
      actor: input.owner ?? "engine",
      origin: "system",
      idempotencyKey: `run.recovery.verified:${input.runId}:${input.leaseVersion ?? 0}`,
      payload: {
        checked: report.checked,
        artifacts: report.checks.map((check) => ({
          artifactId: check.artifactId,
          version: check.version,
          sha256: check.sha256,
        })),
        ...leasePayload,
      },
    });
    return { ok: true, report, action: "continue" };
  }

  const failureReason = `recovery integrity verification failed: ${summarizeFailures(report)}`;

  // Iteration runs live in `iteration_runs`, not `runs`; only flip the row
  // when it exists so the failure audit is not muddied by a fencing error.
  const run = await input.store.runs.get(input.runId).catch(() => null);
  if (run) {
    await input.store.runs
      .updateStatus(
        input.runId,
        "failed",
        new Date().toISOString(),
        writeLeaseOptions(),
      )
      .catch((error: unknown) => {
        console.error(
          `[recovery] failed to mark run failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  await safeAudit(input.store, {
    workspaceId: input.workspaceId,
    entityKind: "run",
    entityId: input.runId,
    op: "run.recovery.failed",
    actor: input.owner ?? "engine",
    origin: "system",
    payload: {
      reason: failureReason,
      checked: report.checked,
      failed: report.failures.map((failure) => ({
        artifactId: failure.artifactId,
        version: failure.version,
        stageId: failure.stageId,
        problems: failure.problems,
      })),
      ...leasePayload,
    },
  });

  await safeActivity(input.store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    kind: "run.recovery.blocked",
    status: "failed",
    summary: failureReason.slice(0, 500),
    payload: {
      checked: report.checked,
      failures: report.failures.length,
      artifacts: report.failures.map((failure) => failure.artifactId),
    },
  });

  await safeAlert(input.store, {
    workspaceId: input.workspaceId,
    tier: "P1",
    kind: "run.recovery.integrity_failed",
    title: `Recovery blocked: ${input.runId}`,
    body: failureReason,
    runId: input.runId,
    source: "engine",
    meta: { checked: report.checked, failures: report.failures.length },
  });

  return { ok: false, report, action: "failed", failureReason };
}
