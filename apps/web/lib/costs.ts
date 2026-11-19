import { microToCny } from "@kit/core";
import type {
  ArtifactCostReport,
  CostAnomaly,
  DailyCostRow,
  ProviderBill,
} from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DailyCostView {
  dayKey: string;
  costCny: number;
  trackedCalls: number;
  untrackedCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ArtifactCostView {
  artifactId: string;
  runId: string;
  stageId: string | null;
  costCny: number;
  calls: number;
}

export interface CostAnomalyView {
  dayKey: string;
  costCny: number;
  baselineMeanCny: number;
  zScore: number;
}

export interface ReconciliationView {
  provider: string;
  ledgerCny: number;
  billedCny: number;
  diffRatio: number;
  ok: boolean;
}

export interface CostOverview {
  workspaceId: string;
  windowDays: number;
  daily: DailyCostView[];
  totalCny: number;
  untrackedCalls: number;
  unitCost: {
    averageCny: number;
    artifactCount: number;
    artifacts: ArtifactCostView[];
  };
  anomalies: CostAnomalyView[];
  reconciliation: {
    hasBills: boolean;
    rows: ReconciliationView[];
    diffRatio: number;
    ok: boolean;
    untrackedCalls: number;
  };
  bills: Array<{
    provider: string;
    periodStart: string;
    periodEnd: string;
    amountCny: number;
    source: string;
  }>;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Console read model for cost attribution: daily spend, unit artifact cost,
 * z-score anomalies and ledger-vs-bill reconciliation. Read-only.
 */
export async function loadCostOverview(
  workspaceId = "default",
  windowDays = 14,
): Promise<CostOverview> {
  await ensureStoreSchema();
  const store = getStore();
  const now = new Date();
  const since = new Date(
    startOfUtcDay(now).getTime() - (windowDays - 1) * DAY_MS,
  );

  const [daily, unitCost, anomalies, bills] = await Promise.all([
    store.costLedger.dailyCost({ workspaceId, since, until: now }),
    store.costLedger.artifactUnitCost({ workspaceId, since, until: now }),
    store.costLedger.anomalies({ workspaceId, until: now }),
    store.costLedger.listProviderBills({ workspaceId, limit: 12 }),
  ]);
  const reconciliation = await store.costLedger.reconcile({
    workspaceId,
    since,
    until: now,
  });

  return {
    workspaceId,
    windowDays,
    daily: daily.map((row: DailyCostRow) => ({
      dayKey: row.dayKey,
      costCny: microToCny(row.costCnyMicro),
      trackedCalls: row.trackedCalls,
      untrackedCalls: row.untrackedCalls,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
    })),
    totalCny: microToCny(
      daily.reduce(
        (sum: number, row: DailyCostRow) => sum + row.costCnyMicro,
        0,
      ),
    ),
    untrackedCalls: daily.reduce(
      (sum: number, row: DailyCostRow) => sum + row.untrackedCalls,
      0,
    ),
    unitCost: toUnitCostView(unitCost),
    anomalies: anomalies.map((anomaly: CostAnomaly) => ({
      dayKey: anomaly.dayKey,
      costCny: microToCny(anomaly.costCnyMicro),
      baselineMeanCny: microToCny(anomaly.baselineMeanCnyMicro),
      zScore: anomaly.zScore,
    })),
    reconciliation: {
      hasBills: bills.length > 0,
      rows: reconciliation.rows.map((row) => ({
        provider: row.provider,
        ledgerCny: microToCny(row.ledgerCnyMicro),
        billedCny: microToCny(row.billedCnyMicro),
        diffRatio: row.diffRatio,
        ok: row.ok,
      })),
      diffRatio: reconciliation.diffRatio,
      ok: reconciliation.ok,
      untrackedCalls: reconciliation.untrackedCalls,
    },
    bills: bills.map((bill: ProviderBill) => ({
      provider: bill.provider,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
      amountCny: microToCny(bill.amountCnyMicro),
      source: bill.source,
    })),
  };
}

function toUnitCostView(report: ArtifactCostReport): CostOverview["unitCost"] {
  return {
    averageCny: microToCny(report.averageUnitCostCnyMicro),
    artifactCount: report.artifactCount,
    artifacts: report.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      runId: artifact.runId,
      stageId: artifact.stageId,
      costCny: microToCny(artifact.costCnyMicro),
      calls: artifact.calls,
    })),
  };
}
