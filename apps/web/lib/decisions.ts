import { appendActivity } from "@kit/activity";
import { newId } from "@kit/core";
import {
  decideApprovalRecord,
  findApprovalRequest,
  recordDecision,
} from "@kit/manager";
import { createTemporalClient } from "@kit/workflow";
import { ensureStoreSchema, getStore } from "./store";

export type DecisionOutcome =
  | {
      ok: true;
      requestId: string;
      decision: "approve" | "abort";
      duplicate: boolean;
      batchId: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      currentRequestId?: string;
      recorded?: boolean;
      signaled?: boolean;
    };

export async function decideApproval(input: {
  runId: string;
  requestId: string;
  decision: "approve" | "abort";
  note: string;
  actor: string;
  batchId?: string;
}): Promise<DecisionOutcome> {
  await ensureStoreSchema();
  const store = await getStore();
  const run = await store.runs.get(input.runId);
  if (!run) {
    return { ok: false, status: 404, error: "run not found" };
  }
  if (run.status !== "paused") {
    return {
      ok: false,
      status: 409,
      error: `run is ${run.status}, not paused`,
    };
  }

  const approval = await findApprovalRequest(store, input.runId);
  if (!approval) {
    return { ok: false, status: 404, error: "approval request not found" };
  }
  if (approval.requestId !== input.requestId) {
    return {
      ok: false,
      status: 409,
      error: "stale approval request",
      currentRequestId: approval.requestId,
    };
  }
  if (
    approval.expiresAt &&
    new Date(approval.expiresAt).getTime() < Date.now()
  ) {
    return { ok: false, status: 409, error: "approval request expired" };
  }

  const recorded = await decideApprovalRecord(store, {
    runId: input.runId,
    requestId: input.requestId,
    decision: input.decision,
    actor: input.actor,
    note: input.note,
  });
  if (!recorded.ok) {
    return { ok: false, status: recorded.status, error: recorded.error };
  }

  const batchId = input.batchId ?? recorded.batchId ?? newId("batch");
  if (!recorded.duplicate) {
    await recordDecision(store, input.runId, input.decision, input.note, {
      requestId: input.requestId,
      actor: input.actor,
      batchId,
      riskClass: approval.riskClass,
    });
  }
  const effectiveBatchId = batchId;
  const duplicate = recorded.duplicate;

  await appendActivity(store, {
    runId: input.runId,
    agentId: "operator",
    kind: "approval.decided",
    status: input.decision,
    summary: input.note || input.decision,
    payload: {
      requestId: input.requestId,
      actor: input.actor,
      duplicate,
    },
  }).catch(() => undefined);

  if (store.driver === "sqlite") {
    // Local runs poll decision records instead of receiving Temporal signals.
    return {
      ok: true,
      requestId: input.requestId,
      decision: input.decision,
      duplicate,
      batchId: effectiveBatchId,
    };
  }

  const { client, connection } = await createTemporalClient();
  try {
    const handle = client.workflow.getHandle(`pack-${input.runId}`);
    await handle.signal("approval", {
      decision: input.decision,
      note: input.note,
      requestId: input.requestId,
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error:
        error instanceof Error ? error.message : "failed to signal workflow",
      recorded: true,
      signaled: false,
      currentRequestId: approval.requestId,
    };
  } finally {
    await connection.close();
  }

  return {
    ok: true,
    requestId: input.requestId,
    decision: input.decision,
    duplicate,
    batchId: effectiveBatchId,
  };
}
