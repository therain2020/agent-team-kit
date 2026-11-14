import { appendActivity } from "@kit/activity";
import {
  findApprovalRequest,
  findDecisionForRequest,
  recordDecision,
} from "@kit/manager";
import { createTemporalClient } from "@kit/workflow";
import { getStore } from "./store";

export type DecisionOutcome =
  | {
      ok: true;
      requestId: string;
      decision: "approve" | "abort";
      duplicate: boolean;
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
}): Promise<DecisionOutcome> {
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

  const existing = await findDecisionForRequest(
    store,
    input.runId,
    input.requestId,
  );
  if (!existing) {
    await recordDecision(store, input.runId, input.decision, input.note, {
      requestId: input.requestId,
      actor: input.actor,
    });
  }

  await appendActivity(store, {
    runId: input.runId,
    agentId: "operator",
    kind: "approval.decided",
    status: input.decision,
    summary: input.note || input.decision,
    payload: {
      requestId: input.requestId,
      actor: input.actor,
      duplicate: Boolean(existing),
    },
  }).catch(() => undefined);

  if (store.driver === "sqlite") {
    // Local runs poll decision records instead of receiving Temporal signals.
    return {
      ok: true,
      requestId: input.requestId,
      decision: input.decision,
      duplicate: Boolean(existing),
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
    duplicate: Boolean(existing),
  };
}
