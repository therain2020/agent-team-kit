import { microToCny } from "@kit/core";
import type { BudgetChargeRecord, BudgetRecord } from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

const SCOPE_ORDER = [
  "workspace",
  "month",
  "day",
  "run",
  "stage",
  "agent",
] as const;

export interface BudgetView {
  budgetId: string;
  scope: string;
  targetKey: string;
  period: string | null;
  limitCny: number | null;
  spentCny: number;
  reservedCny: number;
  usedCny: number;
  remainingCny: number | null;
  limitTokens: number | null;
  spentTokens: number;
  reservedTokens: number;
  usedTokens: number;
  percent: number | null;
  alert: boolean;
  exceeded: boolean;
  updatedAt: string;
}

export interface BudgetChargeView {
  chargeId: string;
  runId: string;
  stageId: string | null;
  agentId: string | null;
  purpose: string;
  costCny: number;
  tokens: number;
  createdAt: string;
}

export interface BudgetOverview {
  workspaceId: string;
  budgets: BudgetView[];
  charges: BudgetChargeView[];
}

export function toBudgetView(budget: BudgetRecord): BudgetView {
  const usedCny = budget.spentCnyMicro + budget.reservedCnyMicro;
  const usedTokens = budget.spentTokens + budget.reservedTokens;
  const percent =
    budget.limitCnyMicro !== null && budget.limitCnyMicro > 0
      ? Math.round((usedCny / budget.limitCnyMicro) * 1000) / 10
      : budget.limitTokens !== null && budget.limitTokens > 0
        ? Math.round((usedTokens / budget.limitTokens) * 1000) / 10
        : null;
  return {
    budgetId: budget.budgetId,
    scope: budget.scope,
    targetKey: budget.targetKey,
    period: budget.period,
    limitCny:
      budget.limitCnyMicro === null ? null : microToCny(budget.limitCnyMicro),
    spentCny: microToCny(budget.spentCnyMicro),
    reservedCny: microToCny(budget.reservedCnyMicro),
    usedCny: microToCny(usedCny),
    remainingCny:
      budget.limitCnyMicro === null
        ? null
        : microToCny(Math.max(0, budget.limitCnyMicro - usedCny)),
    limitTokens: budget.limitTokens,
    spentTokens: budget.spentTokens,
    reservedTokens: budget.reservedTokens,
    usedTokens,
    percent,
    alert: percent !== null && percent >= 80,
    exceeded:
      (budget.limitCnyMicro !== null && usedCny >= budget.limitCnyMicro) ||
      (budget.limitTokens !== null && usedTokens >= budget.limitTokens),
    updatedAt: budget.updatedAt,
  };
}

export async function loadBudgetOverview(
  workspaceId = "default",
): Promise<BudgetOverview> {
  await ensureStoreSchema();
  const store = getStore();
  const [budgets, charges] = await Promise.all([
    store.budgetService.listBudgets({ workspaceId, limit: 500 }),
    store.budgetService.listCharges({ workspaceId, limit: 40 }),
  ]);
  return {
    workspaceId,
    budgets: budgets.map(toBudgetView).sort((a, b) => {
      const rank =
        SCOPE_ORDER.indexOf(a.scope as (typeof SCOPE_ORDER)[number]) -
        SCOPE_ORDER.indexOf(b.scope as (typeof SCOPE_ORDER)[number]);
      return rank !== 0 ? rank : a.targetKey.localeCompare(b.targetKey);
    }),
    charges: charges.map((charge) => toChargeView(charge)),
  };
}

function toChargeView(charge: BudgetChargeRecord): BudgetChargeView {
  return {
    chargeId: charge.chargeId,
    runId: charge.runId,
    stageId: charge.stageId,
    agentId: charge.agentId,
    purpose: charge.purpose,
    costCny: microToCny(charge.costCnyMicro),
    tokens: charge.tokens,
    createdAt: charge.createdAt,
  };
}
