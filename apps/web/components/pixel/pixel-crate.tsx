import { cn } from "@/lib/utils";
import { PIXEL_AMBER, PIXEL_GREEN, PIXEL_RED } from "./palette";

export type CrateTone = "low" | "medium" | "high" | "bad";

const ACCENT: Record<CrateTone, string> = {
  low: PIXEL_GREEN,
  medium: PIXEL_AMBER,
  high: PIXEL_RED,
  bad: PIXEL_RED,
};

/**
 * Artifact crate riding the conveyor. Tone mirrors the factory risk palette;
 * `bad` is a failed/blocked piece with a little smoke stack.
 */
export function PixelCrate({
  tone = "low",
  size = 28,
  selected = false,
  className,
}: {
  tone?: CrateTone;
  size?: number;
  selected?: boolean;
  className?: string;
}) {
  const accent = ACCENT[tone];
  const bad = tone === "bad" || tone === "high";
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <rect x="2" y="14" width="12" height="1" fill="#000" opacity="0.4" />
      <rect x="2" y="4" width="12" height="10" fill="#3f3f46" />
      <rect x="2" y="4" width="12" height="1" fill="#71717a" />
      <rect x="2" y="13" width="12" height="1" fill="#27272a" />
      <rect x="2" y="4" width="1" height="10" fill="#52525b" />
      <rect x="13" y="4" width="1" height="10" fill="#18181b" />
      <rect x="2" y="7" width="12" height="2" fill={accent} opacity="0.85" />
      <rect x="4" y="9" width="1" height="4" fill="#52525b" />
      <rect x="11" y="5" width="1" height="4" fill="#52525b" />
      {bad ? (
        <>
          <rect x="5" y="1" width="6" height="1" fill={accent} />
          <rect x="6" y="0" width="4" height="1" fill={accent} opacity="0.6" />
        </>
      ) : (
        <rect x="7" y="2" width="2" height="1" fill="#a1a1aa" opacity="0.5" />
      )}
      {selected ? (
        <rect
          x="0.5"
          y="2.5"
          width="15"
          height="13"
          fill="none"
          stroke={accent}
          strokeWidth="1"
          shapeRendering="crispEdges"
        />
      ) : null}
    </svg>
  );
}
