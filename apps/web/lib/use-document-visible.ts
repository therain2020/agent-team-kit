"use client";

import { useEffect, useState } from "react";

/**
 * Tracks `document.visibilityState` so pixel surfaces can freeze their clock
 * and transforms while the tab is hidden (issue #156). Live data keeps
 * updating; only the animation stops.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  return visible;
}
