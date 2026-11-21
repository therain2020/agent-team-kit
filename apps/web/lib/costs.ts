import { microToCny } from "@kit/core";
import { findSupersededPriceVersions, loadPriceTable } from "@kit/model";
import { type AlertInput, emitAlert } from "@kit/ops";
import type {
  ArtifactCostReport,
  CostAnomaly,
  DailyCostRow,
  PriceTableSnapshot,
  ProviderBill,
} from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

type Store = ReturnType<typeof getStore>;

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

export interface PriceChangeView {
  previousVersion: string;
  currentVersion: string;
  currentEffectiveAt: string;
}

export interface NonRunCostView {
  scopeKind: string;
  scopeId: string;
  costCny: number;
  calls: number;
  untrackedCalls: number;
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
  /** Versioned table the startup estimates and live calls price from. */
  priceVersion: string;
  /** Old versions whose validity ended; also raised as P2 alerts. */
  priceChanges: PriceChangeView[];
  /** Compose, evolution and manager spend that has no run scope. */
  nonRun: NonRunCostView[];
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

  const price = await syncPriceTable(store, workspaceId, now);
  const [daily, unitCost, anomalies, bills, nonRun] = await Promise.all([
    store.costLedger.dailyCost({ workspaceId, since, until: now }),
    store.costLedger.artifactUnitCost({ workspaceId, since, until: now }),
    store.costLedger.anomalies({ workspaceId, until: now }),
    store.costLedger.listProviderBills({ workspaceId, limit: 12 }),
    store.costLedger.scopeCost({
      workspaceId,
      since,
      until: now,
      excludeRun: true,
      limit: 20,
    }),
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
    priceVersion: price.version,
    priceChanges: price.changes,
    nonRun: nonRun.map((row) => ({
      scopeKind: row.scopeKind,
      scopeId: row.scopeId ?? "—",
      costCny: microToCny(row.costCnyMicro),
      calls: row.calls,
      untrackedCalls: row.untrackedCalls,
    })),
  };
}

/**
 * Register the active price table (so historical versions stay auditable) and
 * raise a P2 reminder for every version whose validity ended. Deduplicated per
 * workspace and version pair by the alert store.
 */
async function syncPriceTable(
  store: Store,
  workspaceId: string,
  now: Date,
): Promise<{ version: string; changes: PriceChangeView[] }> {
  const table = loadPriceTable();
  const existing = await store.costLedger.getPriceTable(table.version);
  if (
    !existing ||
    existing.effectiveAt !== table.effectiveAt ||
    !sameEntries(existing, table)
  ) {
    await store.costLedger.registerPriceTable(table, now);
  }
  const tables = await store.costLedger.listPriceTables();
  const changes = findSupersededPriceVersions(tables, now);
  for (const change of changes) {
    const alert: AlertInput = {
      workspaceId,
      tier: "P2",
      kind: "cost.price_table.changed",
      title: `Price table ${change.previousVersion} → ${change.currentVersion}`,
      body: `Price table ${change.previousVersion} is no longer in effect since ${change.currentVersion} took over at ${change.currentEffectiveAt}. Historical records keep their charged prices; recalculate budgets and startup estimates.`,
      dedupeKey: `cost.price_table.changed:${workspaceId}:${change.previousVersion}:${change.currentVersion}`,
      source: "web",
      meta: {
        previousVersion: change.previousVersion,
        previousEffectiveAt: change.previousEffectiveAt,
        currentVersion: change.currentVersion,
        currentEffectiveAt: change.currentEffectiveAt,
      },
    };
    try {
      await emitAlert(store, alert);
    } catch (error) {
      // A reminder failure must not take down the ops view.
      console.error(
        `[cost] price table alert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    version: table.version,
    changes: changes.map((change) => ({
      previousVersion: change.previousVersion,
      currentVersion: change.currentVersion,
      currentEffectiveAt: change.currentEffectiveAt,
    })),
  };
}

function sameEntries(
  stored: PriceTableSnapshot,
  table: { entries: PriceTableSnapshot["entries"] },
): boolean {
  return JSON.stringify(stored.entries) === JSON.stringify(table.entries);
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
