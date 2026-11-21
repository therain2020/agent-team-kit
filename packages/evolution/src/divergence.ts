import type { EvolutionCycleRecord } from "./cycle";
import { type OutcomeObservation, latestOutcomeForCycle } from "./outcome";

/**
 * Goodhart divergence guard (70 §3.4, 85 §3.5).
 *
 * A cycle is divergent when the judge score went up but the outcome signal
 * did not improve: scores rose while real acceptance/quality stayed flat or
 * fell. Two triggers pause evolution:
 *
 * - `window` consecutive divergent cycles, or
 * - a single cycle whose score rise and outcome drop both exceed the severe
 *   thresholds (a large, unambiguous divergence).
 *
 * Pausing goes through the E4 freeze switch (`kind: "divergence"`), so it is a
 * hard stop checked before any model call.
 */
export interface DivergencePoint {
  cycleId: string;
  createdAt: string;
  /** Candidate score minus baseline score for the cycle. */
  scoreDelta: number;
  /** Outcome score change versus the previous reviewed cycle (0 for the first). */
  outcomeDelta: number;
  outcomeScore?: number;
}

export interface DivergenceOptions {
  /** Consecutive divergent cycles that pause evolution. */
  window?: number;
  /** Minimum score rise to count as "score went up". */
  scoreRise?: number;
  /** Outcome change at or below this value counts as flat or worse. */
  outcomeFlatTolerance?: number;
  /** Single-cycle severe score rise. */
  severeScoreRise?: number;
  /** Single-cycle severe outcome drop. */
  severeOutcomeDrop?: number;
}

export interface DivergenceGuardResult {
  divergent: boolean;
  /** One severe cycle is enough on its own. */
  severe: boolean;
  /** Trailing consecutive divergent cycles. */
  streak: number;
  window: number;
  /** Number of reviewed cycles considered. */
  reviewed: number;
  /** Deltas of the most recent reviewed cycle. */
  scoreDelta: number | null;
  outcomeDelta: number | null;
  reasons: string[];
  /** Present when `divergent` is true. */
  hint?: string;
  cycleIds: string[];
}

export const DEFAULT_DIVERGENCE_WINDOW = 2;
export const DIVERGENCE_SCORE_RISE = 0.02;
export const DIVERGENCE_FLAT_TOLERANCE = 0;
export const DIVERGENCE_SEVERE_SCORE_RISE = 0.15;
export const DIVERGENCE_SEVERE_OUTCOME_DROP = 0.05;

/**
 * Builds divergence points from cycles that have a human/acceptance outcome.
 * Cycles without a score or an outcome are ignored, so an unreviewed cycle
 * never fabricates a flat outcome.
 */
export function buildDivergencePoints(
  cycles: readonly EvolutionCycleRecord[],
  outcomes: readonly OutcomeObservation[],
): DivergencePoint[] {
  const ordered = [...cycles].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const reviewed: Array<{
    cycle: EvolutionCycleRecord;
    outcome: OutcomeObservation;
  }> = [];
  for (const cycle of ordered) {
    if (cycle.baselineScore === null || cycle.candidateScore === null) {
      continue;
    }
    const outcome = latestOutcomeForCycle(outcomes, cycle.cycleId);
    if (!outcome) {
      continue;
    }
    reviewed.push({ cycle, outcome });
  }

  return reviewed.map((item, index) => {
    const previous = reviewed[index - 1];
    return {
      cycleId: item.cycle.cycleId,
      createdAt: item.cycle.createdAt,
      scoreDelta: round(
        (item.cycle.candidateScore ?? 0) - (item.cycle.baselineScore ?? 0),
      ),
      outcomeDelta: previous
        ? round(item.outcome.score - previous.outcome.score)
        : 0,
      outcomeScore: item.outcome.score,
    };
  });
}

export function divergenceGuard(
  points: readonly DivergencePoint[],
  options: DivergenceOptions = {},
): DivergenceGuardResult {
  const window = Math.max(1, options.window ?? DEFAULT_DIVERGENCE_WINDOW);
  const scoreRise = options.scoreRise ?? DIVERGENCE_SCORE_RISE;
  const flatTolerance =
    options.outcomeFlatTolerance ?? DIVERGENCE_FLAT_TOLERANCE;
  const severeScoreRise =
    options.severeScoreRise ?? DIVERGENCE_SEVERE_SCORE_RISE;
  const severeOutcomeDrop =
    options.severeOutcomeDrop ?? DIVERGENCE_SEVERE_OUTCOME_DROP;

  let streak = 0;
  let severe = false;
  const reasons: string[] = [];
  const cycleIds: string[] = [];
  for (const point of points) {
    const scoreUp = point.scoreDelta >= scoreRise;
    const outcomeFlat = point.outcomeDelta <= flatTolerance;
    const divergentPoint = scoreUp && outcomeFlat;
    const severePoint =
      point.scoreDelta >= severeScoreRise &&
      point.outcomeDelta <= -severeOutcomeDrop;

    if (divergentPoint) {
      streak += 1;
      cycleIds.push(point.cycleId);
      reasons.push(describePoint(point, severePoint));
    } else {
      streak = 0;
      cycleIds.length = 0;
      reasons.length = 0;
    }
    if (severePoint) {
      severe = true;
    }
  }

  const divergent = severe || streak >= window;
  const last = points.at(-1);
  const result: DivergenceGuardResult = {
    divergent,
    severe,
    streak,
    window,
    reviewed: points.length,
    scoreDelta: last ? last.scoreDelta : null,
    outcomeDelta: last ? last.outcomeDelta : null,
    reasons,
    cycleIds,
  };
  return divergent ? { ...result, hint: divergenceHint(result) } : result;
}

export function divergenceHint(result: DivergenceGuardResult): string {
  if (result.severe) {
    const latest = result.reasons.at(-1) ?? "score rose while outcome fell";
    return `Goodhart divergence: ${latest}; evolution auto-froze for a baseline review (70 §3.4)`;
  }
  return `${result.streak} consecutive cycles raised the score while outcomes stayed flat or fell; evolution auto-froze for a Goodhart review (70 §3.4)`;
}

export interface DivergenceSummary {
  divergent: boolean;
  severe: boolean;
  streak: number;
  window: number;
  reviewed: number;
  scoreDelta: number | null;
  outcomeDelta: number | null;
  reasons: string[];
}

export function divergenceSummary(
  result: DivergenceGuardResult,
): DivergenceSummary {
  return {
    divergent: result.divergent,
    severe: result.severe,
    streak: result.streak,
    window: result.window,
    reviewed: result.reviewed,
    scoreDelta: result.scoreDelta,
    outcomeDelta: result.outcomeDelta,
    reasons: [...result.reasons],
  };
}

function describePoint(point: DivergencePoint, severe: boolean): string {
  const score =
    point.scoreDelta >= 0
      ? `+${point.scoreDelta.toFixed(2)}`
      : point.scoreDelta.toFixed(2);
  const outcome =
    point.outcomeDelta >= 0
      ? `+${point.outcomeDelta.toFixed(2)}`
      : point.outcomeDelta.toFixed(2);
  return `${point.cycleId}: score ${score} while outcome ${outcome}${severe ? " (severe)" : ""}`;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
