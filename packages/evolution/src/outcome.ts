import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionCycleRecord } from "./cycle";
import { defaultSignalsRoot } from "./signals";

/**
 * Outcome-oriented metrics for the evolution plane (70 §3.4).
 *
 * Process scores say a draft satisfied the rubric; they do not say the real
 * artifact was accepted or a human reviewer approved it. An outcome
 * observation is the missing second signal, and the Goodhart guard only fires
 * when scores rise while this signal stays flat or falls.
 *
 * Observations are recorded after a cycle finishes (artifact acceptance or
 * human review), so they are joined onto cycles when reported rather than
 * rewritten into the cycle record. The JSONL file is an adapter layer; the
 * durable copy of an observation is the reviewer's own artifact/review
 * reference carried in `ref` (D-52).
 */
export type OutcomeSource = "artifact_acceptance" | "human_review";

export interface OutcomeObservation {
  at: string;
  source: OutcomeSource;
  /** Outcome quality in [0, 1]; the human/acceptance signal, not the rubric. */
  score: number;
  pass: boolean;
  /** Evolution cycle this outcome judges. Enables divergence detection. */
  cycleId?: string;
  /** Variant whose output was accepted or reviewed. */
  variantId?: string;
  /** Artifact id, review id or incident/postmortem reference. */
  ref?: string;
}

export interface OutcomeFile {
  path: string;
  outcomes: OutcomeObservation[];
  lines: number;
  corrupt: number;
  duplicates: number;
}

export interface OutcomeSummary {
  total: number;
  passed: number;
  passRate: number;
  avgScore: number;
  sources: Record<OutcomeSource, number>;
}

export interface CycleOutcomeView {
  cycleId: string;
  createdAt: string;
  /** Judge score the cycle reached (candidate average), when scored. */
  score: number | null;
  outcome: OutcomeObservation | null;
}

const OUTCOME_SOURCES = new Set<OutcomeSource>([
  "artifact_acceptance",
  "human_review",
]);

export function defaultOutcomesPath(root?: string): string {
  return path.join(root ?? defaultSignalsRoot(), "outcomes.jsonl");
}

/**
 * Reads `outcomes.jsonl` defensively. Missing files, blank lines and corrupt
 * lines contribute nothing; duplicate observations (same cycle/variant,
 * source and timestamp) are collapsed on first occurrence so replaying a line
 * cannot skew the Goodhart guard.
 */
export async function readOutcomeObservations(
  file: string = defaultOutcomesPath(),
): Promise<OutcomeFile> {
  const empty: OutcomeFile = {
    path: file,
    outcomes: [],
    lines: 0,
    corrupt: 0,
    duplicates: 0,
  };
  if (!existsSync(file)) {
    return empty;
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return empty;
  }

  const outcomes: OutcomeObservation[] = [];
  const seen = new Set<string>();
  let lines = 0;
  let corrupt = 0;
  let duplicates = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!isOutcomeObservation(parsed)) {
      corrupt += 1;
      continue;
    }
    const id = outcomeObservationId(parsed);
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    outcomes.push(parsed);
  }
  return { path: file, outcomes, lines, corrupt, duplicates };
}

export function isOutcomeObservation(
  value: unknown,
): value is OutcomeObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === "string" &&
    typeof record.source === "string" &&
    OUTCOME_SOURCES.has(record.source as OutcomeSource) &&
    typeof record.score === "number" &&
    Number.isFinite(record.score) &&
    record.score >= 0 &&
    record.score <= 1 &&
    typeof record.pass === "boolean" &&
    (record.cycleId === undefined || typeof record.cycleId === "string") &&
    (record.variantId === undefined || typeof record.variantId === "string") &&
    (record.ref === undefined || typeof record.ref === "string") &&
    (typeof record.cycleId === "string" || typeof record.variantId === "string")
  );
}

export function outcomeObservationId(outcome: OutcomeObservation): string {
  const key = `${outcome.cycleId ?? ""}|${outcome.variantId ?? ""}|${outcome.source}|${outcome.at}`;
  return `out_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export interface RecordOutcomeInput {
  at?: string;
  source?: OutcomeSource;
  score: number;
  pass: boolean;
  cycleId?: string;
  variantId?: string;
  ref?: string;
}

/** Validates and appends one observation; returns the normalized record. */
export async function recordOutcome(
  input: RecordOutcomeInput,
  file: string = defaultOutcomesPath(),
): Promise<OutcomeObservation> {
  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
    throw new Error("outcome score must be between 0 and 1");
  }
  if (!input.cycleId && !input.variantId) {
    throw new Error("outcome needs a cycleId or a variantId");
  }
  const source = input.source ?? "human_review";
  if (!OUTCOME_SOURCES.has(source)) {
    throw new Error(`unknown outcome source: ${source}`);
  }
  const outcome: OutcomeObservation = {
    at: input.at ?? new Date().toISOString(),
    source,
    score: round(input.score),
    pass: input.pass,
    ...(input.cycleId ? { cycleId: input.cycleId } : {}),
    ...(input.variantId ? { variantId: input.variantId } : {}),
    ...(input.ref ? { ref: input.ref } : {}),
  };
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await appendFile(file, `${JSON.stringify(outcome)}\n`, "utf8");
  return outcome;
}

/** Latest observation attached to a cycle (cycleId match only). */
export function latestOutcomeForCycle(
  outcomes: readonly OutcomeObservation[],
  cycleId: string,
): OutcomeObservation | undefined {
  let latest: OutcomeObservation | undefined;
  for (const outcome of outcomes) {
    if (outcome.cycleId !== cycleId) {
      continue;
    }
    if (!latest || outcome.at >= latest.at) {
      latest = outcome;
    }
  }
  return latest;
}

export function summarizeOutcomes(
  outcomes: readonly OutcomeObservation[],
): OutcomeSummary {
  const sources: Record<OutcomeSource, number> = {
    artifact_acceptance: 0,
    human_review: 0,
  };
  let passed = 0;
  let scoreSum = 0;
  for (const outcome of outcomes) {
    sources[outcome.source] += 1;
    if (outcome.pass) {
      passed += 1;
    }
    scoreSum += outcome.score;
  }
  const total = outcomes.length;
  return {
    total,
    passed,
    passRate: total > 0 ? round(passed / total) : 0,
    avgScore: total > 0 ? round(scoreSum / total) : 0,
    sources,
  };
}

/**
 * Joins outcomes onto cycles (newest cycle last) so the console and CLI can
 * show "score X, outcome Y" side by side without rewriting cycle records.
 */
export function attachOutcomes(
  cycles: readonly EvolutionCycleRecord[],
  outcomes: readonly OutcomeObservation[],
): CycleOutcomeView[] {
  return [...cycles]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((cycle) => ({
      cycleId: cycle.cycleId,
      createdAt: cycle.createdAt,
      score: cycle.candidateScore,
      outcome: latestOutcomeForCycle(outcomes, cycle.cycleId) ?? null,
    }));
}

export interface EvaluatorAgreement {
  /** Agreement rate in [0, 1]; null when the sample is too small. */
  rate: number | null;
  agree: number;
  sample: number;
}

/**
 * Evaluator-vs-human agreement (70 §5: keep ≥ 0.8). Every reviewed cycle
 * pairs the evaluator's `candidatePass` with the human `outcome.pass`; a low
 * sample is reported as `rate: null` instead of noise.
 */
export function evaluatorAgreement(
  cycles: readonly EvolutionCycleRecord[],
  outcomes: readonly OutcomeObservation[],
  minSample = 5,
): EvaluatorAgreement {
  let agree = 0;
  let sample = 0;
  for (const cycle of cycles) {
    if (cycle.candidatePass === null) {
      continue;
    }
    // One review per cycle: a cycle with several observations (acceptance and
    // human review) counts once, using the latest observation.
    const outcome = latestOutcomeForCycle(outcomes, cycle.cycleId);
    if (!outcome) {
      continue;
    }
    sample += 1;
    if (cycle.candidatePass === outcome.pass) {
      agree += 1;
    }
  }
  return {
    rate: sample >= Math.max(1, minSample) ? round(agree / sample) : null,
    agree,
    sample,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
