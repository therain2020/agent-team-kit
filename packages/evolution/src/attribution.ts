import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "@kit/core";
import { rollbackCanary } from "./canary";
import { type FreezeOptions, freezeEvolution, loadFreezeState } from "./freeze";
import { appendGovernanceEvent } from "./governance";
import type { EvolutionRepository } from "./repository";
import {
  type ChangeRevertService,
  type RevertOutcome,
  revertChangeProposal,
} from "./revert";
import { type IterationSignal, summarizeSignals } from "./signals";

/**
 * Closed-loop attribution (85 §3.5, 70 §3.4/§3.6).
 *
 * Offline cycles say a candidate looked better against a frozen snapshot. Only
 * real traffic says whether it *was* better. An attribution record compares
 * the live fitness window produced by a change (canary-routed iteration tasks)
 * with the champion window, and a change whose offline score rose while live
 * pass/apply rate, cost or incidents got worse is a Goodhart divergence: the
 * evolution plane pauses and the change is reverted through the unified
 * `ChangeProposal.revertRef` path.
 *
 * The metric definitions (`FitnessWindow`) are the same pass/apply/cost/risk
 * signals the Goodhart guard and drift monitor already read, so there is one
 * definition of "real result" in the plane.
 */
export type ChangeStage = "canary" | "promoted";

export interface FitnessWindow {
  tasks: number;
  iterations: number;
  /** Verified tasks / tasks. */
  passRate: number;
  /** Applied tasks / verified tasks. */
  applyRate: number;
  /** Average model tokens per task; the live cost signal. */
  avgTokens: number;
  /** Share of high-risk tasks, so a risky change cannot hide behind averages. */
  highRiskShare: number;
  /** Tasks that errored / tasks; the live incident signal. */
  incidentRate: number;
}

export interface FitnessDelta {
  passRate: number;
  applyRate: number;
  avgTokens: number;
  /** Changed / baseline average tokens; null when the baseline is zero. */
  avgTokensRatio: number | null;
  highRiskShare: number;
  incidentRate: number;
}

export interface AttributionThresholds {
  /** Tasks required in each window before a verdict is attempted. */
  minTasks: number;
  /** Offline score rise that counts as "the offline score went up". */
  offlineScoreRise: number;
  /** Live pass-rate drop that counts as a real regression. */
  passRateDrop: number;
  /** Live apply-rate drop that counts as a real regression. */
  applyRateDrop: number;
  /** Live cost ratio that counts as a real regression. */
  costMultiplier: number;
  /** Live high-risk share rise that counts as a real regression. */
  highRiskRise: number;
  /** Live incident-rate rise that counts as a real regression. */
  incidentRateRise: number;
}

export type AttributionVerdict =
  | "divergent"
  | "regressed"
  | "improved"
  | "flat"
  | "insufficient_data";

export interface AttributionActions {
  /** True when the divergence paused evolution (or it was already paused). */
  paused: boolean;
  freezeKind?: string;
  /** Unified revert outcome; null when rollback was not attempted. */
  rollback: RevertOutcome | null;
}

export interface AttributionRecord {
  attributionId: string;
  workspaceId: string;
  changeId: string;
  stage: ChangeStage | null;
  verdict: AttributionVerdict;
  divergent: boolean;
  offlineScoreDelta: number | null;
  baseline: FitnessWindow;
  changed: FitnessWindow;
  delta: FitnessDelta;
  thresholds: AttributionThresholds;
  reasons: string[];
  window: {
    baselineFrom: string | null;
    baselineTo: string | null;
    changedFrom: string | null;
    changedTo: string | null;
  };
  actions: AttributionActions;
  createdAt: string;
}

export interface AttributionComparison {
  verdict: AttributionVerdict;
  divergent: boolean;
  reasons: string[];
  delta: FitnessDelta;
  thresholds: AttributionThresholds;
}

export interface WindowSelectionOptions {
  /** Baseline lookback used when no champion traffic overlaps the change. */
  baselineWindowMs?: number;
  /** Cap on baseline signals considered. */
  baselineLimit?: number;
}

export const DEFAULT_BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_BASELINE_LIMIT = 500;

export const DEFAULT_ATTRIBUTION_THRESHOLDS: AttributionThresholds = {
  minTasks: 3,
  offlineScoreRise: 0.02,
  passRateDrop: 0.1,
  applyRateDrop: 0.1,
  costMultiplier: 1.5,
  highRiskRise: 0.2,
  incidentRateRise: 0.1,
};

export interface AttributionWindows {
  baseline: IterationSignal[];
  changed: IterationSignal[];
}

/**
 * Splits signals into the changed window and its baseline. Champion traffic
 * concurrent with the change is the preferred baseline because it removes
 * time-of-day and task-mix drift; when no champion run overlapped (e.g. 100%
 * canary traffic), the immediately preceding lookback window is used instead.
 * Signals without a `changeId` are champion signals by construction.
 */
export function selectAttributionWindows(
  signals: readonly IterationSignal[],
  changeId: string,
  options: WindowSelectionOptions = {},
): AttributionWindows {
  const ordered = [...signals].sort((a, b) => a.at.localeCompare(b.at));
  const changed = ordered.filter((signal) => signal.changeId === changeId);
  if (changed.length === 0) {
    return { baseline: [], changed: [] };
  }
  const firstAt = changed[0]?.at ?? "";
  const lastAt = changed.at(-1)?.at ?? firstAt;
  const champion = ordered.filter((signal) => !signal.changeId);

  const concurrent = champion.filter(
    (signal) => signal.at >= firstAt && signal.at <= lastAt,
  );
  if (concurrent.length > 0) {
    return { baseline: concurrent, changed };
  }

  const windowMs = options.baselineWindowMs ?? DEFAULT_BASELINE_WINDOW_MS;
  const limit = Math.max(1, options.baselineLimit ?? DEFAULT_BASELINE_LIMIT);
  const start = new Date(new Date(firstAt).getTime() - windowMs).toISOString();
  const preceding = champion
    .filter((signal) => signal.at >= start && signal.at < firstAt)
    .slice(-limit);
  return { baseline: preceding, changed };
}

/**
 * Pass/apply rates reuse `summarizeSignals` so attribution, the signal
 * summary and the propose heuristic cannot drift apart; values are rounded to
 * the same 4 decimals the rest of the evolution plane records. The extra live
 * signals (cost, risk mix, incidents) are added here.
 */
export function fitnessWindowOf(
  signals: readonly IterationSignal[],
): FitnessWindow {
  const tasks = signals.length;
  const summary = summarizeSignals([...signals]);
  const highRisk = signals.filter((signal) => signal.risk === "high").length;
  const incidents = signals.filter(
    (signal) => typeof signal.error === "string" && signal.error.length > 0,
  ).length;
  const tokens = signals.reduce((sum, signal) => sum + signal.tokens, 0);
  return {
    tasks,
    iterations: new Set(signals.map((signal) => signal.iterationId)).size,
    passRate: round(summary.passRate),
    applyRate: round(summary.applyRate),
    avgTokens: tasks > 0 ? Math.round(tokens / tasks) : 0,
    highRiskShare: ratio(highRisk, tasks),
    incidentRate: ratio(incidents, tasks),
  };
}

export function compareFitnessWindows(
  baseline: FitnessWindow,
  changed: FitnessWindow,
  options: {
    offlineScoreDelta?: number | null;
    thresholds?: Partial<AttributionThresholds>;
  } = {},
): AttributionComparison {
  const thresholds = resolveThresholds(options.thresholds);
  const delta = fitnessDelta(baseline, changed);
  const enough =
    baseline.tasks >= thresholds.minTasks &&
    changed.tasks >= thresholds.minTasks;

  const reasons: string[] = [];
  if (enough) {
    if (delta.passRate <= -thresholds.passRateDrop) {
      reasons.push(
        `live pass rate fell ${pct(baseline.passRate)} -> ${pct(changed.passRate)} (drop ${pct(-delta.passRate)}, threshold ${pct(thresholds.passRateDrop)})`,
      );
    }
    if (
      baseline.applyRate > 0 &&
      delta.applyRate <= -thresholds.applyRateDrop
    ) {
      reasons.push(
        `live apply rate fell ${pct(baseline.applyRate)} -> ${pct(changed.applyRate)} (drop ${pct(-delta.applyRate)}, threshold ${pct(thresholds.applyRateDrop)})`,
      );
    }
    if (
      delta.avgTokensRatio !== null &&
      delta.avgTokensRatio >= thresholds.costMultiplier
    ) {
      reasons.push(
        `live cost per task rose ${delta.avgTokensRatio.toFixed(2)}x (threshold ${thresholds.costMultiplier.toFixed(2)}x)`,
      );
    }
    if (delta.highRiskShare >= thresholds.highRiskRise) {
      reasons.push(
        `live high-risk share rose ${pct(baseline.highRiskShare)} -> ${pct(changed.highRiskShare)} (threshold +${pct(thresholds.highRiskRise)})`,
      );
    }
    if (delta.incidentRate >= thresholds.incidentRateRise) {
      reasons.push(
        `live incident rate rose ${pct(baseline.incidentRate)} -> ${pct(changed.incidentRate)} (threshold +${pct(thresholds.incidentRateRise)})`,
      );
    }
  }

  const offlineUp =
    typeof options.offlineScoreDelta === "number" &&
    options.offlineScoreDelta >= thresholds.offlineScoreRise;
  const divergent = enough && offlineUp && reasons.length > 0;

  let verdict: AttributionVerdict;
  if (!enough) {
    verdict = "insufficient_data";
  } else if (divergent) {
    verdict = "divergent";
  } else if (reasons.length > 0) {
    verdict = "regressed";
  } else if (
    delta.passRate >= thresholds.offlineScoreRise ||
    delta.applyRate >= thresholds.offlineScoreRise
  ) {
    verdict = "improved";
  } else {
    verdict = "flat";
  }

  return { verdict, divergent, reasons, delta, thresholds };
}

export interface BuildAttributionInput {
  workspaceId?: string;
  changeId: string;
  stage?: ChangeStage | null;
  signals: readonly IterationSignal[];
  offlineScoreDelta?: number | null;
  thresholds?: Partial<AttributionThresholds>;
  windows?: WindowSelectionOptions;
  now?: string;
}

/** Builds the record from raw signals; pure apart from id/time generation. */
export function buildAttributionRecord(
  input: BuildAttributionInput,
): AttributionRecord {
  const windows = selectAttributionWindows(
    input.signals,
    input.changeId,
    input.windows,
  );
  const baseline = fitnessWindowOf(windows.baseline);
  const changed = fitnessWindowOf(windows.changed);
  const comparison = compareFitnessWindows(baseline, changed, {
    offlineScoreDelta: input.offlineScoreDelta ?? null,
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
  });
  const offlineScoreDelta =
    typeof input.offlineScoreDelta === "number" &&
    Number.isFinite(input.offlineScoreDelta)
      ? round(input.offlineScoreDelta)
      : null;
  return {
    attributionId: newId("atr"),
    workspaceId: input.workspaceId ?? "default",
    changeId: input.changeId,
    stage: input.stage === undefined ? stageOf(windows.changed) : input.stage,
    verdict: comparison.verdict,
    divergent: comparison.divergent,
    offlineScoreDelta,
    baseline,
    changed,
    delta: comparison.delta,
    thresholds: comparison.thresholds,
    reasons: comparison.reasons,
    window: {
      baselineFrom: windows.baseline[0]?.at ?? null,
      baselineTo: windows.baseline.at(-1)?.at ?? null,
      changedFrom: windows.changed[0]?.at ?? null,
      changedTo: windows.changed.at(-1)?.at ?? null,
    },
    actions: { paused: false, rollback: null },
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function attributionPauseReason(record: AttributionRecord): string {
  const offline =
    record.offlineScoreDelta === null
      ? "offline score delta unknown"
      : `offline score ${formatSigned(record.offlineScoreDelta)}`;
  return `live attribution for ${record.changeId}: ${offline} while ${record.reasons.join("; ")}`;
}

export interface ApplyAttributionOptions {
  record: AttributionRecord;
  /** Freeze persistence (repository or file). */
  freeze?: FreezeOptions;
  governancePath?: string;
  actor?: string;
  /** Unified revert wiring. Omit to record the pause without a rollback. */
  revert?: {
    service: ChangeRevertService;
    proposalId: string | null;
    /** Active canary for this change, rolled back through its state machine. */
    canary?: { repo: EvolutionRepository };
  };
}

/**
 * Actuates a divergence: pause evolution, write the governance signal, and
 * revert through the unified change pipeline. Non-divergent records are
 * returned unchanged, so a healthy or under-sampled window has no side
 * effects (the false-positive guard).
 */
export async function applyAttributionOutcome(
  options: ApplyAttributionOptions,
): Promise<AttributionRecord> {
  const record = options.record;
  if (!record.divergent) {
    return record;
  }
  const actor = options.actor ?? "evolution:attribution";
  const reason = attributionPauseReason(record);
  const freezeOptions = options.freeze ?? {};

  const current = await loadFreezeState(freezeOptions);
  let freezeKind = current.kind;
  if (current.status !== "frozen") {
    const frozen = await freezeEvolution(
      {
        kind: "divergence",
        reason,
        actor,
      },
      freezeOptions,
    );
    freezeKind = frozen.kind;
  }

  let rollback: RevertOutcome | null = null;
  if (options.revert) {
    rollback = await revertChangeProposal(options.revert.service, {
      proposalId: options.revert.proposalId,
      changeId: record.changeId,
      reason,
      actor,
    });
    if (rollback.status === "rolled_back" && options.revert.canary) {
      rollback = {
        ...rollback,
        canary: await rollbackCanaryState(options.revert.canary, reason, actor),
      };
    }
  }

  await appendGovernanceEvent(
    {
      workspaceId: record.workspaceId,
      kind: "attribution",
      action: rollback?.status === "rolled_back" ? "rollback" : "paused",
      reason,
      cycleIds: [],
      details: {
        attributionId: record.attributionId,
        changeId: record.changeId,
        verdict: record.verdict,
        reasons: record.reasons,
        rollback: rollback?.status ?? null,
      },
    },
    options.governancePath,
  );

  return {
    ...record,
    actions: {
      paused: true,
      ...(freezeKind ? { freezeKind } : {}),
      rollback,
    },
  };
}

export function defaultAttributionPath(root = "variants"): string {
  return path.join(root, "attribution.jsonl");
}

export async function appendAttributionRecord(
  record: AttributionRecord,
  file: string = defaultAttributionPath(),
): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Reads attribution records newest-first. Missing files, blank lines and
 * corrupt rows are skipped: the console must keep rendering when a partially
 * written line lands, and the rollback audit lives in the change proposal.
 */
export async function loadAttributionRecords(
  file: string = defaultAttributionPath(),
  limit = 20,
): Promise<AttributionRecord[]> {
  if (!existsSync(file)) {
    return [];
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const records: AttributionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isAttributionRecord(parsed)) {
      records.push(parsed);
    }
  }
  return records
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function isAttributionRecord(
  value: unknown,
): value is AttributionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.attributionId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.changeId === "string" &&
    (record.stage === null ||
      record.stage === "canary" ||
      record.stage === "promoted") &&
    typeof record.verdict === "string" &&
    VERDICTS.has(record.verdict as AttributionVerdict) &&
    typeof record.divergent === "boolean" &&
    (record.offlineScoreDelta === null ||
      typeof record.offlineScoreDelta === "number") &&
    isFitnessWindow(record.baseline) &&
    isFitnessWindow(record.changed) &&
    typeof record.delta === "object" &&
    record.delta !== null &&
    Array.isArray(record.reasons) &&
    record.reasons.every((reason) => typeof reason === "string") &&
    typeof record.actions === "object" &&
    record.actions !== null &&
    typeof (record.actions as Record<string, unknown>).paused === "boolean" &&
    typeof record.createdAt === "string"
  );
}

const VERDICTS = new Set<AttributionVerdict>([
  "divergent",
  "regressed",
  "improved",
  "flat",
  "insufficient_data",
]);

function isFitnessWindow(value: unknown): value is FitnessWindow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const window = value as Record<string, unknown>;
  return (
    typeof window.tasks === "number" &&
    typeof window.passRate === "number" &&
    typeof window.applyRate === "number" &&
    typeof window.avgTokens === "number" &&
    typeof window.highRiskShare === "number" &&
    typeof window.incidentRate === "number"
  );
}

async function rollbackCanaryState(
  canary: { repo: EvolutionRepository },
  reason: string,
  actor: string,
): Promise<NonNullable<RevertOutcome["canary"]>> {
  try {
    await rollbackCanary(reason, {
      repo: canary.repo,
      actor,
      trigger: "pass_rate",
    });
    return { status: "rolled_back", reason };
  } catch (error) {
    // A promoted or already-stopped canary has nothing to stop; the proposal
    // rollback above is the authoritative revert and stays recorded.
    return {
      status: "skipped",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function fitnessDelta(
  baseline: FitnessWindow,
  changed: FitnessWindow,
): FitnessDelta {
  return {
    passRate: round(changed.passRate - baseline.passRate),
    applyRate: round(changed.applyRate - baseline.applyRate),
    avgTokens: changed.avgTokens - baseline.avgTokens,
    avgTokensRatio:
      baseline.avgTokens > 0
        ? round(changed.avgTokens / baseline.avgTokens)
        : null,
    highRiskShare: round(changed.highRiskShare - baseline.highRiskShare),
    incidentRate: round(changed.incidentRate - baseline.incidentRate),
  };
}

function resolveThresholds(
  overrides: Partial<AttributionThresholds> | undefined,
): AttributionThresholds {
  return { ...DEFAULT_ATTRIBUTION_THRESHOLDS, ...overrides };
}

function stageOf(signals: readonly IterationSignal[]): ChangeStage | null {
  for (const signal of signals) {
    if (signal.changeStage === "canary" || signal.changeStage === "promoted") {
      return signal.changeStage;
    }
  }
  return null;
}

function ratio(value: number, total: number): number {
  return total > 0 ? round(value / total) : 0;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
