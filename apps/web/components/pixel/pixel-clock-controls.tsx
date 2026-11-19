"use client";

import { SPEED_STEPS, type Ticker } from "@/lib/use-ticker";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { PixelMotionToggle } from "./motion-preference";

/**
 * Compact controls for the shared game clock: tick readout, play/pause,
 * speed and the persisted motion toggle. The clock runs only on demand or
 * when data pulses it, so pausing leaves the scene exactly as the events
 * last described it.
 */
export function PixelClockControls({
  ticker,
  className,
}: {
  ticker: Ticker;
  className?: string;
}) {
  const t = useTranslations("motion");
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1 font-mono text-[9px] uppercase text-zinc-500",
        className,
      )}
    >
      <span
        className="border border-zinc-800 bg-zinc-950 px-1.5 py-1 tabular-nums"
        title={t("clockHint")}
      >
        {t("clock", { tick: ticker.tick, minutes: ticker.gameMinutes })}
      </span>
      <button
        type="button"
        onClick={ticker.toggle}
        aria-pressed={ticker.playing}
        aria-label={ticker.playing ? t("pause") : t("play")}
        className="border border-zinc-700 bg-zinc-950 px-1.5 py-1 uppercase hover:border-zinc-500 hover:text-zinc-200"
      >
        {ticker.playing ? t("pause") : t("play")}
      </button>
      {SPEED_STEPS.filter((speed) => speed >= 1).map((speed) => (
        <button
          key={speed}
          type="button"
          onClick={() => ticker.setSpeed(speed)}
          aria-pressed={ticker.speed === speed}
          aria-label={t("speed", { speed })}
          className={cn(
            "border px-1 py-1 uppercase",
            ticker.speed === speed
              ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
              : "border-zinc-800 text-zinc-600 hover:border-zinc-600 hover:text-zinc-300",
          )}
        >
          {speed}×
        </button>
      ))}
      <PixelMotionToggle />
    </div>
  );
}
