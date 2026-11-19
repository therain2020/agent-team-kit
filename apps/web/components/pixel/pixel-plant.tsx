import { cn } from "@/lib/utils";
import { PIXEL_GREEN, PIXEL_INK } from "./palette";

/**
 * Potted-plant sprite. Purely decorative — it never carries data, so it is
 * hidden from assistive tech and has no motion of its own.
 */
export function PixelPlant({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
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
      <rect x="3" y="12" width="10" height="3" fill="#7a4b2a" />
      <rect x="3" y="12" width="10" height="1" fill="#a06a3d" />
      <rect x="5" y="11" width="6" height="1" fill={PIXEL_INK} opacity="0.4" />
      <rect x="7" y="8" width="2" height="4" fill="#2f7d4f" />
      <rect x="4" y="6" width="3" height="3" fill={PIXEL_GREEN} />
      <rect x="9" y="5" width="3" height="4" fill={PIXEL_GREEN} />
      <rect x="6" y="3" width="3" height="3" fill="#2f7d4f" />
      <rect x="11" y="8" width="2" height="2" fill="#2f7d4f" />
      <rect x="3" y="9" width="2" height="2" fill="#2f7d4f" />
    </svg>
  );
}
