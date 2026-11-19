import { z } from "zod";

export const MICRO_CNY_PER_CNY = 1_000_000;

export const budgetScopeSchema = z.enum([
  "workspace",
  "month",
  "day",
  "run",
  "stage",
  "agent",
  /**
   * Independent self-evolution subject (D-38 / 70 §3.8). Evolution never draws
   * from the production workspace/month/day budgets; it has its own cap sized
   * as a share of the production month budget.
   */
  "evolution",
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

/**
 * D-38: self-evolution may spend at most this share of the production budget.
 * The production budget is the month subject; the evolution subject is derived
 * from it and capped independently (60 §3.6: evolution must not borrow from the
 * production budget without approval).
 */
export const DEFAULT_EVOLUTION_BUDGET_SHARE = 0.1;

export const EVOLUTION_BUDGET_SHARE_ENV = "KIT_EVOLUTION_BUDGET_SHARE";

export const evolutionBudgetPhaseSchema = z.enum([
  "proposal",
  "score",
  "canary",
]);

export type EvolutionBudgetPhase = z.infer<typeof evolutionBudgetPhaseSchema>;

/** Reserved purpose prefix keeps evolution charges attributable in the ledger. */
export function evolutionBudgetPurpose(phase: EvolutionBudgetPhase): string {
  return `evolution:${phase}`;
}

export function isEvolutionBudgetPurpose(purpose: string): boolean {
  return purpose.startsWith("evolution:");
}

export function loadEvolutionBudgetShare(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[EVOLUTION_BUDGET_SHARE_ENV];
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_EVOLUTION_BUDGET_SHARE;
}

/**
 * Sizes the evolution subject from the production month budget. Token limits
 * only exist when the production budget carries one, mirroring the parent.
 */
export function evolutionBudgetLimit(
  base: BudgetLimit,
  share: number,
): BudgetLimit {
  const bounded = Math.min(1, Math.max(0, share));
  const limit: BudgetLimit = {};
  if (base.cny !== undefined) {
    limit.cny = base.cny * bounded;
  }
  if (base.tokens !== undefined) {
    limit.tokens = Math.floor(base.tokens * bounded);
  }
  return limit;
}

export const EVOLUTION_BUDGET_STATUSES = [
  "admitted",
  "budget_exceeded",
  "unledgered",
] as const;

export type EvolutionBudgetStatus = (typeof EVOLUTION_BUDGET_STATUSES)[number];

export interface EvolutionBudgetAdmitInput {
  workspaceId: string;
  /** Conservative upper bound for the whole cycle (all phases). */
  estimateCnyMicro: number;
  estimateTokens?: number;
  /** Overrides KIT_EVOLUTION_BUDGET_SHARE for this call. */
  share?: number;
  policy?: BudgetPolicy;
  now?: Date;
}

export interface EvolutionBudgetAdmitResult {
  ok: boolean;
  reason: string | null;
  budgetId: string | null;
  limitCnyMicro: number | null;
  limitTokens: number | null;
  remainingCnyMicro: number | null;
  remainingTokens: number | null;
  share: number;
}

export interface EvolutionBudgetReserveInput {
  workspaceId: string;
  cycleId: string;
  phase: EvolutionBudgetPhase;
  amountCnyMicro: number;
  amountTokens: number;
  share?: number;
  policy?: BudgetPolicy;
  now?: Date;
}

export interface EvolutionBudgetReserveResult {
  ok: boolean;
  reservationId: string | null;
  budgetId: string | null;
  message: string | null;
}

export interface EvolutionBudgetCommitResult {
  ok: boolean;
  chargeId: string | null;
  overshoot: boolean;
  message?: string;
}

export interface EvolutionBudgetReconcileResult {
  chargedCnyMicro: number;
  chargedTokens: number;
  chargeIds: string[];
  reservationIds: string[];
}

/**
 * Ledger surface used by the evolution cycle. Implemented by the store's
 * `BudgetService`; tests inject a fake ledger so cycles never need a real
 * database or a real bill.
 */
export interface EvolutionBudgetLedger {
  admitEvolution(
    input: EvolutionBudgetAdmitInput,
  ): Promise<EvolutionBudgetAdmitResult>;
  reserveEvolution(
    input: EvolutionBudgetReserveInput,
  ): Promise<EvolutionBudgetReserveResult>;
  commitEvolution(
    reservationId: string,
    actual: { cnyMicro: number; tokens: number },
    now?: Date,
  ): Promise<EvolutionBudgetCommitResult>;
  /** Idempotent: returns the reservation's funds when a phase fails. */
  releaseEvolution(reservationId: string, now?: Date): Promise<void>;
  reconcileEvolution(input: {
    workspaceId: string;
    cycleId: string;
  }): Promise<EvolutionBudgetReconcileResult>;
}
