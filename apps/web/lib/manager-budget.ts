import { newId } from "@kit/core";
import type { ManagerSessionRecord } from "@kit/store";
import {
  MANAGER_COST_LIMIT_CNY,
  MANAGER_TOKEN_LIMIT,
  MANAGER_WINDOW_MS,
  type ManagerBudgetReason,
  type ManagerBudgetSnapshot,
  assessManagerBudget,
  managerBudgetMessage,
} from "./manager-budget-window";
import { getStore } from "./store";

type Store = ReturnType<typeof getStore>;

export type ManagerBudgetCheck =
  | { allowed: true; snapshot: ManagerBudgetSnapshot }
  | {
      allowed: false;
      snapshot: ManagerBudgetSnapshot;
      reason: ManagerBudgetReason;
      message: string;
    };

export async function loadManagerBudget(input: {
  workspaceId: string;
  sessionId: string;
  store?: Store;
  now?: Date;
}): Promise<ManagerBudgetSnapshot> {
  const store = input.store ?? getStore();
  const now = input.now ?? new Date();
  const record = await store.managerSessions.get(
    input.workspaceId,
    input.sessionId,
  );
  return assessManagerBudget(record, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    now,
  });
}

export async function checkManagerBudget(input: {
  workspaceId: string;
  sessionId: string;
  store?: Store;
  now?: Date;
}): Promise<ManagerBudgetCheck> {
  const snapshot = await loadManagerBudget(input);
  if (!snapshot.blockedReason) {
    return { allowed: true, snapshot };
  }
  return {
    allowed: false,
    snapshot,
    reason: snapshot.blockedReason,
    message: managerBudgetMessage(snapshot, snapshot.blockedReason),
  };
}

export async function recordManagerUsage(input: {
  workspaceId: string;
  sessionId: string;
  tokens: number;
  costCny: number;
  store?: Store;
  now?: Date;
}): Promise<ManagerSessionRecord> {
  const store = input.store ?? getStore();
  const now = input.now ?? new Date();
  return store.managerSessions.addUsage({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    tokens: input.tokens,
    costCny: input.costCny,
    now: now.toISOString(),
    windowMs: MANAGER_WINDOW_MS,
  });
}

export async function recordManagerRejection(input: {
  workspaceId: string;
  sessionId: string;
  runId: string;
  reason: ManagerBudgetReason;
  store?: Store;
  now?: Date;
}): Promise<void> {
  const store = input.store ?? getStore();
  const now = input.now ?? new Date();
  const record = await store.managerSessions.recordRejection({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    reason: input.reason,
    now: now.toISOString(),
    windowMs: MANAGER_WINDOW_MS,
  });

  try {
    await store.artifactService.publish({
      workspaceId: input.workspaceId,
      content: new TextEncoder().encode(
        JSON.stringify(
          {
            sessionId: input.sessionId,
            reason: input.reason,
            tokens: record.tokens,
            costCny: record.costCny,
            rejections: record.rejections,
            windowEndsAt: record.windowEndsAt,
            rejectedAt: now.toISOString(),
            limits: {
              tokens: MANAGER_TOKEN_LIMIT,
              costCny: MANAGER_COST_LIMIT_CNY,
              windowMs: MANAGER_WINDOW_MS,
            },
          },
          null,
          2,
        ),
      ),
      producer: {
        agentId: "manager",
        agentVersion: "1.0.0",
        promptHash: "sha256:manager-budget-guard",
        modelId: "none",
      },
      inputs: [],
      runId: input.runId,
      stageId: `${input.runId}:manager-budget-rejection-${newId("rej")}`,
      runMode: "DRY_RUN",
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
  } catch (error) {
    console.error("failed to publish manager budget rejection", error);
  }
}

export async function resetManagerBudget(input: {
  workspaceId: string;
  sessionId: string;
  store?: Store;
}): Promise<void> {
  const store = input.store ?? getStore();
  await store.managerSessions.reset(input.workspaceId, input.sessionId);
}
