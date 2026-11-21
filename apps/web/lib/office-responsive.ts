/**
 * Floor/list breakpoint contract (97 §3.1).
 *
 * Below `md` the pixel grid is hidden and the text-first station list takes
 * over, so station inspection never depends on a wide screen or on the grid
 * rendering. The visibility pairs are defined once here and consumed by the
 * floor, which keeps the two surfaces complementary by construction.
 */

const FLOOR_VISIBILITY = {
  /** Interactive pixel stage: visible from `md` up only. */
  stage: "hidden md:block",
  /** Text fallback: visible below `md`, hidden once the stage appears. */
  compactList: "block md:hidden",
} as const;

export type FloorSurface = keyof typeof FLOOR_VISIBILITY;

/** Tailwind visibility pair for a floor surface (stage / compact list). */
export function floorBreakpointClass(
  surface: FloorSurface,
  extra?: string,
): string {
  const visibility = FLOOR_VISIBILITY[surface];
  return extra ? `${visibility} ${extra}` : visibility;
}
