import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IterationSignal } from "./signals";

/**
 * Drift detection and champion re-evaluation (70 §3.5).
 *
 * Three signals can invalidate the incremental baseline the evolution loop
 * optimizes against:
 *
 * - environment drift: the input/task distribution changed;
 * - evaluator drift: evaluator-vs-human agreement fell below 0.8;
 * - model drift: the provider pin changed under a fixed alias.
 *
 * Any of them sets `reevaluateChampion`, which means the next cycle must
 * re-score the champion in full against the frozen snapshot instead of trusting
 * the previous baseline score. A low agreement is also written as an alert
 * record so it is visible without waiting for a candidate.
 */
export type DriftKind =
  | "input_distribution"
  | "evaluator_agreement"
  | "model_pin";

export type DriftSeverity = "alert" | "pause";

export interface DriftFinding {
  kind: DriftKind;
  severity: DriftSeverity;
  detail: string;
  requiresReevaluation: boolean;
}

export interface DriftBaseline {
  /** Provider pin identity, e.g. `deepseek-pro@2026-11-01`. */
  modelPin?: string;
  /** Domain → weight (counts or shares); normalized at comparison time. */
  inputDistribution?: Record<string, number>;
  /** Evaluator-vs-human agreement in [0, 1]. */
  agreement?: number | null;
  /** Agreement sample size backing `agreement`. */
  sample?: number;
  updatedAt?: string;
}

export interface DriftOptions {
  /** Total-variation-distance threshold that counts as a distribution shift. */
  distributionThreshold?: number;
  /** Minimum acceptable evaluator-vs-human agreement (70 §5). */
  minAgreement?: number;
  /** Reviews required before agreement is judged. */
  minAgreementSample?: number;
}

export interface DriftReport {
  drifted: boolean;
  reevaluateChampion: boolean;
  findings: DriftFinding[];
  reasons: string[];
  previous: DriftBaseline | null;
  current: DriftBaseline;
}

export interface DriftSummary {
  drifted: boolean;
  reevaluateChampion: boolean;
  findings: DriftFinding[];
  reasons: string[];
  modelPin?: string;
  agreement?: number | null;
  agreementSample?: number;
}

export const DEFAULT_MIN_AGREEMENT = 0.8;
export const DEFAULT_DISTRIBUTION_DRIFT_THRESHOLD = 0.2;
export const MIN_AGREEMENT_SAMPLE = 5;

/**
 * Total variation distance between two normalized histograms: 0 when the
 * distributions match, 1 when they are disjoint. Zero totals yield 0 so an
 * empty window never fabricates a shift.
 */
export function distributionShift(
  previous: Record<string, number> | undefined,
  current: Record<string, number> | undefined,
): number {
  const left = normalize(previous);
  const right = normalize(current);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const keys = new Set([...left.keys(), ...right.keys()]);
  let distance = 0;
  for (const key of keys) {
    distance += Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0));
  }
  return round(distance / 2);
}

export function detectDrift(input: {
  previous: DriftBaseline | null;
  current: DriftBaseline;
  options?: DriftOptions;
}): DriftReport {
  const options = input.options ?? {};
  const findings: DriftFinding[] = [];
  const previous = input.previous;
  const current = input.current;

  if (
    previous?.modelPin &&
    current.modelPin &&
    previous.modelPin !== current.modelPin
  ) {
    findings.push({
      kind: "model_pin",
      severity: "alert",
      detail: `model pin changed from ${previous.modelPin} to ${current.modelPin}`,
      requiresReevaluation: true,
    });
  }

  const shift = distributionShift(
    previous?.inputDistribution,
    current.inputDistribution,
  );
  const threshold =
    options.distributionThreshold ?? DEFAULT_DISTRIBUTION_DRIFT_THRESHOLD;
  if (shift > threshold) {
    findings.push({
      kind: "input_distribution",
      severity: "alert",
      detail: `input distribution shifted (TV ${shift.toFixed(2)} > ${threshold.toFixed(2)})`,
      requiresReevaluation: true,
    });
  }

  const minAgreement = options.minAgreement ?? DEFAULT_MIN_AGREEMENT;
  const minSample = options.minAgreementSample ?? MIN_AGREEMENT_SAMPLE;
  if (
    typeof current.agreement === "number" &&
    current.agreement < minAgreement &&
    (current.sample ?? 0) >= minSample
  ) {
    findings.push({
      kind: "evaluator_agreement",
      severity: "alert",
      detail: `evaluator-human agreement ${current.agreement.toFixed(2)} < ${minAgreement.toFixed(2)} across ${current.sample} reviews`,
      requiresReevaluation: true,
    });
  }

  return {
    drifted: findings.length > 0,
    reevaluateChampion: findings.some(
      (finding) => finding.requiresReevaluation,
    ),
    findings,
    reasons: findings.map((finding) => finding.detail),
    previous,
    current,
  };
}

export function driftSummary(report: DriftReport): DriftSummary {
  return {
    drifted: report.drifted,
    reevaluateChampion: report.reevaluateChampion,
    findings: [...report.findings],
    reasons: [...report.reasons],
    ...(report.current.modelPin ? { modelPin: report.current.modelPin } : {}),
    ...(report.current.agreement !== undefined
      ? { agreement: report.current.agreement }
      : {}),
    ...(report.current.sample !== undefined
      ? { agreementSample: report.current.sample }
      : {}),
  };
}

/** Domain weights from iteration signals; the input-distribution monitor. */
export function inputDistributionOf(
  signals: readonly IterationSignal[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const signal of signals) {
    const domain = signal.domain || "unknown";
    counts[domain] = (counts[domain] ?? 0) + 1;
  }
  return counts;
}

/**
 * Pin identity for drift comparison. The alias alone hides a provider update,
 * so an explicit provider pin (CLI `--model-pin` or
 * `KIT_MODEL_PROVIDER_PIN`) is appended when present.
 */
export function modelPinFor(alias: string, providerPin?: string): string {
  const model = alias.trim() || "unknown";
  const pin = providerPin?.trim();
  return pin ? `${model}@${pin}` : model;
}

export async function readDriftBaseline(
  file: string,
): Promise<DriftBaseline | null> {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const baseline: DriftBaseline = {};
    if (typeof record.modelPin === "string") {
      baseline.modelPin = record.modelPin;
    }
    if (
      typeof record.inputDistribution === "object" &&
      record.inputDistribution !== null
    ) {
      const distribution: Record<string, number> = {};
      for (const [key, value] of Object.entries(
        record.inputDistribution as Record<string, unknown>,
      )) {
        if (typeof value === "number" && Number.isFinite(value)) {
          distribution[key] = value;
        }
      }
      baseline.inputDistribution = distribution;
    }
    if (
      typeof record.agreement === "number" &&
      Number.isFinite(record.agreement)
    ) {
      baseline.agreement = record.agreement;
    } else if (record.agreement === null) {
      baseline.agreement = null;
    }
    if (typeof record.sample === "number" && Number.isFinite(record.sample)) {
      baseline.sample = record.sample;
    }
    if (typeof record.updatedAt === "string") {
      baseline.updatedAt = record.updatedAt;
    }
    return baseline;
  } catch {
    // A corrupt baseline is treated as "no baseline": the next cycle
    // re-establishes it instead of failing or inventing a drift alarm.
    return null;
  }
}

export async function writeDriftBaseline(
  file: string,
  baseline: DriftBaseline,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(baseline, null, 2), "utf8");
}

function normalize(
  distribution: Record<string, number> | undefined,
): Map<string, number> {
  const result = new Map<string, number>();
  if (!distribution) {
    return result;
  }
  let total = 0;
  for (const value of Object.values(distribution)) {
    if (Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  if (total <= 0) {
    return result;
  }
  for (const [key, value] of Object.entries(distribution)) {
    if (Number.isFinite(value) && value > 0) {
      result.set(key, value / total);
    }
  }
  return result;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
