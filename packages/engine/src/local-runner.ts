import { newId } from "@kit/core";
import { findDecisionForRequest } from "@kit/manager";
import type { initStore } from "@kit/store";
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
  onError?: (error: unknown) => void;
  /** Test seam for the iteration pipeline's activity layer. */
  iterationActivities?: IterationPipelineActivities;
}

export function startLocalRunner(options: LocalRunnerLoopOptions): () => void {
  const owner =
    options.owner ?? `local-${process.pid}-${Date.now().toString(36)}`;
  const tickMs = options.tickMs ?? 1000;
  const staleMs = options.staleMs ?? 60_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
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

  const tick = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    if (!busy) {
      busy = true;
      try {
        const request = await options.store.runRequests.claimNext(
          owner,
          new Date(),
          staleMs,
        );
        if (request) {
          await execute(request.payload, request.requestId, request.kind);
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
    payload: string,
    requestId: string,
    kind: "pack_run" | "iteration",
  ): Promise<void> {
    const heartbeatTimer = setInterval(() => {
      void options.store.runRequests
        .heartbeat(requestId, owner, new Date())
        .catch(() => undefined);
    }, heartbeatMs);
    try {
      if (kind === "iteration") {
        await executeIteration(
          JSON.parse(payload) as IterationInput,
          requestId,
        );
      } else {
        const input = JSON.parse(payload) as PackRunInput;
        await runPackWorkflowLocal(input, { store: options.store });
        await options.store.runRequests.finish(requestId, "done");
      }
    } catch (error) {
      if (error instanceof IterationCancelledError) {
        await options.store.runRequests
          .finish(requestId, "cancelled", error.message)
          .catch(() => undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await options.store.runRequests
        .finish(requestId, "failed", message)
        .catch(() => undefined);
      onError(error);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async function executeIteration(
    input: IterationInput,
    requestId: string,
  ): Promise<void> {
    // A stale claim may belong to a run that already reached a terminal state;
    // finishing the request is enough, re-running would duplicate side effects.
    const status = await iterationsStatus(options.store, input.iterationId);
    if (status && isTerminalIterationStatus(status)) {
      await options.store.runRequests.finish(
        requestId,
        status === "cancelled" ? "cancelled" : "done",
      );
      return;
    }
    await runIterationWorkflowLocal(input, {
      store: options.store,
      ...(options.iterationActivities
        ? { iterationActivities: options.iterationActivities }
        : {}),
    });
    await options.store.runRequests.finish(requestId, "done");
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
