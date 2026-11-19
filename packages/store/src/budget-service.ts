import { createHash } from "node:crypto";
import {
  type BudgetLimit,
  type BudgetPolicy,
  type BudgetScope,
  type EvolutionBudgetAdmitInput,
  type EvolutionBudgetAdmitResult,
  type EvolutionBudgetCommitResult,
  type EvolutionBudgetLedger,
  type EvolutionBudgetReconcileResult,
  type EvolutionBudgetReserveInput,
  type EvolutionBudgetReserveResult,
  type RunBudgetSpec,
  cnyToMicro,
  evolutionBudgetLimit,
  evolutionBudgetPurpose,
  hasBudgetLimit,
  is80Percent,
  isEvolutionBudgetPurpose,
  loadBudgetPolicy,
  loadEvolutionBudgetShare,
  newId,
  utcDayKey,
  utcMonthKey,
  validateBudgetCascade,
} from "@kit/core";
import type { SqlClient, StoreDriverName } from "./db";
import { appendOp } from "./op-log";

export interface BudgetStore {
  sql: SqlClient;
  driver: StoreDriverName;
}

const REAP_INTERVAL_MS = 60_000;
const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface BudgetRecord {
  budgetId: string;
  workspaceId: string;
  scope: BudgetScope;
  targetKey: string;
  period: string | null;
  dayKey: string | null;
  monthKey: string | null;
  limitCnyMicro: number | null;
  limitTokens: number | null;
  spentCnyMicro: number;
  spentTokens: number;
  reservedCnyMicro: number;
  reservedTokens: number;
  hard: boolean;
  alert80Cny: boolean;
  alert80Tokens: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetChargeRecord {
  chargeId: string;
  reservationId: string;
  workspaceId: string;
  runId: string;
  stageId: string | null;
  agentId: string | null;
  purpose: string;
  costCnyMicro: number;
  tokens: number;
  createdAt: string;
}

export interface BudgetStageInput {
  stageId: string;
  stageName?: string;
  agentId?: string;
}

export interface EnsureBudgetsInput {
  workspaceId: string;
  runId: string;
  spec?: RunBudgetSpec;
  stages?: BudgetStageInput[];
  policy?: BudgetPolicy;
  now?: Date;
}

export interface EnsureBudgetsResult {
  ok: boolean;
  errors: string[];
  budgets: BudgetRecord[];
  runBudget: BudgetRecord | null;
  dayKey: string;
  monthKey: string;
}

export interface AdmitRunInput extends EnsureBudgetsInput {
  estimateCnyMicro?: number;
  estimateTokens?: number;
}

export interface AdmitRunResult extends EnsureBudgetsResult {
  estimateCnyMicro: number;
  estimateTokens: number;
  blocking: BudgetRecord | null;
  reason: string | null;
}

export interface ReserveInput {
  workspaceId: string;
  runId: string;
  stageId?: string;
  agentId?: string;
  purpose: string;
  amountCnyMicro: number;
  amountTokens: number;
  stageLimit?: BudgetLimit;
  agentLimit?: BudgetLimit;
  ttlMs?: number;
  now?: Date;
}

export type ReserveResult =
  | {
      ok: true;
      reservationId: string;
      budgets: BudgetRecord[];
    }
  | {
      ok: false;
      blocking: BudgetRecord | null;
      message: string;
    };

export interface CommitResult {
  ok: boolean;
  budgets: BudgetRecord[];
  alerts: BudgetRecord[];
  overshoot: boolean;
  /** Charge row created by this commit; absent when nothing was billed. */
  chargeId?: string;
  message?: string;
}

export interface EnsureEvolutionBudgetResult {
  ok: boolean;
  errors: string[];
  budget: BudgetRecord | null;
  share: number;
  monthKey: string;
}

export interface ListBudgetsQuery {
  workspaceId: string;
  scope?: BudgetScope;
  targetPrefix?: string;
  limit?: number;
}

export interface ListChargesQuery {
  workspaceId: string;
  runId?: string;
  limit?: number;
}

class BudgetDeniedError extends Error {
  constructor(
    readonly blocking: BudgetRecord | null,
    message: string,
  ) {
    super(message);
  }
}

interface BudgetRow {
  budget_id: string;
  workspace_id: string;
  scope: string;
  target_key: string;
  period: string | null;
  day_key: string | null;
  month_key: string | null;
  limit_cny_micro: number | string | null;
  limit_tokens: number | string | null;
  spent_cny_micro: number | string;
  spent_tokens: number | string;
  reserved_cny_micro: number | string;
  reserved_tokens: number | string;
  hard: boolean | number;
  alert80_cny: boolean | number;
  alert80_tokens: boolean | number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ReservationRow {
  reservation_id: string;
  workspace_id: string;
  run_id: string;
  stage_id: string | null;
  agent_id: string | null;
  purpose: string;
  budget_ids: string | string[];
  amount_cny_micro: number | string;
  amount_tokens: number | string;
  status: string;
  expires_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ChargeRow {
  charge_id: string;
  reservation_id: string;
  workspace_id: string;
  run_id: string;
  stage_id: string | null;
  agent_id: string | null;
  purpose: string;
  cost_cny_micro: number | string;
  tokens: number | string;
  created_at: string | Date;
}

interface BudgetTarget {
  scope: BudgetScope;
  targetKey: string;
  period: string | null;
  dayKey: string | null;
  monthKey: string | null;
  limit?: BudgetLimit;
  requiredScope: boolean;
}

export function budgetIdFor(
  workspaceId: string,
  scope: BudgetScope,
  targetKey: string,
): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}|${scope}|${targetKey}`)
    .digest("hex")
    .slice(0, 24);
  return `bdg_${digest}`;
}

export class BudgetService implements EvolutionBudgetLedger {
  private lastReapAt = 0;

  constructor(private readonly store: BudgetStore) {}

  async ensureRunBudgets(
    input: EnsureBudgetsInput,
  ): Promise<EnsureBudgetsResult> {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const dayKey = utcDayKey(now);
    const monthKey = utcMonthKey(now);
    const policy = input.policy ?? loadBudgetPolicy();
    const runLimit = input.spec?.run ?? policy.run;
    const errors = validateBudgetCascade({
      workspace: policy.workspace,
      month: policy.month,
      day: policy.day,
      run: runLimit,
      stage: input.spec?.stage ?? runLimit,
      agent: input.spec?.agent ?? runLimit,
    });
    if (!hasBudgetLimit(runLimit)) {
      errors.push("run budget must set cny or tokens");
    }

    const stageTargets = this.stageTargets(input, dayKey, monthKey);
    for (const target of stageTargets) {
      const override =
        (target.scope === "stage" && target.limit) ||
        (target.scope === "agent" && target.limit);
      if (override) {
        errors.push(
          ...validateBudgetCascade({ run: runLimit, [target.scope]: override }),
        );
      }
    }

    const targets: BudgetTarget[] = [
      {
        scope: "workspace",
        targetKey: monthKey,
        period: monthKey,
        dayKey: null,
        monthKey,
        limit: policy.workspace,
        requiredScope: true,
      },
      {
        scope: "month",
        targetKey: monthKey,
        period: monthKey,
        dayKey: null,
        monthKey,
        limit: policy.month,
        requiredScope: true,
      },
      {
        scope: "day",
        targetKey: dayKey,
        period: dayKey,
        dayKey,
        monthKey,
        limit: policy.day,
        requiredScope: true,
      },
      {
        scope: "run",
        targetKey: input.runId,
        period: null,
        dayKey,
        monthKey,
        limit: runLimit,
        requiredScope: true,
      },
      ...stageTargets,
    ];

    if (errors.length > 0) {
      return {
        ok: false,
        errors,
        budgets: [],
        runBudget: null,
        dayKey,
        monthKey,
      };
    }

    const uniqueTargets = [
      ...new Map(
        targets.map((target) => [
          `${target.scope}:${target.targetKey}`,
          target,
        ]),
      ).values(),
    ];

    await this.store.sql.begin(async (tx) => {
      for (const target of uniqueTargets) {
        await this.insertBudget(tx, {
          workspaceId: input.workspaceId,
          target,
          nowIso,
        });
      }
    });

    const budgets: BudgetRecord[] = [];
    for (const target of uniqueTargets) {
      const row = await this.selectBudgetById(
        this.store.sql,
        budgetIdFor(input.workspaceId, target.scope, target.targetKey),
      );
      if (row) {
        budgets.push(row);
      }
    }
    return {
      ok: true,
      errors: [],
      budgets,
      runBudget: budgets.find((budget) => budget.scope === "run") ?? null,
      dayKey,
      monthKey,
    };
  }

  async admitRun(input: AdmitRunInput): Promise<AdmitRunResult> {
    const ensured = await this.ensureRunBudgets(input);
    const estimateCnyMicro = input.estimateCnyMicro ?? 0;
    const estimateTokens = input.estimateTokens ?? 0;
    if (!ensured.ok) {
      return {
        ...ensured,
        estimateCnyMicro,
        estimateTokens,
        blocking: null,
        reason: ensured.errors.join("; "),
      };
    }

    const parents = ensured.budgets.filter((budget) =>
      ["workspace", "month", "day", "run"].includes(budget.scope),
    );
    for (const budget of parents) {
      if (
        budget.limitCnyMicro !== null &&
        estimateCnyMicro >
          budget.limitCnyMicro - budget.spentCnyMicro - budget.reservedCnyMicro
      ) {
        return {
          ...ensured,
          ok: false,
          estimateCnyMicro,
          estimateTokens,
          blocking: budget,
          reason: `${budget.scope} budget remaining is below the run estimate`,
        };
      }
      if (
        budget.limitTokens !== null &&
        estimateTokens >
          budget.limitTokens - budget.spentTokens - budget.reservedTokens
      ) {
        return {
          ...ensured,
          ok: false,
          estimateCnyMicro,
          estimateTokens,
          blocking: budget,
          reason: `${budget.scope} token budget remaining is below the run estimate`,
        };
      }
    }

    return {
      ...ensured,
      estimateCnyMicro,
      estimateTokens,
      blocking: null,
      reason: null,
    };
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const amountCnyMicro = Math.max(0, Math.round(input.amountCnyMicro));
    const amountTokens = Math.max(0, Math.round(input.amountTokens));
    if (amountCnyMicro === 0 && amountTokens === 0) {
      return { ok: true, reservationId: "", budgets: [] };
    }

    const now = input.now ?? new Date();
    await this.releaseExpired(now);

    const dayKey = utcDayKey(now);
    const monthKey = utcMonthKey(now);
    const policy = loadBudgetPolicy();
    const targets: BudgetTarget[] = [
      {
        scope: "workspace",
        targetKey: monthKey,
        period: monthKey,
        dayKey: null,
        monthKey,
        limit: policy.workspace,
        requiredScope: true,
      },
      {
        scope: "month",
        targetKey: monthKey,
        period: monthKey,
        dayKey: null,
        monthKey,
        limit: policy.month,
        requiredScope: true,
      },
      {
        scope: "day",
        targetKey: dayKey,
        period: dayKey,
        dayKey,
        monthKey,
        limit: policy.day,
        requiredScope: true,
      },
      {
        scope: "run",
        targetKey: input.runId,
        period: null,
        dayKey,
        monthKey,
        requiredScope: true,
      },
    ];
    if (input.stageId) {
      targets.push({
        scope: "stage",
        targetKey: stageBudgetKey(input.runId, input.stageId),
        period: null,
        dayKey,
        monthKey,
        ...(input.stageLimit ? { limit: input.stageLimit } : {}),
        requiredScope: false,
      });
    }
    if (input.agentId) {
      targets.push({
        scope: "agent",
        targetKey: agentBudgetKey(input.runId, input.agentId),
        period: null,
        dayKey,
        monthKey,
        ...(input.agentLimit ? { limit: input.agentLimit } : {}),
        requiredScope: false,
      });
    }

    return await this.reserveAgainst({
      workspaceId: input.workspaceId,
      runId: input.runId,
      purpose: input.purpose,
      amountCnyMicro,
      amountTokens,
      targets,
      now,
      ...(input.stageId === undefined ? {} : { stageId: input.stageId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    });
  }

  /**
   * Atomic reservation shared by runs and the evolution subject: every target
   * is checked and incremented inside one transaction, and the reservation row
   * plus its op-log entry are written there too.
   */
  private async reserveAgainst(input: {
    workspaceId: string;
    runId: string;
    stageId?: string;
    agentId?: string;
    purpose: string;
    amountCnyMicro: number;
    amountTokens: number;
    targets: BudgetTarget[];
    ttlMs?: number;
    now: Date;
  }): Promise<ReserveResult> {
    const nowIso = input.now.toISOString();
    const amountCnyMicro = input.amountCnyMicro;
    const amountTokens = input.amountTokens;
    const reservationId = newId("brs");
    const expiresAt = new Date(
      input.now.getTime() + (input.ttlMs ?? RESERVATION_TTL_MS),
    ).toISOString();
    let reservedIds: string[] = [];

    try {
      const budgets = await this.store.sql.begin(async (tx) => {
        const rows: Array<{ target: BudgetTarget; row: BudgetRecord }> = [];
        for (const target of input.targets) {
          const budgetId = budgetIdFor(
            input.workspaceId,
            target.scope,
            target.targetKey,
          );
          let row = await this.selectBudgetById(tx, budgetId, true);
          if (!row && target.limit) {
            // A long-running run can cross a UTC day/month boundary after
            // admission; open the new period with the current policy.
            await this.insertBudget(tx, {
              workspaceId: input.workspaceId,
              target,
              nowIso,
            });
            row = await this.selectBudgetById(tx, budgetId, true);
          }
          if (!row && !target.requiredScope) {
            // A stage/agent with no explicit limit is only bounded by its
            // parent budgets; there is nothing extra to reserve here.
            continue;
          }
          if (!row) {
            throw new BudgetDeniedError(
              null,
              `missing ${target.scope} budget (${target.targetKey}); ensure the subject was admitted`,
            );
          }
          if (
            row.limitCnyMicro !== null &&
            row.spentCnyMicro + row.reservedCnyMicro + amountCnyMicro >
              row.limitCnyMicro
          ) {
            throw new BudgetDeniedError(
              row,
              `${row.scope} budget reached: ${row.spentCnyMicro + row.reservedCnyMicro} + ${amountCnyMicro} > ${row.limitCnyMicro} micro-CNY`,
            );
          }
          if (
            row.limitTokens !== null &&
            row.spentTokens + row.reservedTokens + amountTokens >
              row.limitTokens
          ) {
            throw new BudgetDeniedError(
              row,
              `${row.scope} token budget reached: ${row.spentTokens + row.reservedTokens} + ${amountTokens} > ${row.limitTokens}`,
            );
          }
          rows.push({ target, row });
        }

        for (const { row } of rows) {
          await tx`
            UPDATE budgets
            SET reserved_cny_micro = ${row.reservedCnyMicro + amountCnyMicro},
                reserved_tokens = ${row.reservedTokens + amountTokens},
                updated_at = ${nowIso}
            WHERE budget_id = ${row.budgetId}
          `;
        }

        reservedIds = rows.map(({ row }) => row.budgetId);
        await tx`
          INSERT INTO budget_reservations (
            reservation_id, workspace_id, run_id, stage_id, agent_id, purpose,
            budget_ids, amount_cny_micro, amount_tokens, status, expires_at,
            created_at, updated_at
          ) VALUES (
            ${reservationId}, ${input.workspaceId}, ${input.runId},
            ${input.stageId ?? null}, ${input.agentId ?? null}, ${input.purpose},
            ${JSON.stringify(reservedIds)}, ${amountCnyMicro}, ${amountTokens},
            ${"reserved"}, ${expiresAt}, ${nowIso}, ${nowIso}
          )
        `;
        await appendOp(
          { sql: tx },
          {
            workspaceId: input.workspaceId,
            entityKind: "budget_reservation",
            entityId: reservationId,
            op: "budget.reserve",
            actor: "budget-service",
            origin: "system",
            idempotencyKey: `budget.reserve:${reservationId}`,
            payload: {
              runId: input.runId,
              stageId: input.stageId ?? null,
              agentId: input.agentId ?? null,
              purpose: input.purpose,
              amountCnyMicro,
              amountTokens,
              budgetIds: reservedIds,
            },
            createdAt: nowIso,
          },
        );

        return rows.map(({ row }) => ({
          ...row,
          reservedCnyMicro: row.reservedCnyMicro + amountCnyMicro,
          reservedTokens: row.reservedTokens + amountTokens,
          updatedAt: nowIso,
        }));
      });
      return { ok: true, reservationId, budgets };
    } catch (error) {
      if (error instanceof BudgetDeniedError) {
        if (isEvolutionBudgetPurpose(input.purpose)) {
          // A denied evolution reservation must leave an audit trail: the
          // cycle itself records `budget_exceeded`, and the op log keeps the
          // blocking budget so operators can reconcile it later.
          await appendOp(
            { sql: this.store.sql },
            {
              workspaceId: input.workspaceId,
              entityKind: "budget_reservation",
              entityId: reservationId,
              op: "budget.reserve.denied",
              actor: "budget-service",
              origin: "system",
              idempotencyKey: `budget.reserve.denied:${reservationId}`,
              payload: {
                runId: input.runId,
                purpose: input.purpose,
                amountCnyMicro,
                amountTokens,
                blockingBudgetId: error.blocking?.budgetId ?? null,
                blockingScope: error.blocking?.scope ?? null,
                message: error.message,
              },
              createdAt: nowIso,
            },
          ).catch(() => undefined);
        }
        return {
          ok: false,
          blocking: error.blocking,
          message: error.message,
        };
      }
      throw error;
    }
  }

  async commit(
    reservationId: string,
    actual: { cnyMicro: number; tokens: number },
    now: Date = new Date(),
  ): Promise<CommitResult> {
    if (!reservationId) {
      return { ok: true, budgets: [], alerts: [], overshoot: false };
    }
    const nowIso = now.toISOString();
    const actualCnyMicro = Math.max(0, Math.round(actual.cnyMicro));
    const actualTokens = Math.max(0, Math.round(actual.tokens));
    const reservation = await this.selectReservation(reservationId);
    if (!reservation) {
      return {
        ok: false,
        budgets: [],
        alerts: [],
        overshoot: false,
        message: `reservation not found: ${reservationId}`,
      };
    }
    if (reservation.status === "committed") {
      return { ok: true, budgets: [], alerts: [], overshoot: false };
    }
    if (reservation.status !== "reserved") {
      return {
        ok: false,
        budgets: [],
        alerts: [],
        overshoot: false,
        message: `reservation is ${reservation.status}`,
      };
    }

    const budgetIds = parseBudgetIds(reservation.budget_ids);
    const amountCnyMicro = Number(reservation.amount_cny_micro);
    const amountTokens = Number(reservation.amount_tokens);
    let overshoot =
      actualCnyMicro > amountCnyMicro || actualTokens > amountTokens;

    const result = await this.store.sql.begin(async (tx) => {
      const current = await this.selectReservationById(tx, reservationId, true);
      if (!current || current.status !== "reserved") {
        return { rows: [], alerts: [], chargeId: null as string | null };
      }
      const rows: BudgetRecord[] = [];
      const alerts: BudgetRecord[] = [];
      for (const budgetId of budgetIds) {
        const row = await this.selectBudgetById(tx, budgetId, true);
        if (!row) {
          continue;
        }
        const spentCnyMicro = row.spentCnyMicro + actualCnyMicro;
        const spentTokens = row.spentTokens + actualTokens;
        const reservedCnyMicro = Math.max(
          0,
          row.reservedCnyMicro - amountCnyMicro,
        );
        const reservedTokens = Math.max(0, row.reservedTokens - amountTokens);
        if (row.limitCnyMicro !== null && spentCnyMicro > row.limitCnyMicro) {
          overshoot = true;
        }
        if (row.limitTokens !== null && spentTokens > row.limitTokens) {
          overshoot = true;
        }
        const alert80Cny =
          row.alert80Cny ||
          (row.limitCnyMicro !== null &&
            is80Percent(spentCnyMicro, row.limitCnyMicro));
        const alert80Tokens =
          row.alert80Tokens ||
          (row.limitTokens !== null &&
            is80Percent(spentTokens, row.limitTokens));
        await tx`
          UPDATE budgets
          SET spent_cny_micro = ${spentCnyMicro},
              spent_tokens = ${spentTokens},
              reserved_cny_micro = ${reservedCnyMicro},
              reserved_tokens = ${reservedTokens},
              alert80_cny = ${alert80Cny},
              alert80_tokens = ${alert80Tokens},
              updated_at = ${nowIso}
          WHERE budget_id = ${budgetId}
        `;
        const updated: BudgetRecord = {
          ...row,
          spentCnyMicro,
          spentTokens,
          reservedCnyMicro,
          reservedTokens,
          alert80Cny,
          alert80Tokens,
          updatedAt: nowIso,
        };
        rows.push(updated);
        if (!row.alert80Cny && alert80Cny) {
          alerts.push(updated);
        }
        if (!row.alert80Tokens && alert80Tokens) {
          if (!alerts.includes(updated)) {
            alerts.push(updated);
          }
        }
      }

      await tx`
        UPDATE budget_reservations
        SET status = ${"committed"}, updated_at = ${nowIso}
        WHERE reservation_id = ${reservationId} AND status = ${"reserved"}
      `;
      const chargeId = newId("bch");
      await tx`
        INSERT INTO budget_charges (
          charge_id, reservation_id, workspace_id, run_id, stage_id, agent_id,
          purpose, cost_cny_micro, tokens, created_at
        ) VALUES (
          ${chargeId}, ${reservationId}, ${reservation.workspace_id},
          ${reservation.run_id}, ${reservation.stage_id ?? null},
          ${reservation.agent_id ?? null}, ${reservation.purpose},
          ${actualCnyMicro}, ${actualTokens}, ${nowIso}
        ) ON CONFLICT DO NOTHING
      `;
      await appendOp(
        { sql: tx },
        {
          workspaceId: reservation.workspace_id,
          entityKind: "budget_charge",
          entityId: chargeId,
          op: "budget.charge",
          actor: "budget-service",
          origin: "system",
          idempotencyKey: `budget.charge:${reservationId}`,
          payload: {
            reservationId,
            runId: reservation.run_id,
            stageId: reservation.stage_id ?? null,
            agentId: reservation.agent_id ?? null,
            purpose: reservation.purpose,
            costCnyMicro: actualCnyMicro,
            tokens: actualTokens,
            budgetIds,
          },
          createdAt: nowIso,
        },
      );
      return { rows, alerts, chargeId };
    });

    return {
      ok: true,
      budgets: result.rows,
      alerts: result.alerts,
      overshoot,
      ...(result.chargeId ? { chargeId: result.chargeId } : {}),
    };
  }

  async release(reservationId: string, now: Date = new Date()): Promise<void> {
    if (!reservationId) {
      return;
    }
    const nowIso = now.toISOString();
    const reservation = await this.selectReservation(reservationId);
    if (!reservation || reservation.status !== "reserved") {
      return;
    }
    const budgetIds = parseBudgetIds(reservation.budget_ids);
    const amountCnyMicro = Number(reservation.amount_cny_micro);
    const amountTokens = Number(reservation.amount_tokens);
    await this.store.sql.begin(async (tx) => {
      const current = await this.selectReservationById(tx, reservationId, true);
      if (!current || current.status !== "reserved") {
        return;
      }
      for (const budgetId of budgetIds) {
        const row = await this.selectBudgetById(tx, budgetId, true);
        if (!row) {
          continue;
        }
        await tx`
          UPDATE budgets
          SET reserved_cny_micro = ${Math.max(0, row.reservedCnyMicro - amountCnyMicro)},
              reserved_tokens = ${Math.max(0, row.reservedTokens - amountTokens)},
              updated_at = ${nowIso}
          WHERE budget_id = ${budgetId}
        `;
      }
      await tx`
        UPDATE budget_reservations
        SET status = ${"released"}, updated_at = ${nowIso}
        WHERE reservation_id = ${reservationId} AND status = ${"reserved"}
      `;
      await appendOp(
        { sql: tx },
        {
          workspaceId: reservation.workspace_id,
          entityKind: "budget_reservation",
          entityId: reservationId,
          op: "budget.release",
          actor: "budget-service",
          origin: "system",
          idempotencyKey: `budget.release:${reservationId}`,
          payload: {
            runId: reservation.run_id,
            stageId: reservation.stage_id ?? null,
            agentId: reservation.agent_id ?? null,
            budgetIds,
          },
          createdAt: nowIso,
        },
      );
    });
  }

  async releaseExpired(now: Date = new Date(), force = false): Promise<number> {
    const nowMs = now.getTime();
    if (!force && nowMs - this.lastReapAt < REAP_INTERVAL_MS) {
      return 0;
    }
    this.lastReapAt = nowMs;
    const rows = await this.store.sql<Array<{ reservation_id: string }>>`
      SELECT reservation_id FROM budget_reservations
      WHERE status = ${"reserved"} AND expires_at < ${now.toISOString()}
      LIMIT 50
    `;
    for (const row of rows) {
      await this.release(row.reservation_id, now);
    }
    return rows.length;
  }

  /**
   * D-38 / 70 §3.8: evolution is an independent subject capped at a share of
   * the production month budget. The row is created once per UTC month; a
   * later share change applies to the next month instead of silently raising
   * an active hard cap mid-period (operators raise it explicitly, audited).
   */
  async ensureEvolutionBudget(input: {
    workspaceId: string;
    share?: number;
    policy?: BudgetPolicy;
    now?: Date;
  }): Promise<EnsureEvolutionBudgetResult> {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const monthKey = utcMonthKey(now);
    const share = input.share ?? loadEvolutionBudgetShare();
    const policy = input.policy ?? loadBudgetPolicy();
    const limit = evolutionBudgetLimit(policy.month, share);
    const errors: string[] = [];
    if (!hasBudgetLimit(limit)) {
      errors.push(
        `evolution budget share ${share} of the production month budget leaves no hard limit`,
      );
    }
    if (errors.length > 0) {
      return { ok: false, errors, budget: null, share, monthKey };
    }
    const target: BudgetTarget = {
      scope: "evolution",
      targetKey: monthKey,
      period: monthKey,
      dayKey: null,
      monthKey,
      limit,
      requiredScope: true,
    };
    await this.insertBudget(this.store.sql, {
      workspaceId: input.workspaceId,
      target,
      nowIso,
    });
    const budget = await this.selectBudgetById(
      this.store.sql,
      budgetIdFor(input.workspaceId, "evolution", monthKey),
    );
    return budget
      ? { ok: true, errors: [], budget, share, monthKey }
      : {
          ok: false,
          errors: ["evolution budget missing after insert"],
          budget: null,
          share,
          monthKey,
        };
  }

  async admitEvolution(
    input: EvolutionBudgetAdmitInput,
  ): Promise<EvolutionBudgetAdmitResult> {
    const now = input.now ?? new Date();
    const ensured = await this.ensureEvolutionBudget({
      workspaceId: input.workspaceId,
      now,
      ...(input.share === undefined ? {} : { share: input.share }),
      ...(input.policy === undefined ? {} : { policy: input.policy }),
    });
    const estimateCnyMicro = Math.max(0, Math.round(input.estimateCnyMicro));
    const estimateTokens = Math.max(0, Math.round(input.estimateTokens ?? 0));
    const budget = ensured.budget;
    if (!ensured.ok || !budget) {
      return {
        ok: false,
        reason:
          ensured.errors.join("; ") || "evolution budget is not available",
        budgetId: null,
        limitCnyMicro: null,
        limitTokens: null,
        remainingCnyMicro: null,
        remainingTokens: null,
        share: ensured.share,
      };
    }
    const remainingCnyMicro =
      budget.limitCnyMicro === null
        ? null
        : budget.limitCnyMicro - budget.spentCnyMicro - budget.reservedCnyMicro;
    const remainingTokens =
      budget.limitTokens === null
        ? null
        : budget.limitTokens - budget.spentTokens - budget.reservedTokens;
    const base = {
      budgetId: budget.budgetId,
      limitCnyMicro: budget.limitCnyMicro,
      limitTokens: budget.limitTokens,
      remainingCnyMicro,
      remainingTokens,
      share: ensured.share,
    };
    if (remainingCnyMicro === null && remainingTokens === null) {
      return {
        ...base,
        ok: false,
        reason: "evolution budget has no hard limit",
      };
    }
    if (remainingCnyMicro !== null && estimateCnyMicro > remainingCnyMicro) {
      return {
        ...base,
        ok: false,
        reason: `evolution budget remaining ${microCny(remainingCnyMicro)} CNY is below the cycle estimate ${microCny(estimateCnyMicro)} CNY`,
      };
    }
    if (remainingTokens !== null && estimateTokens > remainingTokens) {
      return {
        ...base,
        ok: false,
        reason: `evolution token budget remaining ${remainingTokens} is below the cycle estimate ${estimateTokens}`,
      };
    }
    return { ...base, ok: true, reason: null };
  }

  async reserveEvolution(
    input: EvolutionBudgetReserveInput,
  ): Promise<EvolutionBudgetReserveResult> {
    const now = input.now ?? new Date();
    const ensured = await this.ensureEvolutionBudget({
      workspaceId: input.workspaceId,
      now,
      ...(input.share === undefined ? {} : { share: input.share }),
      ...(input.policy === undefined ? {} : { policy: input.policy }),
    });
    if (!ensured.ok || !ensured.budget) {
      return {
        ok: false,
        reservationId: null,
        budgetId: ensured.budget?.budgetId ?? null,
        message:
          ensured.errors.join("; ") || "evolution budget is not available",
      };
    }
    await this.releaseExpired(now);
    const policy = input.policy ?? loadBudgetPolicy();
    const reserved = await this.reserveAgainst({
      workspaceId: input.workspaceId,
      // The cycle id doubles as the run id so charges stay attributable and
      // can be reconciled per cycle without a synthetic run.
      runId: input.cycleId,
      purpose: evolutionBudgetPurpose(input.phase),
      amountCnyMicro: Math.max(0, Math.round(input.amountCnyMicro)),
      amountTokens: Math.max(0, Math.round(input.amountTokens)),
      targets: [
        {
          scope: "evolution",
          targetKey: ensured.monthKey,
          period: ensured.monthKey,
          dayKey: null,
          monthKey: ensured.monthKey,
          limit: evolutionBudgetLimit(policy.month, ensured.share),
          requiredScope: true,
        },
      ],
      now,
    });
    if (!reserved.ok) {
      return {
        ok: false,
        reservationId: null,
        budgetId: ensured.budget.budgetId,
        message: reserved.message,
      };
    }
    return {
      ok: true,
      reservationId: reserved.reservationId || null,
      budgetId: ensured.budget.budgetId,
      message: null,
    };
  }

  async commitEvolution(
    reservationId: string,
    actual: { cnyMicro: number; tokens: number },
    now: Date = new Date(),
  ): Promise<EvolutionBudgetCommitResult> {
    const result = await this.commit(reservationId, actual, now);
    return {
      ok: result.ok,
      chargeId: result.chargeId ?? null,
      overshoot: result.overshoot,
      ...(result.message === undefined ? {} : { message: result.message }),
    };
  }

  async releaseEvolution(
    reservationId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.release(reservationId, now);
  }

  async reconcileEvolution(input: {
    workspaceId: string;
    cycleId: string;
  }): Promise<EvolutionBudgetReconcileResult> {
    const rows = await this.store.sql<
      Array<{
        charge_id: string;
        reservation_id: string;
        cost_cny_micro: number | string;
        tokens: number | string;
      }>
    >`
      SELECT charge_id, reservation_id, cost_cny_micro, tokens
      FROM budget_charges
      WHERE workspace_id = ${input.workspaceId} AND run_id = ${input.cycleId}
      ORDER BY created_at ASC
    `;
    let chargedCnyMicro = 0;
    let chargedTokens = 0;
    for (const row of rows) {
      chargedCnyMicro += Number(row.cost_cny_micro);
      chargedTokens += Number(row.tokens);
    }
    return {
      chargedCnyMicro,
      chargedTokens,
      chargeIds: rows.map((row) => row.charge_id),
      reservationIds: rows.map((row) => row.reservation_id),
    };
  }

  async listBudgets(query: ListBudgetsQuery): Promise<BudgetRecord[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 500, 2000));
    let rows: BudgetRow[];
    if (query.scope && query.targetPrefix) {
      rows = await this.store.sql<BudgetRow[]>`
        SELECT * FROM budgets
        WHERE workspace_id = ${query.workspaceId}
          AND scope = ${query.scope}
          AND target_key LIKE ${`${query.targetPrefix}%`}
        ORDER BY scope, target_key
        LIMIT ${limit}
      `;
    } else if (query.scope) {
      rows = await this.store.sql<BudgetRow[]>`
        SELECT * FROM budgets
        WHERE workspace_id = ${query.workspaceId} AND scope = ${query.scope}
        ORDER BY scope, target_key
        LIMIT ${limit}
      `;
    } else if (query.targetPrefix) {
      rows = await this.store.sql<BudgetRow[]>`
        SELECT * FROM budgets
        WHERE workspace_id = ${query.workspaceId}
          AND target_key LIKE ${`${query.targetPrefix}%`}
        ORDER BY scope, target_key
        LIMIT ${limit}
      `;
    } else {
      rows = await this.store.sql<BudgetRow[]>`
        SELECT * FROM budgets
        WHERE workspace_id = ${query.workspaceId}
        ORDER BY scope, target_key
        LIMIT ${limit}
      `;
    }
    return rows.map(fromBudgetRow);
  }

  async getBudget(budgetId: string): Promise<BudgetRecord | null> {
    return this.selectBudgetById(this.store.sql, budgetId);
  }

  async listCharges(query: ListChargesQuery): Promise<BudgetChargeRecord[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const rows = query.runId
      ? await this.store.sql<ChargeRow[]>`
          SELECT * FROM budget_charges
          WHERE workspace_id = ${query.workspaceId} AND run_id = ${query.runId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await this.store.sql<ChargeRow[]>`
          SELECT * FROM budget_charges
          WHERE workspace_id = ${query.workspaceId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
    return rows.map((row) => ({
      chargeId: row.charge_id,
      reservationId: row.reservation_id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      stageId: row.stage_id,
      agentId: row.agent_id,
      purpose: row.purpose,
      costCnyMicro: Number(row.cost_cny_micro),
      tokens: Number(row.tokens),
      createdAt: toIso(row.created_at),
    }));
  }

  async increaseLimit(
    budgetId: string,
    delta: { cnyMicro?: number; tokens?: number },
    now: Date = new Date(),
  ): Promise<{ ok: boolean; budget?: BudgetRecord; error?: string }> {
    const nowIso = now.toISOString();
    const budget = await this.getBudget(budgetId);
    if (!budget) {
      return { ok: false, error: "budget not found" };
    }
    const addCny = Math.max(0, Math.round(delta.cnyMicro ?? 0));
    const addTokens = Math.max(0, Math.round(delta.tokens ?? 0));
    if (addCny === 0 && addTokens === 0) {
      return { ok: false, error: "increase must be positive" };
    }
    if (addCny > 0 && budget.limitCnyMicro === null) {
      return { ok: false, error: "budget has no CNY limit to increase" };
    }
    if (addTokens > 0 && budget.limitTokens === null) {
      return { ok: false, error: "budget has no token limit to increase" };
    }
    const nextCny =
      budget.limitCnyMicro === null ? null : budget.limitCnyMicro + addCny;
    const nextTokens =
      budget.limitTokens === null ? null : budget.limitTokens + addTokens;

    const parents = await this.parentBudgets(budget);
    for (const parent of parents) {
      if (
        nextCny !== null &&
        parent.limitCnyMicro !== null &&
        nextCny > parent.limitCnyMicro
      ) {
        return {
          ok: false,
          error: `${budget.scope} CNY ${microCny(nextCny)} would exceed ${parent.scope} CNY ${microCny(parent.limitCnyMicro)}; increase the ${parent.scope} budget first`,
        };
      }
      if (
        nextTokens !== null &&
        parent.limitTokens !== null &&
        nextTokens > parent.limitTokens
      ) {
        return {
          ok: false,
          error: `${budget.scope} tokens ${nextTokens} would exceed ${parent.scope} tokens ${parent.limitTokens}; increase the ${parent.scope} budget first`,
        };
      }
    }

    const alert80Cny =
      nextCny === null ? false : is80Percent(budget.spentCnyMicro, nextCny);
    const alert80Tokens =
      nextTokens === null ? false : is80Percent(budget.spentTokens, nextTokens);

    await this.store.sql`
      UPDATE budgets
      SET limit_cny_micro = ${nextCny},
          limit_tokens = ${nextTokens},
          alert80_cny = ${alert80Cny},
          alert80_tokens = ${alert80Tokens},
          updated_at = ${nowIso}
      WHERE budget_id = ${budgetId}
    `;
    const updated = await this.getBudget(budgetId);
    return updated
      ? { ok: true, budget: updated }
      : { ok: false, error: "budget not found after update" };
  }

  private stageTargets(
    input: EnsureBudgetsInput,
    dayKey: string,
    monthKey: string,
  ): BudgetTarget[] {
    const targets: BudgetTarget[] = [];
    const stageDefault = input.spec?.stage;
    const agentDefault = input.spec?.agent;
    for (const stage of input.stages ?? []) {
      const shortId = stage.stageId.startsWith(`${input.runId}:`)
        ? stage.stageId.slice(input.runId.length + 1)
        : stage.stageId;
      const stageLimit =
        input.spec?.stages?.[stage.stageId] ??
        input.spec?.stages?.[shortId] ??
        (stage.stageName ? input.spec?.stages?.[stage.stageName] : undefined) ??
        stageDefault;
      if (stageLimit) {
        targets.push({
          scope: "stage",
          targetKey: stageBudgetKey(input.runId, stage.stageId),
          period: null,
          dayKey,
          monthKey,
          limit: stageLimit,
          requiredScope: false,
        });
      }
      if (stage.agentId) {
        const agentLimit = input.spec?.agents?.[stage.agentId] ?? agentDefault;
        if (agentLimit) {
          targets.push({
            scope: "agent",
            targetKey: agentBudgetKey(input.runId, stage.agentId),
            period: null,
            dayKey,
            monthKey,
            limit: agentLimit,
            requiredScope: false,
          });
        }
      }
    }
    return targets;
  }

  private async parentBudgets(budget: BudgetRecord): Promise<BudgetRecord[]> {
    const parents: BudgetRecord[] = [];
    if (budget.scope === "stage" || budget.scope === "agent") {
      const runId = budget.targetKey.split(":")[0] ?? budget.targetKey;
      const run = await this.getBudget(
        budgetIdFor(budget.workspaceId, "run", runId),
      );
      if (run) {
        parents.push(run);
      }
      return parents;
    }
    const monthKey = budget.monthKey;
    if (
      budget.scope === "run" ||
      budget.scope === "day" ||
      budget.scope === "month"
    ) {
      if (monthKey) {
        const workspace = await this.getBudget(
          budgetIdFor(budget.workspaceId, "workspace", monthKey),
        );
        if (workspace) {
          parents.push(workspace);
        }
      }
    }
    if (budget.scope === "run" || budget.scope === "day") {
      if (monthKey) {
        const month = await this.getBudget(
          budgetIdFor(budget.workspaceId, "month", monthKey),
        );
        if (month) {
          parents.push(month);
        }
      }
    }
    if (budget.scope === "run" && budget.dayKey) {
      const day = await this.getBudget(
        budgetIdFor(budget.workspaceId, "day", budget.dayKey),
      );
      if (day) {
        parents.push(day);
      }
    }
    return parents;
  }

  private async insertBudget(
    tx: SqlClient,
    input: {
      workspaceId: string;
      target: BudgetTarget;
      nowIso: string;
    },
  ): Promise<void> {
    const { workspaceId, target, nowIso } = input;
    const limitCnyMicro =
      target.limit?.cny === undefined ? null : cnyToMicro(target.limit.cny);
    const limitTokens = target.limit?.tokens ?? null;
    await tx`
      INSERT INTO budgets (
        budget_id, workspace_id, scope, target_key, period, day_key, month_key,
        limit_cny_micro, limit_tokens, spent_cny_micro, spent_tokens,
        reserved_cny_micro, reserved_tokens, hard, alert80_cny, alert80_tokens,
        created_at, updated_at
      ) VALUES (
        ${budgetIdFor(workspaceId, target.scope, target.targetKey)},
        ${workspaceId}, ${target.scope}, ${target.targetKey}, ${target.period},
        ${target.dayKey}, ${target.monthKey}, ${limitCnyMicro}, ${limitTokens},
        0, 0, 0, 0, ${true}, ${false}, ${false}, ${nowIso}, ${nowIso}
      ) ON CONFLICT DO NOTHING
    `;
  }

  private async selectBudgetById(
    sql: SqlClient,
    budgetId: string,
    forUpdate = false,
  ): Promise<BudgetRecord | null> {
    const rows =
      forUpdate && this.store.driver === "postgres"
        ? await sql<
            BudgetRow[]
          >`SELECT * FROM budgets WHERE budget_id = ${budgetId} FOR UPDATE`
        : await sql<
            BudgetRow[]
          >`SELECT * FROM budgets WHERE budget_id = ${budgetId}`;
    const row = rows[0];
    return row ? fromBudgetRow(row) : null;
  }

  private async selectReservation(
    reservationId: string,
  ): Promise<ReservationRow | null> {
    return this.selectReservationById(this.store.sql, reservationId, false);
  }

  private async selectReservationById(
    sql: SqlClient,
    reservationId: string,
    forUpdate: boolean,
  ): Promise<ReservationRow | null> {
    const rows =
      forUpdate && this.store.driver === "postgres"
        ? await sql<
            ReservationRow[]
          >`SELECT * FROM budget_reservations WHERE reservation_id = ${reservationId} FOR UPDATE`
        : await sql<
            ReservationRow[]
          >`SELECT * FROM budget_reservations WHERE reservation_id = ${reservationId} LIMIT 1`;
    return rows[0] ?? null;
  }
}

function stageBudgetKey(runId: string, stageId: string): string {
  return stageId.startsWith(`${runId}:`) ? stageId : `${runId}:${stageId}`;
}

function agentBudgetKey(runId: string, agentId: string): string {
  return `${runId}:${agentId}`;
}

function parseBudgetIds(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function fromBudgetRow(row: BudgetRow): BudgetRecord {
  return {
    budgetId: row.budget_id,
    workspaceId: row.workspace_id,
    scope: row.scope as BudgetScope,
    targetKey: row.target_key,
    period: row.period ?? null,
    dayKey: row.day_key ?? null,
    monthKey: row.month_key ?? null,
    limitCnyMicro:
      row.limit_cny_micro === null ? null : Number(row.limit_cny_micro),
    limitTokens: row.limit_tokens === null ? null : Number(row.limit_tokens),
    spentCnyMicro: Number(row.spent_cny_micro),
    spentTokens: Number(row.spent_tokens),
    reservedCnyMicro: Number(row.reserved_cny_micro),
    reservedTokens: Number(row.reserved_tokens),
    hard: typeof row.hard === "boolean" ? row.hard : Number(row.hard) === 1,
    alert80Cny:
      typeof row.alert80_cny === "boolean"
        ? row.alert80_cny
        : Number(row.alert80_cny) === 1,
    alert80Tokens:
      typeof row.alert80_tokens === "boolean"
        ? row.alert80_tokens
        : Number(row.alert80_tokens) === 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function microCny(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
