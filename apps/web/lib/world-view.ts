import type { RunProjection } from "@kit/store";

/**
 * Pure derivations for the `/world` surface (82 §4.1).
 *
 * Rows come from the shared world store (`world-state.ts`, fed by
 * `/api/world` + `/api/world/stream`); everything here turns those rows into
 * the one-layer view — 进行中 / 需要你 / 今天 — without touching the network,
 * so the classification is unit-testable and identical across re-renders.
 */

export type WorldRunKind = "run" | "iteration";
export type WorldKindFilter = "all" | WorldRunKind;

/** `RunProjection` already carries every field the surface renders. */
export type WorldRunView = RunProjection;

export interface WorldRunMeta {
  kind: WorldRunKind;
  startedAt: string | null;
}

export type WorldRunMetaMap = Record<string, WorldRunMeta>;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function byUpdatedDesc(a: WorldRunView, b: WorldRunView): number {
  return (
    b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId)
  );
}

/** Iteration ids are minted as `it_<ulid>`; metadata wins when present. */
export function runKind(metas: WorldRunMetaMap, runId: string): WorldRunKind {
  return metas[runId]?.kind ?? (runId.startsWith("it_") ? "iteration" : "run");
}

export interface WorldSplit {
  /** Running or queued jobs, newest activity first. */
  inProgress: WorldRunView[];
  /** Paused first (approvals, budgets), then failed — exception-first. */
  needsYou: WorldRunView[];
  /** Jobs whose metadata says they started after local midnight. */
  startedToday: WorldRunView[];
  finishedToday: WorldRunView[];
  /** `null` when nothing finished yet today. */
  passRate: number | null;
  spendToday: number;
  tokensToday: number;
  artifactCountToday: number;
}

export function splitWorldRuns(
  runs: readonly WorldRunView[],
  metas: WorldRunMetaMap,
  nowMs: number,
): WorldSplit {
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  const startedToday = runs.filter((run) => {
    const startedAt = metas[run.runId]?.startedAt;
    if (!startedAt) {
      return false;
    }
    const startedMs = new Date(startedAt).getTime();
    return Number.isFinite(startedMs) && startedMs >= dayStartMs;
  });

  const finishedToday = startedToday
    .filter((run) => isTerminalStatus(run.status))
    .sort(byUpdatedDesc);

  const succeededToday = finishedToday.filter(
    (run) => run.status === "succeeded",
  ).length;

  const inProgress = runs
    .filter((run) => run.status === "running" || run.status === "queued")
    .sort(byUpdatedDesc);

  const needsYou = runs
    .filter((run) => run.status === "paused" || run.status === "failed")
    .sort((a, b) => {
      const rank =
        Number(b.status === "paused") - Number(a.status === "paused");
      return rank || byUpdatedDesc(a, b);
    });

  return {
    inProgress,
    needsYou,
    startedToday,
    finishedToday,
    passRate:
      finishedToday.length > 0
        ? Math.round((succeededToday / finishedToday.length) * 100)
        : null,
    spendToday: startedToday.reduce((sum, run) => sum + run.costCny, 0),
    tokensToday: startedToday.reduce((sum, run) => sum + run.tokens, 0),
    artifactCountToday: startedToday.reduce(
      (sum, run) => sum + run.artifactCount,
      0,
    ),
  };
}

/** Progress ratio (0–1) rendered as an integer percentage, never negative. */
export function progressPercent(run: WorldRunView): number {
  const value = Number.isFinite(run.progress) ? run.progress : 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}
