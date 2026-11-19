"use client";

import { useEffect, useState } from "react";

/**
 * Re-renders the calling component on an interval so relative timestamps
 * ("working for 2m", "last updated 12s ago") stay honest without animating
 * layout. Returns `null` until mounted, which keeps SSR/hydration markup
 * stable for time-dependent text.
 */
export function useNow(intervalMs = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
