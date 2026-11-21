import { createHash } from "node:crypto";
import type { BudgetStore } from "./budget-service";

/**
 * Structurally compatible with `@kit/model`'s price table; declared locally so
 * the store does not depend on the model gateway package.
 */
export interface PriceTableSnapshot {
  version: string;
  effectiveAt: string;
  entries: Array<{
    modelId: string;
    provider: string;
    currency: string;
    inputPer1k: number;
    outputPer1k: number;
    effectiveAt: string;
  }>;
}

/**
 * Per-call cost attribution (60 §2/§3.3, D-12). One row per charged model,
 * tool or coder call, stamped with the price-table version and unit prices it
 * was priced at. `tracked=false` rows are explicit "we could not price this"
 * markers, never silent zeros.
 */
export interface CostRecordInput {
  workspaceId: string;
  /** Real run id, or a namespaced `kind:id` key for non-run calls. */
  runId: string;
  /** `run` (default), `job`, `evolution` or `manager`. */
  scopeKind?: string;
  /** Id of the aggregate object the call belongs to. */
  scopeId?: string | null;
  jobId?: string | null;
  changeId?: string | null;
  managerSessionId?: string | null;
  stageId?: string | null;
  agentId?: string | null;
  /** `model`, `tool:<name>`, `coder`, `compose:*`, `evolution:*`, `manager`. */
  source: string;
  artifactId?: string | null;
  modelId: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  /** Micro-CNY per 1,000 tokens. */
  unitPriceInMicro: number;
  unitPriceOutMicro: number;
  priceVersion: string;
  currency?: "CNY";
  costCnyMicro: number;
  tracked: boolean;
  untrackedReason?: string | null;
  /** Stable idempotency key for the charged call. */
  callId: string;
  ts?: Date | string;
}

export interface CostRecord {
  recordId: string;
  callId: string;
  workspaceId: string;
  runId: string;
  scopeKind: string;
  scopeId: string | null;
  jobId: string | null;
  changeId: string | null;
  managerSessionId: string | null;
  stageId: string | null;
  agentId: string | null;
  source: string;
  artifactId: string | null;
  modelId: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  unitPriceInMicro: number;
  unitPriceOutMicro: number;
  priceVersion: string;
  currency: string;
  costCnyMicro: number;
  tracked: boolean;
  untrackedReason: string | null;
  dayKey: string;
  ts: string;
  createdAt: string;
}

export interface ListCostRecordsQuery {
  workspaceId: string;
  runId?: string;
  stageId?: string;
  artifactId?: string;
  since?: Date | string;
  until?: Date | string;
  limit?: number;
}

export interface DailyCostRow {
  dayKey: string;
  costCnyMicro: number;
  trackedCalls: number;
  untrackedCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ArtifactCostRow {
  artifactId: string;
  runId: string;
  stageId: string | null;
  costCnyMicro: number;
  tokensIn: number;
  tokensOut: number;
  calls: number;
}

export interface ArtifactCostReport {
  artifacts: ArtifactCostRow[];
  totalCostCnyMicro: number;
  artifactCount: number;
  /** Mean cost per produced artifact version in the window. */
  averageUnitCostCnyMicro: number;
}

export interface ScopeCostRow {
  scopeKind: string;
  scopeId: string | null;
  costCnyMicro: number;
  calls: number;
  trackedCalls: number;
  untrackedCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ScopeCostQuery {
  workspaceId: string;
  since: Date | string;
  until: Date | string;
  /** Restrict to one scope kind, e.g. `job`. */
  scopeKind?: string;
  /** Ops view: omit run-scoped calls to show non-run cost sources only. */
  excludeRun?: boolean;
  limit?: number;
}

export interface CostAnomaly {
  dayKey: string;
  costCnyMicro: number;
  baselineMeanCnyMicro: number;
  baselineStdDevCnyMicro: number;
  /** Standard deviations above the baseline mean. */
  zScore: number;
  baselineDays: number;
}

export interface ProviderBillInput {
  workspaceId: string;
  provider: string;
  /** Inclusive ISO date (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  amountCnyMicro: number;
  /** Import provenance, e.g. the fixture or statement file name. */
  source: string;
  importedAt?: Date | string;
}

export interface ProviderBill {
  billId: string;
  workspaceId: string;
  provider: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  amountCnyMicro: number;
  source: string;
  importedAt: string;
}

export interface ReconcileQuery {
  workspaceId: string;
  since: Date | string;
  until: Date | string;
  provider?: string;
}

export interface ReconcileRow {
  provider: string;
  ledgerCnyMicro: number;
  billedCnyMicro: number;
  diffCnyMicro: number;
  /** |diff| / billed; 0 when the bill is zero. */
  diffRatio: number;
  ok: boolean;
}

export interface ReconcileReport {
  rows: ReconcileRow[];
  ledgerCnyMicro: number;
  billedCnyMicro: number;
  diffCnyMicro: number;
  diffRatio: number;
  /** 60 §5: reconciliation error must stay under 2%. */
  ok: boolean;
  untrackedCalls: number;
}

export const RECONCILE_TOLERANCE = 0.02;

interface CostRecordDbRow {
  record_id: string;
  call_id: string;
  workspace_id: string;
  run_id: string;
  scope_kind: string | null;
  scope_id: string | null;
  job_id: string | null;
  change_id: string | null;
  manager_session_id: string | null;
  stage_id: string | null;
  agent_id: string | null;
  source: string;
  artifact_id: string | null;
  model_id: string;
  provider: string;
  tokens_in: number | string;
  tokens_out: number | string;
  unit_price_in_micro: number | string;
  unit_price_out_micro: number | string;
  price_version: string;
  currency: string;
  cost_cny_micro: number | string;
  tracked: boolean | number;
  untracked_reason: string | null;
  day_key: string;
  ts: string | Date;
  created_at: string | Date;
}

interface BillDbRow {
  bill_id: string;
  workspace_id: string;
  provider: string;
  period_start: string;
  period_end: string;
  currency: string;
  amount_cny_micro: number | string;
  source: string;
  imported_at: string | Date;
}

export function costRecordId(workspaceId: string, callId: string): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}|${callId}`)
    .digest("hex")
    .slice(0, 24);
  return `cst_${digest}`;
}

export class CostLedger {
  constructor(private readonly store: BudgetStore) {}

  /**
   * Append one charged call. Idempotent on `(workspaceId, callId)` so a
   * replayed activity cannot double-bill. Untracked records must carry zero
   * cost — an unknown price never becomes a silent charge.
   */
  async record(input: CostRecordInput): Promise<CostRecord> {
    const tokensIn = Math.max(0, Math.round(input.tokensIn));
    const tokensOut = Math.max(0, Math.round(input.tokensOut));
    const costCnyMicro = Math.max(0, Math.round(input.costCnyMicro));
    if (!input.tracked && costCnyMicro !== 0) {
      throw new Error(
        `untracked cost record ${input.callId} must have zero cost, got ${costCnyMicro} micro-CNY`,
      );
    }
    const ts = toIso(input.ts ?? new Date());
    const recordId = costRecordId(input.workspaceId, input.callId);
    const dayKey = ts.slice(0, 10);
    const scopeKind = input.scopeKind ?? "run";
    // Run-scoped rows keep scope_id in sync with the run id; older rows were
    // backfilled the same way, so scope filters stay complete.
    const scopeId = input.scopeId ?? (scopeKind === "run" ? input.runId : null);
    await this.store.sql`
      INSERT INTO cost_records (
        record_id, call_id, workspace_id, run_id, scope_kind, scope_id,
        job_id, change_id, manager_session_id, stage_id, agent_id, source,
        artifact_id, model_id, provider, tokens_in, tokens_out,
        unit_price_in_micro, unit_price_out_micro, price_version, currency,
        cost_cny_micro, tracked, untracked_reason, day_key, ts, created_at
      ) VALUES (
        ${recordId}, ${input.callId}, ${input.workspaceId}, ${input.runId},
        ${scopeKind}, ${scopeId}, ${input.jobId ?? null},
        ${input.changeId ?? null}, ${input.managerSessionId ?? null},
        ${input.stageId ?? null}, ${input.agentId ?? null}, ${input.source},
        ${input.artifactId ?? null}, ${input.modelId}, ${input.provider},
        ${tokensIn}, ${tokensOut}, ${Math.max(0, Math.round(input.unitPriceInMicro))},
        ${Math.max(0, Math.round(input.unitPriceOutMicro))}, ${input.priceVersion},
        ${input.currency ?? "CNY"}, ${costCnyMicro}, ${input.tracked},
        ${input.untrackedReason ?? null}, ${dayKey}, ${ts}, ${ts}
      ) ON CONFLICT DO NOTHING
    `;
    // Either this insert won or an identical callId already landed; both
    // paths return the persisted row, so replays never double-bill.
    const stored = await this.selectRecord(recordId);
    if (!stored) {
      throw new Error(`cost record vanished after insert: ${recordId}`);
    }
    return stored;
  }

  /**
   * Link every still-unlinked record of a stage to the artifact that stage
   * published, giving the artifact ↔ cost associations in both directions.
   */
  async attachArtifact(input: {
    workspaceId: string;
    runId: string;
    stageId: string;
    artifactId: string;
  }): Promise<number> {
    const rows = await this.store.sql<Array<{ record_id: string }>>`
      UPDATE cost_records
      SET artifact_id = ${input.artifactId}
      WHERE workspace_id = ${input.workspaceId}
        AND run_id = ${input.runId}
        AND stage_id = ${input.stageId}
        AND artifact_id IS NULL
      RETURNING record_id
    `;
    return rows.length;
  }

  async listRecords(query: ListCostRecordsQuery): Promise<CostRecord[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 200, 2000));
    const since = toIso(query.since ?? new Date(0));
    const until = toIso(query.until ?? new Date("9999-12-31T23:59:59.999Z"));
    // The shared SqlClient cannot nest tagged fragments on Postgres, so the
    // filter combinations are spelled out like the other store queries.
    let rows: CostRecordDbRow[];
    if (query.artifactId) {
      rows = await this.store.sql<CostRecordDbRow[]>`
        SELECT * FROM cost_records
        WHERE workspace_id = ${query.workspaceId}
          AND artifact_id = ${query.artifactId}
          AND ts >= ${since} AND ts < ${until}
        ORDER BY ts DESC LIMIT ${limit}
      `;
    } else if (query.stageId && !query.runId) {
      rows = await this.store.sql<CostRecordDbRow[]>`
        SELECT * FROM cost_records
        WHERE workspace_id = ${query.workspaceId}
          AND stage_id = ${query.stageId}
          AND ts >= ${since} AND ts < ${until}
        ORDER BY ts DESC LIMIT ${limit}
      `;
    } else if (query.runId && query.stageId) {
      rows = await this.store.sql<CostRecordDbRow[]>`
        SELECT * FROM cost_records
        WHERE workspace_id = ${query.workspaceId}
          AND run_id = ${query.runId}
          AND stage_id = ${query.stageId}
          AND ts >= ${since} AND ts < ${until}
        ORDER BY ts DESC LIMIT ${limit}
      `;
    } else if (query.runId) {
      rows = await this.store.sql<CostRecordDbRow[]>`
        SELECT * FROM cost_records
        WHERE workspace_id = ${query.workspaceId}
          AND run_id = ${query.runId}
          AND ts >= ${since} AND ts < ${until}
        ORDER BY ts DESC LIMIT ${limit}
      `;
    } else {
      rows = await this.store.sql<CostRecordDbRow[]>`
        SELECT * FROM cost_records
        WHERE workspace_id = ${query.workspaceId}
          AND ts >= ${since} AND ts < ${until}
        ORDER BY ts DESC LIMIT ${limit}
      `;
    }
    return rows.map(fromCostRow);
  }

  /** Every record attributed to one aggregate object, newest first. */
  async listByScope(query: {
    workspaceId: string;
    scopeKind: string;
    scopeId: string;
    since?: Date | string;
    until?: Date | string;
    limit?: number;
  }): Promise<CostRecord[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 200, 2000));
    const since = toIso(query.since ?? new Date(0));
    const until = toIso(query.until ?? new Date("9999-12-31T23:59:59.999Z"));
    const rows = await this.store.sql<CostRecordDbRow[]>`
      SELECT * FROM cost_records
      WHERE workspace_id = ${query.workspaceId}
        AND scope_kind = ${query.scopeKind}
        AND scope_id = ${query.scopeId}
        AND ts >= ${since} AND ts < ${until}
      ORDER BY ts DESC LIMIT ${limit}
    `;
    return rows.map(fromCostRow);
  }

  /**
   * Spend grouped by the aggregate a call belongs to. `excludeRun` powers the
   * ops view's non-run cost sources (compose drafts, evolution cycles and
   * manager replies), which never appear under a run.
   */
  async scopeCost(query: ScopeCostQuery): Promise<ScopeCostRow[]> {
    const sinceDay = toIso(query.since).slice(0, 10);
    const untilDay = toIso(query.until).slice(0, 10);
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const scopeKind = query.scopeKind?.trim() || null;
    const rows = await this.store.sql<
      Array<{
        scope_kind: string;
        scope_id: string | null;
        cost_cny_micro: number | string;
        calls: number | string;
        tracked_calls: number | string;
        untracked_calls: number | string;
        tokens_in: number | string;
        tokens_out: number | string;
      }>
    >`
      SELECT
        scope_kind,
        scope_id,
        SUM(CASE WHEN tracked THEN cost_cny_micro ELSE 0 END) AS cost_cny_micro,
        COUNT(*) AS calls,
        SUM(CASE WHEN tracked THEN 1 ELSE 0 END) AS tracked_calls,
        SUM(CASE WHEN tracked THEN 0 ELSE 1 END) AS untracked_calls,
        SUM(tokens_in) AS tokens_in,
        SUM(tokens_out) AS tokens_out
      FROM cost_records
      WHERE workspace_id = ${query.workspaceId}
        AND day_key >= ${sinceDay}
        AND day_key <= ${untilDay}
        AND (CAST(${scopeKind} AS TEXT) IS NULL OR scope_kind = ${scopeKind})
        AND (${query.excludeRun === true ? 1 : 0} = 0 OR scope_kind <> 'run')
      GROUP BY scope_kind, scope_id
      ORDER BY cost_cny_micro DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      costCnyMicro: Number(row.cost_cny_micro),
      calls: Number(row.calls),
      trackedCalls: Number(row.tracked_calls),
      untrackedCalls: Number(row.untracked_calls),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
    }));
  }

  /** Daily spend in UTC days, split into tracked spend and untracked calls. */
  async dailyCost(query: {
    workspaceId: string;
    since: Date | string;
    until: Date | string;
  }): Promise<DailyCostRow[]> {
    const since = toIso(query.since).slice(0, 10);
    const until = toIso(query.until).slice(0, 10);
    const rows = await this.store.sql<
      Array<{
        day_key: string;
        cost_cny_micro: number | string;
        tracked_calls: number | string;
        untracked_calls: number | string;
        tokens_in: number | string;
        tokens_out: number | string;
      }>
    >`
      SELECT
        day_key,
        SUM(CASE WHEN tracked THEN cost_cny_micro ELSE 0 END) AS cost_cny_micro,
        SUM(CASE WHEN tracked THEN 1 ELSE 0 END) AS tracked_calls,
        SUM(CASE WHEN tracked THEN 0 ELSE 1 END) AS untracked_calls,
        SUM(tokens_in) AS tokens_in,
        SUM(tokens_out) AS tokens_out
      FROM cost_records
      WHERE workspace_id = ${query.workspaceId}
        AND day_key >= ${since}
        AND day_key <= ${until}
      GROUP BY day_key
      ORDER BY day_key
    `;
    return rows.map((row) => ({
      dayKey: row.day_key,
      costCnyMicro: Number(row.cost_cny_micro),
      trackedCalls: Number(row.tracked_calls),
      untrackedCalls: Number(row.untracked_calls),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
    }));
  }

  /**
   * Per-artifact cost and the mean unit cost across artifacts produced in the
   * window (60 §5: unit artifact cost has a baseline).
   */
  async artifactUnitCost(query: {
    workspaceId: string;
    since: Date | string;
    until: Date | string;
    limit?: number;
  }): Promise<ArtifactCostReport> {
    const since = toIso(query.since);
    const until = toIso(query.until);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
    const rows = await this.store.sql<
      Array<{
        artifact_id: string;
        run_id: string;
        stage_id: string | null;
        cost_cny_micro: number | string;
        tokens_in: number | string;
        tokens_out: number | string;
        calls: number | string;
      }>
    >`
      SELECT
        artifact_id, run_id, MAX(stage_id) AS stage_id,
        SUM(CASE WHEN tracked THEN cost_cny_micro ELSE 0 END) AS cost_cny_micro,
        SUM(tokens_in) AS tokens_in,
        SUM(tokens_out) AS tokens_out,
        COUNT(*) AS calls
      FROM cost_records
      WHERE workspace_id = ${query.workspaceId}
        AND artifact_id IS NOT NULL
        AND ts >= ${since}
        AND ts < ${until}
      GROUP BY artifact_id, run_id
      ORDER BY cost_cny_micro DESC
      LIMIT ${limit}
    `;
    const totals = await this.store.sql<
      Array<{
        total_cost: number | string;
        artifact_count: number | string;
      }>
    >`
      SELECT
        COALESCE(SUM(CASE WHEN tracked THEN cost_cny_micro ELSE 0 END), 0) AS total_cost,
        COUNT(DISTINCT artifact_id) AS artifact_count
      FROM cost_records
      WHERE workspace_id = ${query.workspaceId}
        AND artifact_id IS NOT NULL
        AND ts >= ${since}
        AND ts < ${until}
    `;
    const totalCostCnyMicro = Number(totals[0]?.total_cost ?? 0);
    const artifactCount = Number(totals[0]?.artifact_count ?? 0);
    return {
      artifacts: rows.map((row) => ({
        artifactId: row.artifact_id,
        runId: row.run_id,
        stageId: row.stage_id,
        costCnyMicro: Number(row.cost_cny_micro),
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        calls: Number(row.calls),
      })),
      totalCostCnyMicro,
      artifactCount,
      averageUnitCostCnyMicro:
        artifactCount > 0 ? Math.round(totalCostCnyMicro / artifactCount) : 0,
    };
  }

  /**
   * Days whose spend is `zThreshold` or more standard deviations above the
   * mean of the preceding `baselineDays`. Days without a baseline (too few
   * prior days, zero variance) are reported as normal, not as anomalies.
   */
  async anomalies(query: {
    workspaceId: string;
    until: Date | string;
    baselineDays?: number;
    zThreshold?: number;
  }): Promise<CostAnomaly[]> {
    const baselineDays = Math.max(3, Math.min(query.baselineDays ?? 14, 90));
    const zThreshold = query.zThreshold ?? 3;
    const until = new Date(toIso(query.until));
    const since = new Date(
      until.getTime() - baselineDays * 24 * 60 * 60 * 1000,
    );
    const series = await this.dailyCost({
      workspaceId: query.workspaceId,
      since,
      until,
    });
    const byDay = new Map(series.map((row) => [row.dayKey, row]));
    const anomalies: CostAnomaly[] = [];
    const days = Array.from(byDay.keys()).sort();
    for (let index = 0; index < days.length; index += 1) {
      const dayKey = days[index];
      if (!dayKey) {
        continue;
      }
      const prior = days
        .slice(0, index)
        .map((key) => byDay.get(key)?.costCnyMicro ?? 0)
        .filter((value) => value > 0);
      if (prior.length < 3) {
        continue;
      }
      const mean = prior.reduce((sum, value) => sum + value, 0) / prior.length;
      const variance =
        prior.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        prior.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev === 0) {
        continue;
      }
      const cost = byDay.get(dayKey)?.costCnyMicro ?? 0;
      const zScore = (cost - mean) / stdDev;
      if (zScore >= zThreshold) {
        anomalies.push({
          dayKey,
          costCnyMicro: cost,
          baselineMeanCnyMicro: Math.round(mean),
          baselineStdDevCnyMicro: Math.round(stdDev),
          zScore: Math.round(zScore * 100) / 100,
          baselineDays: prior.length,
        });
      }
    }
    return anomalies;
  }

  async registerPriceTable(
    table: PriceTableSnapshot,
    now: Date = new Date(),
  ): Promise<void> {
    await this.store.sql`
      INSERT INTO price_tables (
        version, effective_at, currency, entries, updated_at
      ) VALUES (
        ${table.version}, ${toIso(table.effectiveAt)}, ${"CNY"},
        ${JSON.stringify(table.entries)}, ${now.toISOString()}
      ) ON CONFLICT (version) DO UPDATE SET
        effective_at = EXCLUDED.effective_at,
        entries = EXCLUDED.entries,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async getPriceTable(version: string): Promise<PriceTableSnapshot | null> {
    const rows = await this.store.sql<
      Array<{ version: string; effective_at: string; entries: string }>
    >`
      SELECT version, effective_at, entries
      FROM price_tables
      WHERE version = ${version}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      version: row.version,
      effectiveAt: toIso(row.effective_at),
      entries: parsePriceEntries(row.entries),
    };
  }

  /** Every registered price version, oldest effective date first. */
  async listPriceTables(): Promise<PriceTableSnapshot[]> {
    const rows = await this.store.sql<
      Array<{ version: string; effective_at: string; entries: string }>
    >`
      SELECT version, effective_at, entries
      FROM price_tables
      ORDER BY effective_at ASC, version ASC
    `;
    return rows.map((row) => ({
      version: row.version,
      effectiveAt: toIso(row.effective_at),
      entries: parsePriceEntries(row.entries),
    }));
  }

  /** Import a provider statement; idempotent on its identity tuple. */
  async importProviderBill(input: ProviderBillInput): Promise<ProviderBill> {
    const importedAt = toIso(input.importedAt ?? new Date());
    const billId = billIdFor(input);
    await this.store.sql`
      INSERT INTO provider_bills (
        bill_id, workspace_id, provider, period_start, period_end, currency,
        amount_cny_micro, source, imported_at
      ) VALUES (
        ${billId}, ${input.workspaceId}, ${input.provider}, ${input.periodStart},
        ${input.periodEnd}, ${"CNY"}, ${Math.max(0, Math.round(input.amountCnyMicro))},
        ${input.source}, ${importedAt}
      ) ON CONFLICT DO NOTHING
    `;
    return {
      billId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      currency: "CNY",
      amountCnyMicro: Math.max(0, Math.round(input.amountCnyMicro)),
      source: input.source,
      importedAt,
    };
  }

  async listProviderBills(query: {
    workspaceId: string;
    limit?: number;
  }): Promise<ProviderBill[]> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500));
    const rows = await this.store.sql<BillDbRow[]>`
      SELECT * FROM provider_bills
      WHERE workspace_id = ${query.workspaceId}
      ORDER BY period_start DESC, provider
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      billId: row.bill_id,
      workspaceId: row.workspace_id,
      provider: row.provider,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      currency: row.currency,
      amountCnyMicro: Number(row.amount_cny_micro),
      source: row.source,
      importedAt: toIso(row.imported_at),
    }));
  }

  /**
   * Ledger versus imported provider bills for the window. Window bounds are
   * ISO dates (inclusive) matched against `day_key`; bills are included when
   * their period overlaps the window. Untracked calls are reported but never
   * counted as spend.
   */
  async reconcile(query: ReconcileQuery): Promise<ReconcileReport> {
    const sinceDay = toIso(query.since).slice(0, 10);
    const untilDay = toIso(query.until).slice(0, 10);
    const ledgerRows = query.provider
      ? await this.store.sql<
          Array<{
            provider: string;
            cost: number | string;
            untracked: number | string;
          }>
        >`
          SELECT
            provider,
            SUM(CASE WHEN tracked THEN cost_cny_micro ELSE 0 END) AS cost,
            SUM(CASE WHEN tracked THEN 0 ELSE 1 END) AS untracked
          FROM cost_records
          WHERE workspace_id = ${query.workspaceId}
            AND day_key >= ${sinceDay}
            AND day_key <= ${untilDay}
            AND provider = ${query.provider}
          GROUP BY provider
        `
      : await this.store.sql<
          Array<{
            provider: string;
            cost: number | string;
            untracked: number | string;
          }>
        >`
          SELECT
            provider,
            SUM(CASE WHEN tracked THEN cost_cny_micro ELSE 0 END) AS cost,
            SUM(CASE WHEN tracked THEN 0 ELSE 1 END) AS untracked
          FROM cost_records
          WHERE workspace_id = ${query.workspaceId}
            AND day_key >= ${sinceDay}
            AND day_key <= ${untilDay}
          GROUP BY provider
        `;
    const billRows = query.provider
      ? await this.store.sql<
          Array<{ provider: string; amount: number | string }>
        >`
          SELECT provider, SUM(amount_cny_micro) AS amount
          FROM provider_bills
          WHERE workspace_id = ${query.workspaceId}
            AND period_start <= ${untilDay}
            AND period_end >= ${sinceDay}
            AND provider = ${query.provider}
          GROUP BY provider
        `
      : await this.store.sql<
          Array<{ provider: string; amount: number | string }>
        >`
          SELECT provider, SUM(amount_cny_micro) AS amount
          FROM provider_bills
          WHERE workspace_id = ${query.workspaceId}
            AND period_start <= ${untilDay}
            AND period_end >= ${sinceDay}
          GROUP BY provider
        `;
    const ledger = new Map(
      ledgerRows.map((row) => [row.provider, Number(row.cost)]),
    );
    const bills = new Map(
      billRows.map((row) => [row.provider, Number(row.amount)]),
    );
    const providers = Array.from(
      new Set([...ledger.keys(), ...bills.keys()]),
    ).sort();
    const rows: ReconcileRow[] = providers.map((provider) => {
      const ledgerCnyMicro = ledger.get(provider) ?? 0;
      const billedCnyMicro = bills.get(provider) ?? 0;
      const diffCnyMicro = ledgerCnyMicro - billedCnyMicro;
      const diffRatio =
        billedCnyMicro === 0
          ? ledgerCnyMicro === 0
            ? 0
            : 1
          : Math.abs(diffCnyMicro) / billedCnyMicro;
      return {
        provider,
        ledgerCnyMicro,
        billedCnyMicro,
        diffCnyMicro,
        diffRatio: Math.round(diffRatio * 10000) / 10000,
        ok: diffRatio <= RECONCILE_TOLERANCE,
      };
    });
    const ledgerCnyMicro = rows.reduce(
      (sum, row) => sum + row.ledgerCnyMicro,
      0,
    );
    const billedCnyMicro = rows.reduce(
      (sum, row) => sum + row.billedCnyMicro,
      0,
    );
    const diffCnyMicro = ledgerCnyMicro - billedCnyMicro;
    const diffRatio =
      billedCnyMicro === 0
        ? ledgerCnyMicro === 0
          ? 0
          : 1
        : Math.abs(diffCnyMicro) / billedCnyMicro;
    return {
      rows,
      ledgerCnyMicro,
      billedCnyMicro,
      diffCnyMicro,
      diffRatio: Math.round(diffRatio * 10000) / 10000,
      ok: diffRatio <= RECONCILE_TOLERANCE,
      untrackedCalls: ledgerRows.reduce(
        (sum, row) => sum + Number(row.untracked),
        0,
      ),
    };
  }

  private async selectRecord(recordId: string): Promise<CostRecord | null> {
    const rows = await this.store.sql<CostRecordDbRow[]>`
      SELECT * FROM cost_records WHERE record_id = ${recordId} LIMIT 1
    `;
    const row = rows[0];
    return row ? fromCostRow(row) : null;
  }
}

function billIdFor(input: ProviderBillInput): string {
  const digest = createHash("sha256")
    .update(
      `${input.workspaceId}|${input.provider}|${input.periodStart}|${input.periodEnd}|${input.source}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `bil_${digest}`;
}

function parsePriceEntries(value: unknown): PriceTableSnapshot["entries"] {
  // Postgres returns JSONB already parsed; SQLite returns the JSON text.
  if (typeof value === "string") {
    return JSON.parse(value) as PriceTableSnapshot["entries"];
  }
  return value as PriceTableSnapshot["entries"];
}

function fromCostRow(row: CostRecordDbRow): CostRecord {
  return {
    recordId: row.record_id,
    callId: row.call_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    scopeKind: row.scope_kind ?? "run",
    scopeId: row.scope_id,
    jobId: row.job_id,
    changeId: row.change_id,
    managerSessionId: row.manager_session_id,
    stageId: row.stage_id,
    agentId: row.agent_id,
    source: row.source,
    artifactId: row.artifact_id,
    modelId: row.model_id,
    provider: row.provider,
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    unitPriceInMicro: Number(row.unit_price_in_micro),
    unitPriceOutMicro: Number(row.unit_price_out_micro),
    priceVersion: row.price_version,
    currency: row.currency,
    costCnyMicro: Number(row.cost_cny_micro),
    tracked:
      typeof row.tracked === "boolean"
        ? row.tracked
        : Number(row.tracked) === 1,
    untrackedReason: row.untracked_reason,
    dayKey: row.day_key,
    ts: toIso(row.ts),
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
