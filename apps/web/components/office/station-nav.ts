/**
 * Pure navigation math for the roving-tabindex station grid (97 §3.1).
 *
 * Kept out of React so the wrap/boundary rules are unit-testable: arrows move
 * one station at a time and wrap, Home/End jump to the edges, and an unknown
 * active id starts at the first station going forward, last going backward.
 */
export function stepStationId(
  ids: readonly string[],
  activeId: string | null,
  delta: -1 | 1,
): string | null {
  if (ids.length === 0) {
    return null;
  }
  const index = activeId ? ids.indexOf(activeId) : -1;
  if (index < 0) {
    return delta > 0 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  }
  const next = (index + delta + ids.length) % ids.length;
  return ids[next] ?? null;
}

export function edgeStationId(
  ids: readonly string[],
  edge: "first" | "last",
): string | null {
  return edge === "first" ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
}

/**
 * Exactly one station is in the tab order: the active one, or the first
 * station when nothing is selected yet.
 */
export function rovingTabIndex(
  id: string,
  activeId: string | null,
  index: number,
): 0 | -1 {
  if (activeId) {
    return id === activeId ? 0 : -1;
  }
  return index === 0 ? 0 : -1;
}
