import { type PriorityClass, newId, priorityClassFor } from "@kit/core";
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
import {
  type AdmissionAction,
  type AdmissionPolicy,
  decideAdmission,
  loadAdmissionPolicy,
} from "./admission";
import { createDegradationGuard, guardedActivities } from "./degradation-guard";
import { FairClaimScheduler } from "./fair-claim";
import type { FairQueueOptions } from "./fair-queue";
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

/** Operator knobs for the enqueue admission gate (test seam + policy override). */
export interface EnqueueRunOptions {
  admissionPolicy?: AdmissionPolicy;
}

/** Observable result of an enqueue, including the admission verdict. */
export interface EnqueueRunResult {
  requestId: string;
  priority: PriorityClass;
  /** `admit`/`queue` for accepted work, `merge` for a duplicate, `drop` for P3. */
  admission: AdmissionAction;
  dropped: boolean;
}

interface EnqueueFields {
  runId: string;
  workspaceId: string;
  workflowId: string;
}

async function enqueueLocalRequest(
  record: EnqueueFields,
  kind: "pack_run" | "iteration",
  payload: string,
  store: Store,
  admission: {
    priority: PriorityClass;
    status: "queued" | "dropped";
    admissionReason: string | null;
  },
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
    priority: admission.priority,
    status: admission.status,
    admissionReason: admission.admissionReason,
    createdAt: now,
    updatedAt: now,
  });
  return { requestId };
}

/**
 * Admission gate shared by pack and iteration enqueues (60 §3.4).
 *
 * Duplicates fold into the existing request; P3 is dropped once the backlog
 * reaches the configured cap, while P0/P1/P2 stay queued. Budget and kill
 * switch are evaluated before this point (kill switch here, budget at run
 * start), matching `decideAdmission`'s documented ordering.
 */
async function admit(
  runId: string,
  priority: PriorityClass,
  store: Store,
  options: EnqueueRunOptions | undefined,
): Promise<{
  existing: RunRequestRecord | null;
  action: AdmissionAction;
  reason: string;
}> {
  const existing = await store.runRequests.find(runId);
  const policy = options?.admissionPolicy ?? loadAdmissionPolicy();
  const decision = decideAdmission({
    priority,
    duplicate: existing !== null,
    queueDepth: existing ? 0 : await store.runRequests.countQueued(),
    maxQueueDepth: policy.maxQueueDepth,
  });
  return { existing, action: decision.action, reason: decision.reason };
}

function existingResult(existing: RunRequestRecord): EnqueueRunResult {
  const dropped = existing.status === "dropped";
  return {
    requestId: existing.requestId,
    priority: existing.priority,
    admission: dropped ? "drop" : "merge",
    dropped,
  };
}

export async function enqueueLocalRun(
  input: PackRunInput,
  store: Store,
  options?: EnqueueRunOptions,
): Promise<EnqueueRunResult> {
  await assertKillSwitchClear(store, { workspaceId: input.workspaceId }, "run");
  const priority = priorityClassFor({
    priority: input.priority,
    runMode: input.runMode,
  });
  const verdict = await admit(input.runId, priority, store, options);
  if (verdict.existing) {
    // Duplicate run id: fold into the queued request (60 §3.4 "事件合并").
    // A previously dropped request stays dropped; report that instead of
    // pretending it will run.
    return existingResult(verdict.existing);
  }
  const dropped = verdict.action === "drop";
  const queued = await enqueueLocalRequest(
    {
      runId: input.runId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
    },
    "pack_run",
    JSON.stringify({ ...input, priority }),
    store,
    {
      priority,
      status: dropped ? "dropped" : "queued",
      admissionReason: dropped ? verdict.reason : null,
    },
  );
  return {
    requestId: queued.requestId,
    priority,
    admission: verdict.action,
    dropped,
  };
}

export async function enqueueLocalIteration(
  input: IterationInput,
  store: Store,
  options?: EnqueueRunOptions,
): Promise<EnqueueRunResult> {
  await assertKillSwitchClear(store, { workspaceId: input.workspaceId }, "run");
  const priority = priorityClassFor({
    priority: input.priority,
    runMode: input.runMode,
  });
  const verdict = await admit(input.iterationId, priority, store, options);
  if (verdict.existing) {
    return existingResult(verdict.existing);
  }
  const dropped = verdict.action === "drop";
  const queued = await enqueueLocalRequest(
    {
      runId: input.iterationId,
      workspaceId: input.workspaceId,
      workflowId: input.workflowId ?? `iteration-${input.iterationId}`,
    },
    "iteration",
    JSON.stringify({ ...input, priority }),
    store,
    {
      priority,
      status: dropped ? "dropped" : "queued",
      admissionReason: dropped ? verdict.reason : null,
    },
  );
  return {
    requestId: queued.requestId,
    priority,
    admission: verdict.action,
    dropped,
  };
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
  /** Per-workspace fairness weights for the claim scheduler (60.6). */
  fairQueue?: FairQueueOptions;
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
  // Single claim selector: workspace-weighted WFQ + P0 preemption. The store
  // still owns the atomic transition, so this only decides the order.
  const claimScheduler = new FairClaimScheduler(options.fairQueue ?? {});

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
        const request = await claimScheduler.claimNext(
          options.store,
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
