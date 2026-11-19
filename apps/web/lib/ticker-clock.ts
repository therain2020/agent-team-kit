/**
 * Pure game-clock math behind `useTicker` (see use-ticker.ts for the hook).
 *
 * Kept DOM-free so it typechecks and unit-tests outside the browser bundle.
 * One tick is `minutesPerTick` game minutes; `advanceClock` consumes only whole
 * ticks and leaves the remainder on the phase, which makes the tick count
 * independent of frame cadence (no `setInterval` drift).
 */

export const DEFAULT_MINUTES_PER_TICK = 2;
/** Wall-clock milliseconds per tick at 1×. */
export const DEFAULT_MS_PER_TICK = 1200;
export const SPEED_STEPS = [0.5, 1, 2, 4] as const;

export interface ClockPhase {
  tick: number;
  /** Timestamp (performance.now) of the start of the current tick. */
  baseMs: number;
}

export function createClockPhase(nowMs: number, tick = 0): ClockPhase {
  return { tick, baseMs: nowMs };
}

/**
 * Advances the phase to `nowMs` and returns whole ticks owed by elapsed time.
 * The returned `baseMs` moves only by the time covered by whole ticks, so the
 * unconsumed fraction carries over instead of accumulating drift.
 */
export function advanceClock(
  phase: ClockPhase,
  nowMs: number,
  msPerTick: number,
  speed: number,
): ClockPhase {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(phase.baseMs) ||
    msPerTick <= 0 ||
    !Number.isFinite(speed) ||
    speed <= 0
  ) {
    return phase;
  }
  const elapsed = (nowMs - phase.baseMs) * speed;
  const due = Math.floor(elapsed / msPerTick);
  if (due <= 0) {
    return phase;
  }
  return {
    tick: phase.tick + due,
    baseMs: phase.baseMs + (due * msPerTick) / speed,
  };
}

export function quantizeGameMinutes(
  tick: number,
  minutesPerTick: number,
): number {
  return Math.max(0, Math.trunc(tick)) * minutesPerTick;
}
