"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ClockPhase,
  DEFAULT_MINUTES_PER_TICK,
  DEFAULT_MS_PER_TICK,
  advanceClock,
  createClockPhase,
  quantizeGameMinutes,
} from "./ticker-clock";

/**
 * Quantized game clock for the pixel surfaces (89 §3.2, 97 §3.2).
 *
 * The clock is a tick counter, never a per-frame animation timer: one tick is
 * `minutesPerTick` game minutes (default 2) and is the smallest unit any
 * motion is allowed to step on. Playback uses `requestAnimationFrame` against
 * a monotonic phase (see ticker-clock.ts), so dropped frames are caught up
 * exactly once instead of drifting like `setInterval`.
 *
 * Data alignment: world/activity deltas call `pulse()` which advances the
 * counter immediately. With no events and nothing playing the counter does
 * not move, so every animation derived from it is still (issue #166).
 */

export type { ClockPhase } from "./ticker-clock";
export {
  DEFAULT_MINUTES_PER_TICK,
  DEFAULT_MS_PER_TICK,
  SPEED_STEPS,
  advanceClock,
  createClockPhase,
  quantizeGameMinutes,
} from "./ticker-clock";

export interface TickerOptions {
  /** Game minutes represented by one tick. Defaults to 2. */
  minutesPerTick?: number;
  /** Wall-clock milliseconds per tick at 1×. Defaults to 1200. */
  msPerTick?: number;
  /** Start the clock on mount. Data pulses work while paused. */
  playing?: boolean;
  /** Initial speed multiplier. */
  speed?: number;
}

export interface Ticker {
  tick: number;
  gameMinutes: number;
  playing: boolean;
  speed: number;
  minutesPerTick: number;
  msPerTick: number;
  setPlaying: (playing: boolean) => void;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  /** Steps the clock forward immediately — driven by data, not time. */
  pulse: (count?: number) => void;
  reset: () => void;
}

export function useTicker(options: TickerOptions = {}): Ticker {
  const minutesPerTick = options.minutesPerTick ?? DEFAULT_MINUTES_PER_TICK;
  const msPerTick = options.msPerTick ?? DEFAULT_MS_PER_TICK;
  const [tick, setTick] = useState(0);
  const [playing, setPlayingState] = useState(options.playing ?? false);
  const [speed, setSpeedState] = useState(options.speed ?? 1);

  const tickRef = useRef(0);
  const phaseRef = useRef<ClockPhase | null>(null);

  const publish = useCallback((next: number) => {
    tickRef.current = next;
    if (phaseRef.current) {
      phaseRef.current = { ...phaseRef.current, tick: next };
    }
    setTick(next);
  }, []);

  const pulse = useCallback(
    (count = 1) => {
      const step = Math.max(1, Math.trunc(count));
      publish(tickRef.current + step);
    },
    [publish],
  );

  const reset = useCallback(() => {
    phaseRef.current = null;
    publish(0);
  }, [publish]);

  const setPlaying = useCallback((next: boolean) => {
    setPlayingState(next);
  }, []);

  const toggle = useCallback(() => {
    setPlayingState((current) => !current);
  }, []);

  const setSpeed = useCallback((next: number) => {
    if (Number.isFinite(next) && next > 0) {
      setSpeedState(next);
    }
  }, []);

  useEffect(() => {
    if (!playing || typeof window === "undefined") {
      return;
    }
    phaseRef.current = createClockPhase(performance.now(), tickRef.current);
    let frame = 0;
    const step = () => {
      const phase = phaseRef.current;
      if (phase) {
        const next = advanceClock(phase, performance.now(), msPerTick, speed);
        if (next.tick !== phase.tick) {
          phaseRef.current = next;
          tickRef.current = next.tick;
          setTick(next.tick);
        }
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);

    // A background tab stops rAF; re-anchor on return instead of replaying
    // minutes of catch-up ticks in one burst.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        phaseRef.current = createClockPhase(performance.now(), tickRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [playing, speed, msPerTick]);

  return {
    tick,
    gameMinutes: quantizeGameMinutes(tick, minutesPerTick),
    playing,
    speed,
    minutesPerTick,
    msPerTick,
    setPlaying,
    toggle,
    setSpeed,
    pulse,
    reset,
  };
}
