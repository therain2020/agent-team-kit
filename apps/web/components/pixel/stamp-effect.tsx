"use client";

import type { StampOutcome } from "@/lib/pixel-events";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { PIXEL_GREEN, PIXEL_RED } from "./palette";
import { usePixelMotion } from "./use-pixel-motion";

/**
 * Gate stamp: presses once per `trigger` and leaves its mark.
 *
 * The head travels in `steps(1, end)` keyframes (the reference uses two-frame
 * stepping) and the mark is plain DOM state, so turning motion off still
 * shows pass/fail — it just appears without the press animation.
 */
export function StampEffect({
  trigger,
  outcome,
  pressed = false,
  className,
}: {
  /** Monotonic cue sequence; any change replays the press once. */
  trigger: number;
  outcome: StampOutcome;
  /** Lower the head while work is waiting at the gate. */
  pressed?: boolean;
  className?: string;
}) {
  const t = useTranslations("motion");
  const { enabled } = usePixelMotion();
  const headRef = useRef<HTMLDivElement | null>(null);
  const [mark, setMark] = useState<StampOutcome | null>(null);

  useEffect(() => {
    if (trigger <= 0) {
      return;
    }
    setMark(outcome);
    const element = headRef.current;
    if (!enabled || !element || typeof element.animate !== "function") {
      return;
    }
    const animation = element.animate(
      [
        { transform: "translateY(-6px)" },
        { transform: "translateY(8px)" },
        { transform: "translateY(4px)" },
        { transform: "translateY(0)" },
      ],
      { duration: 460, easing: "steps(1, end)" },
    );
    return () => animation.cancel();
  }, [trigger, outcome, enabled]);

  const accent = mark === "failed" ? PIXEL_RED : PIXEL_GREEN;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none flex flex-col items-center select-none",
        className,
      )}
    >
      <div className="h-2 w-16 bg-[#33425c]" />
      <div className="flex h-8 w-12 justify-center border-x border-[#2b3a55]">
        <div
          ref={headRef}
          data-state={pressed ? "pressed" : "resting"}
          className="mt-1 h-6 w-8 border border-[#33425c] bg-[#8492a8]"
          style={{
            transform: pressed ? "translateY(4px)" : "translateY(0)",
            boxShadow: "inset 0 -4px 0 #5c6a80",
          }}
        />
      </div>
      <div
        data-state={mark ?? "idle"}
        className={cn(
          "flex h-6 w-14 items-center justify-center border text-[9px] font-bold uppercase tracking-widest",
          mark === "failed"
            ? "border-red-500/60 bg-red-500/10 text-red-300"
            : mark === "passed"
              ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
              : "border-zinc-800 text-zinc-700",
        )}
        style={{
          transition: enabled ? "opacity 140ms steps(2, end)" : "none",
          color: mark ? accent : undefined,
        }}
      >
        {mark === "failed"
          ? t("stampFailed")
          : mark === "passed"
            ? t("stampPassed")
            : "—"}
      </div>
    </div>
  );
}
