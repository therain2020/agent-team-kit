import { z } from "zod";

export const MICRO_CNY_PER_CNY = 1_000_000;

export const budgetScopeSchema = z.enum([
  "workspace",
  "month",
  "day",
  "run",
  "stage",
  "agent",
]);

export type BudgetScope = z.infer<typeof budgetScopeSchema>;

export const budgetLimitSchema = z.object({
  cny: z.number().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
});

export type BudgetLimit = z.infer<typeof budgetLimitSchema>;

export const runBudgetSpecSchema = z.object({
  run: budgetLimitSchema.optional(),
  stage: budgetLimitSchema.optional(),
  agent: budgetLimitSchema.optional(),
  stages: z.record(z.string(), budgetLimitSchema).optional(),
  agents: z.record(z.string(), budgetLimitSchema).optional(),
});

export type RunBudgetSpec = z.infer<typeof runBudgetSpecSchema>;

export const DEFAULT_BUDGETS = {
  runCny: 5,
  dayCny: 30,
  monthCny: 200,
} as const;

export interface BudgetPolicy {
  run: BudgetLimit;
  day: BudgetLimit;
  month: BudgetLimit;
  workspace: BudgetLimit;
}

export interface BudgetCascadeLimits {
  workspace?: BudgetLimit;
  month?: BudgetLimit;
  day?: BudgetLimit;
  run?: BudgetLimit;
  stage?: BudgetLimit;
  agent?: BudgetLimit;
}

export function cnyToMicro(cny: number): number {
  return Math.round(cny * MICRO_CNY_PER_CNY);
}

export function microToCny(micro: number): number {
  return Math.round(micro) / MICRO_CNY_PER_CNY;
}

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function utcMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function is80Percent(
  spent: number,
  limit: number | null | undefined,
): boolean {
  if (typeof limit !== "number" || limit <= 0) {
    return false;
  }
  return spent * 5 >= limit * 4;
}

export function loadBudgetPolicy(
  env: Record<string, string | undefined> = process.env,
): BudgetPolicy {
  const cny = (name: string, fallback: number): number => {
    const raw = env[name];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const tokens = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : undefined;
  };

  const runCny = cny("KIT_BUDGET_RUN_CNY", DEFAULT_BUDGETS.runCny);
  const dayCny = cny("KIT_BUDGET_DAY_CNY", DEFAULT_BUDGETS.dayCny);
  const monthCny = cny("KIT_BUDGET_MONTH_CNY", DEFAULT_BUDGETS.monthCny);
  const workspaceCny = cny("KIT_BUDGET_WORKSPACE_CNY", monthCny);

  const runTokens = tokens("KIT_BUDGET_RUN_TOKENS");
  const dayTokens = tokens("KIT_BUDGET_DAY_TOKENS");
  const monthTokens = tokens("KIT_BUDGET_MONTH_TOKENS");
  const workspaceTokens = tokens("KIT_BUDGET_WORKSPACE_TOKENS");

  return {
    run: {
      cny: runCny,
      ...(runTokens !== undefined ? { tokens: runTokens } : {}),
    },
    day: {
      cny: dayCny,
      ...(dayTokens !== undefined ? { tokens: dayTokens } : {}),
    },
    month: {
      cny: monthCny,
      ...(monthTokens !== undefined ? { tokens: monthTokens } : {}),
    },
    workspace: {
      cny: workspaceCny,
      ...(workspaceTokens !== undefined ? { tokens: workspaceTokens } : {}),
    },
  };
}

export function validateBudgetCascade(limits: BudgetCascadeLimits): string[] {
  const errors: string[] = [];
  const check = (
    childName: string,
    child: BudgetLimit | undefined,
    parentName: string,
    parent: BudgetLimit | undefined,
  ): void => {
    if (!child || !parent) {
      return;
    }
    if (
      child.cny !== undefined &&
      parent.cny !== undefined &&
      child.cny > parent.cny
    ) {
      errors.push(
        `${childName} CNY ${child.cny} exceeds ${parentName} CNY ${parent.cny}`,
      );
    }
    if (
      child.tokens !== undefined &&
      parent.tokens !== undefined &&
      child.tokens > parent.tokens
    ) {
      errors.push(
        `${childName} tokens ${child.tokens} exceeds ${parentName} tokens ${parent.tokens}`,
      );
    }
  };

  check("month", limits.month, "workspace", limits.workspace);
  check("day", limits.day, "month", limits.month);
  check("run", limits.run, "day", limits.day);
  check("stage", limits.stage, "run", limits.run);
  check("agent", limits.agent, "run", limits.run);
  return errors;
}

export function hasBudgetLimit(limit: BudgetLimit | undefined): boolean {
  return (
    (limit?.cny !== undefined && limit.cny > 0) ||
    (limit?.tokens !== undefined && limit.tokens > 0)
  );
}
