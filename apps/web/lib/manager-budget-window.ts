import type { ManagerSessionRecord } from "@kit/store";

export const MANAGER_TOKEN_LIMIT = 16_000;
export const MANAGER_COST_LIMIT_CNY = 3;
export const MANAGER_WINDOW_MS = 180_000;

export type ManagerBudgetReason = "tokens" | "cost";

export interface ManagerBudgetSnapshot {
  workspaceId: string;
  sessionId: string;
  windowStartedAt: string;
  windowEndsAt: string;
  tokens: number;
  costCny: number;
  tokenLimit: number;
  costLimitCny: number;
  windowMs: number;
  remainingTokens: number;
  remainingCostCny: number;
  remainingMs: number;
  blockedReason: ManagerBudgetReason | null;
}

export function assessManagerBudget(
  record: ManagerSessionRecord | null,
  input: {
    workspaceId: string;
    sessionId: string;
    now: Date;
    windowMs?: number;
  },
): ManagerBudgetSnapshot {
  const windowMs = input.windowMs ?? MANAGER_WINDOW_MS;
  const nowMs = input.now.getTime();
  const active =
    record && nowMs < Date.parse(record.windowEndsAt) ? record : null;
  const tokens = active?.tokens ?? 0;
  const costCny = active?.costCny ?? 0;
  const windowEndsAt =
    active?.windowEndsAt ?? new Date(nowMs + windowMs).toISOString();
  const blockedReason =
    tokens >= MANAGER_TOKEN_LIMIT
      ? "tokens"
      : costCny >= MANAGER_COST_LIMIT_CNY
        ? "cost"
        : null;

  return {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    windowStartedAt: active?.windowStartedAt ?? input.now.toISOString(),
    windowEndsAt,
    tokens,
    costCny,
    tokenLimit: MANAGER_TOKEN_LIMIT,
    costLimitCny: MANAGER_COST_LIMIT_CNY,
    windowMs,
    remainingTokens: Math.max(0, MANAGER_TOKEN_LIMIT - tokens),
    remainingCostCny: Math.max(0, MANAGER_COST_LIMIT_CNY - costCny),
    remainingMs: Math.max(0, Date.parse(windowEndsAt) - nowMs),
    blockedReason,
  };
}

export function managerBudgetMessage(
  snapshot: ManagerBudgetSnapshot,
  reason: ManagerBudgetReason,
): string {
  const retry = Math.ceil(snapshot.remainingMs / 1000);
  const usage =
    reason === "tokens"
      ? `${snapshot.tokens}/${snapshot.tokenLimit} tokens`
      : `¥${snapshot.costCny.toFixed(2)}/¥${snapshot.costLimitCny.toFixed(2)}`;
  return `Manager session budget exhausted (${usage}). Reset the window or try again in ${retry}s.`;
}
