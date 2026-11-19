import { newId } from "@kit/core";
import { findDecisionForRequest } from "@kit/manager";
import {
  type RunRequestRecord,
  VersionConflictError,
  type WriteLease,
  type initStore,
} from "@kit/store";
import type {
  IterationInput,
  IterationResult,
  PackRunInput,
  PackRunResult,
} from "@kit/workflow";
import { createDegradationGuard, guardedActivities } from "./degradation-guard";
import * as iterationActivities from "./iteration-activities";
import {
  IterationCancelledError,
  type IterationPipelineActivities,
  runIterationPipeline,
} from "./iteration-pipeline";
import { assertKillSwitchClear } from "./kill-switch";
import * as packActivities from "./pack-activities";
import { type ApprovalOutcome, runPackPipeline } from "./pack-pipeline";
import { reconcileLocalIterationRuns } from "./reconciler";
import { verifyRunRecoveryIntegrity } from "./recovery";
import {
  DEFAULT_RUN_LEASE_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_STALE_MS,
  RunLeaseLostError,
  assertRunLeaseTimings,
  markWriteLeaseLost,
  withWriteLease,
} from "./write-lease";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface LocalRunnerOptions {
  store: Store;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Activity implementation override. Production uses the real activities; tests
   * inject fakes so orchestration can be exercised without a coder binary.
   */
  iterationActivities?: IterationPipelineActivities;
}

export async function runPackWorkflowLocal(
  input: PackRunInput,
  options: LocalRunnerOptions,
): Promise<PackRunResult> {
  return runPackPipeline(input, {
    activities: guardedActivities(
      createDegradationGuard(options.store),
      packActivities,
    ),
    waitForApproval: (requestId, timeoutMs) =>
      waitForDecision(options, input.runId, requestId, timeoutMs),
  });
}

export async function runIterationWorkflowLocal(
  input: IterationInput,
  options: LocalRunnerOptions,
): Promise<IterationResult> {
  return runIterationPipeline(
    input,
    options.iterationActivities ?? iterationActivities,
  );
}

async function waitForDecision(
  options: LocalRunnerOptions,
  runId: string,
  requestId: string | undefined,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  if (!requestId) {
    // A required approval without an id cannot be correlated with a decision;
    // fail closed instead of auto-approving.
    return "timeout";
  }

  const pollMs = options.pollMs ?? 1000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const decision = await findDecisionForRequest(
      options.store,
      runId,
      requestId,
    );
    if (decision) {
      return decision.option === "approve" ? "approved" : "aborted";
    }
    await sleep(pollMs);
  }

  return "timeout";
}

async function enqueueLocalRequest(
  record: {
    runId: string;
    workspaceId: string;
    workflowId: string;
  },
  kind: "pack_run" | "iteration",
  payload: string,
  store: Store,
): Promise<{ requestId: string }> {
  const now = new Date().toISOString();
  const requestId = newId("rrq");
  await store.runRequests.enqueue({
    requestId,
    runId: record.runId,
    workspaceId: record.workspaceId,
    workflowId: record.workflowId,
    kind,
    payload,
    createdAt: now,
    updatedAt: now,
  });
  return { requestId };
}

export async function enqueueLocalRun(
  input: PackRunInput,
  store: Store,
): Promise<{ requestId: string }> {
  await assertKillSwitchClear(store, { workspaceId: input.workspaceId }, "run");
  return enqueueLocalRequest(
    {
      runId: input.runId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
    },
    "pack_run",
    JSON.stringify(input),
    store,
  );
}

export async function enqueueLocalIteration(
  input: IterationInput,
  store: Store,
): Promise<{ requestId: string }> {
  await assertKillSwitchClear(store, { workspaceId: input.workspaceId }, "run");
  return enqueueLocalRequest(
    {
      runId: input.iterationId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId ?? `iteration-${input.iterationId}`,
    },
    "iteration",
    JSON.stringify(input),
    store,
  );
}

export interface LocalRunnerLoopOptions {
  store: Store;
  owner?: string;
  tickMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  reconcileEveryMs?: number;
  onError?: (error: unknown) => void;
  /** Test seam for the iteration pipeline's activity layer. */
  iterationActivities?: IterationPipelineActivities;
}

export function startLocalRunner(options: LocalRunnerLoopOptions): () => void {
  const owner =
    options.owner ?? `local-${process.pid}-${Date.now().toString(36)}`;
  const tickMs = options.tickMs ?? 1000;
  const staleMs = options.staleMs ?? DEFAULT_RUN_LEASE_STALE_MS;
  // A heartbeat slower than half the stale window can be reclaimed while the
  // worker still believes it owns the run; refuse to start instead.
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_RUN_LEASE_HEARTBEAT_MS;
  assertRunLeaseTimings(staleMs, heartbeatMs);
  const reconcileEveryMs = options.reconcileEveryMs ?? 60_000;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(
        `[local-runner] ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let lastReconcileAt = 0;

  const reconcile = async (): Promise<void> => {
    lastReconcileAt = Date.now();
    try {
      const repaired = await reconcileLocalIterationRuns({
        store: options.store,
      });
      if (repaired.length > 0) {
        console.log(`[local-runner] reconciled ${repaired.length} run(s)`);
      }
    } catch (error) {
      onError(error);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    if (!busy) {
      busy = true;
      try {
        if (Date.now() - lastReconcileAt >= reconcileEveryMs) {
          await reconcile();
        }
        const request = await options.store.runRequests.claimNext(
          owner,
          new Date(),
          staleMs,
        );
        if (request) {
          await execute(request, {
            requestId: request.requestId,
            owner,
            leaseVersion: request.leaseVersion,
          });
        }
      } catch (error) {
        onError(error);
      } finally {
        busy = false;
      }
    }
    if (!stopping) {
      timer = setTimeout(() => {
        void tick();
      }, tickMs);
    }
  };

  async function execute(
    request: RunRequestRecord,
    lease: WriteLease,
  ): Promise<void> {
    const requestId = request.requestId;
    const leaseLost = (reason: string): RunLeaseLostError =>
      markWriteLeaseLost(
        new RunLeaseLostError(reason, requestId, lease.leaseVersion),
      );

    const heartbeatTimer = setInterval(() => {
      void options.store.runRequests
        .heartbeat(requestId, owner, new Date(), lease.leaseVersion)
        .then((record) => {
          if (record) {
            lease.leaseVersion = record.leaseVersion;
            return;
          }
          // No row means the claim is gone even though the store did not
          // throw; treat it exactly like a fenced rejection.
          leaseLost(`run request ${requestId} is no longer held by ${owner}`);
        })
        .catch((error: unknown) => {
          if (error instanceof VersionConflictError) {
            leaseLost(
              `run request ${requestId} was reclaimed by another worker`,
            );
            return;
          }
          // Transient heartbeat failures are retried on the next beat; a
          // full stale window without a successful renewal still fences all
          // writes, because the store only accepts the current owner.
        });
    }, heartbeatMs);
    try {
      await withWriteLease(lease, async () => {
        if (request.leaseVersion > 1) {
          // This request was claimed before; its previous owner may have
          // half-executed. Verify ArtifactVersion integrity before running
          // another stage or side effect.
          const recovery = await verifyRunRecoveryIntegrity({
            store: options.store,
            runId: request.runId,
            workspaceId: request.workspaceId,
            requestId,
            owner,
            leaseVersion: request.leaseVersion,
          });
          if (recovery.action === "failed") {
            await options.store.runRequests
              .finish(
                requestId,
                "failed",
                recovery.failureReason ??
                  "recovery integrity verification failed",
                lease,
              )
              .catch(() => undefined);
            return;
          }
        }
        if (request.kind === "iteration") {
          await executeIteration(
            JSON.parse(request.payload) as IterationInput,
            requestId,
            lease,
          );
        } else {
          const input = JSON.parse(request.payload) as PackRunInput;
          await runPackWorkflowLocal(input, { store: options.store });
          await options.store.runRequests.finish(
            requestId,
            "done",
            undefined,
            lease,
          );
        }
      });
    } catch (error) {
      if (error instanceof RunLeaseLostError) {
        // The lease is gone; the new owner drives the request from here. Do
        // not write run status or finish the request — that is the fencing
        // conflict this watchdog exists to surface early.
        onError(error);
        return;
      }
      if (error instanceof VersionConflictError) {
        // The claim was superseded while this worker was running; the new
        // owner drives the request from here. The store already audited the
        // rejection to the op log.
        onError(error);
        return;
      }
      if (error instanceof IterationCancelledError) {
        await options.store.runRequests
          .finish(requestId, "cancelled", error.message, lease)
          .catch(() => undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await options.store.runRequests
        .finish(requestId, "failed", message, lease)
        .catch(() => undefined);
      onError(error);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async function executeIteration(
    input: IterationInput,
    requestId: string,
    lease: WriteLease,
  ): Promise<void> {
    // A stale claim may belong to a run that already reached a terminal state;
    // finishing the request is enough, re-running would duplicate side effects.
    const status = await iterationsStatus(options.store, input.iterationId);
    if (status && isTerminalIterationStatus(status)) {
      await options.store.runRequests.finish(
        requestId,
        status === "cancelled" ? "cancelled" : "done",
        undefined,
        lease,
      );
      return;
    }
    await runIterationWorkflowLocal(input, {
      store: options.store,
      ...(options.iterationActivities
        ? { iterationActivities: options.iterationActivities }
        : {}),
    });
    await options.store.runRequests.finish(requestId, "done", undefined, lease);
  }

  void tick();
  return () => {
    stopping = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

async function iterationsStatus(
  store: Store,
  iterationId: string,
): Promise<string | null> {
  const rows = await store.sql<Array<{ status: string }>>`
    SELECT status FROM iteration_runs
    WHERE iteration_id = ${iterationId} LIMIT 1
  `;
  return rows[0]?.status ?? null;
}

function isTerminalIterationStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled"
  );
}
