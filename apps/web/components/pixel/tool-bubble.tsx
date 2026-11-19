"use client";

import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { usePixelMotion } from "./motion-preference";

/**
 * Speech bubble above an agent for a `tool.call` (97 §3.2).
 *
 * Shown for a fixed reading window after the cue and stepped in with
 * transform/opacity only. The tool name itself is the payload; the bubble is
 * decorative for assistive tech because the roster already announces state.
 */
export const TOOL_BUBBLE_MS = 2600;

export function ToolBubble({
  text,
  seq,
  className,
}: {
  text: string;
  /** Cue sequence; any change restarts the visible window. */
  seq: number;
  className?: string;
}) {
  const { enabled } = usePixelMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (seq <= 0) {
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), TOOL_BUBBLE_MS);
    return () => clearTimeout(timer);
  }, [seq]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap border border-zinc-600 bg-[#f4f8fc] px-1.5 py-0.5 font-mono text-[9px] leading-tight text-[#0b1220] shadow-[2px_2px_0_rgba(0,0,0,0.5)]",
        visible ? "opacity-100" : "opacity-0",
        className,
      )}
      style={{
        transform: visible
          ? "translate(-50%, -100%)"
          : "translate(-50%, calc(-100% + 4px))",
        transition: enabled
          ? "transform 160ms steps(2, end), opacity 160ms steps(2, end)"
          : "none",
      }}
    >
      <span className="block max-w-[9rem] truncate">{text}</span>
      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-[#f4f8fc]" />
    </div>
  );
}
