import { newId } from "@kit/core";
import { findDecisionForRequest } from "@kit/manager";
import type { initStore } from "@kit/store";
import type { PackRunInput, PackRunResult } from "@kit/workflow";
import * as activities from "./pack-activities";
import { type ApprovalOutcome, runPackPipeline } from "./pack-pipeline";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface LocalRunnerOptions {
  store: Store;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runPackWorkflowLocal(
  input: PackRunInput,
  options: LocalRunnerOptions,
): Promise<PackRunResult> {
  return runPackPipeline(input, {
    activities,
    waitForApproval: (requestId, timeoutMs) =>
      waitForDecision(options, input.runId, requestId, timeoutMs),
  });
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

export async function enqueueLocalRun(
  input: PackRunInput,
  store: Store,
): Promise<{ requestId: string }> {
  const now = new Date().toISOString();
  const requestId = newId("rrq");
  await store.runRequests.enqueue({
    requestId,
    runId: input.runId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    payload: JSON.stringify(input),
    createdAt: now,
    updatedAt: now,
  });
  return { requestId };
}

export interface LocalRunnerLoopOptions {
  store: Store;
  owner?: string;
  tickMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  onError?: (error: unknown) => void;
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
          await execute(request.payload, request.requestId);
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

  async function execute(payload: string, requestId: string): Promise<void> {
    const heartbeatTimer = setInterval(() => {
      void options.store.runRequests
        .heartbeat(requestId, owner, new Date())
        .catch(() => undefined);
    }, heartbeatMs);
    try {
      const input = JSON.parse(payload) as PackRunInput;
      await runPackWorkflowLocal(input, { store: options.store });
      await options.store.runRequests.finish(requestId, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.store.runRequests
        .finish(requestId, "failed", message)
        .catch(() => undefined);
      onError(error);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  void tick();
  return () => {
    stopping = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}
