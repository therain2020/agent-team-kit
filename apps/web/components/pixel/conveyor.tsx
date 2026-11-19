"use client";

import { cn } from "@/lib/utils";
import { type RefObject, useEffect, useRef, useState } from "react";
import { usePixelMotion } from "./use-pixel-motion";

/**
 * Conveyor belt whose treads step on the shared clock.
 *
 * `tick % 4` advances the chevron row by `CONVEYOR_STEP_PX`; the offset is a
 * `transform` so stepping never touches layout. A paused clock means a still
 * belt — there is no CSS keyframe animation anywhere in this primitive.
 */
export const CONVEYOR_STEP_PX = 8;
export const CONVEYOR_PHASE_TICKS = 4;
export const CONVEYOR_SPACING_PX = 34;
export const REVERSE_MS = 1500;

export function conveyorOffset(tick: number, reversed = false): number {
  const wrapped =
    ((Math.trunc(tick) % CONVEYOR_PHASE_TICKS) + CONVEYOR_PHASE_TICKS) %
    CONVEYOR_PHASE_TICKS;
  const offset = wrapped * CONVEYOR_STEP_PX;
  return reversed ? offset : -offset;
}

const CHEVRON_FORWARD =
  "polygon(0 0, 62% 50%, 0 100%, 34% 100%, 96% 50%, 34% 0)";
const CHEVRON_REVERSE =
  "polygon(100% 0, 38% 50%, 100% 100%, 66% 100%, 4% 50%, 66% 0)";
/** Stable tread ids: the pattern scrolls, the nodes never reorder. */
const CHEVRON_IDS = Array.from({ length: 22 }, (_, index) => `tread-${index}`);

export function ConveyorBelt({
  tick,
  reversed = false,
  chevrons = 22,
  className,
  height = 12,
}: {
  tick: number;
  reversed?: boolean;
  chevrons?: number;
  className?: string;
  height?: number;
}) {
  const offset = conveyorOffset(tick, reversed);
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none relative overflow-hidden", className)}
      style={{ height }}
    >
      <div className="absolute inset-0 bg-[#151d2b]" />
      <div className="absolute inset-x-0 top-0 h-px bg-[#3a4a63]" />
      <div className="absolute inset-x-0 bottom-0 h-px bg-[#0b1220]" />
      <div
        className="absolute left-0 top-1/2"
        style={{
          transform: `translate3d(${offset}px, -50%, 0)`,
          willChange: "transform",
        }}
      >
        {CHEVRON_IDS.slice(0, chevrons).map((id) => (
          <span
            key={id}
            className="inline-block bg-[#263244]"
            style={{
              width: CONVEYOR_SPACING_PX,
              height: 6,
              marginRight: CONVEYOR_SPACING_PX / 2,
              clipPath: reversed ? CHEVRON_REVERSE : CHEVRON_FORWARD,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Belt state for a rollback. The reverse window is a visual timer only
 * (`REVERSE_MS`); data state has already been applied by the caller, so
 * reduced motion simply shows the belt end-state.
 */
export function useConveyorReverse(trigger: number, ms = REVERSE_MS): boolean {
  const { enabled } = usePixelMotion();
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (trigger <= 0 || !enabled) {
      setActive(false);
      return;
    }
    setActive(true);
    const timer = setTimeout(() => setActive(false), ms);
    return () => clearTimeout(timer);
  }, [trigger, ms, enabled]);

  return active;
}

export function ConveyorReverse({
  trigger,
  tick,
  className,
  height,
}: {
  trigger: number;
  tick: number;
  className?: string;
  height?: number;
}) {
  const reversed = useConveyorReverse(trigger);
  return (
    <div className={cn("relative", className)} data-reversed={reversed}>
      <ConveyorBelt
        tick={tick}
        reversed={reversed}
        height={height}
        className={cn(reversed && "brightness-125 saturate-150")}
      />
      {reversed ? (
        <span className="absolute right-1 top-0 h-px w-6 bg-red-400/80" />
      ) : null}
    </div>
  );
}

/**
 * One-shot gate shake on a failing stamp. Mirrors the reference's
 * `steps(2)` 380ms shake; skipped entirely when motion is off.
 */
export function useShake<T extends HTMLElement>(
  trigger: number,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const { enabled } = usePixelMotion();

  useEffect(() => {
    const element = ref.current;
    if (!element || trigger <= 0 || !enabled) {
      return;
    }
    if (typeof element.animate !== "function") {
      return;
    }
    const animation = element.animate(
      [
        { transform: "translate3d(0, 0, 0)" },
        { transform: "translate3d(-5px, 2px, 0)" },
        { transform: "translate3d(4px, -2px, 0)" },
        { transform: "translate3d(-2px, 1px, 0)" },
        { transform: "translate3d(0, 0, 0)" },
      ],
      { duration: 380, easing: "steps(1, end)" },
    );
    return () => animation.cancel();
  }, [trigger, enabled]);

  return ref;
}
