"use client";

import { useEffect, useRef, useState } from "react";
import type { LiveAgent } from "./office-live";
import {
  type PresenceMap,
  applyPresence,
  pixelStateFromStatus,
} from "./pixel-events";

/**
 * Per-agent sprite presence with the 500ms switch throttle from 97 §3.2.
 *
 * Status text always reflects the projection immediately; only the animated
 * sprite lags a burst, so a token/tool storm cannot strobe the floor. The
 * throttle is memory-based and shared by every station via the returned map.
 */
export function useThrottledPresence(
  agents: readonly LiveAgent[],
  minInterval?: number,
): PresenceMap {
  const [presence, setPresence] = useState<PresenceMap>({});
  const seeded = useRef(false);
  useEffect(() => {
    const now = Date.now();
    setPresence((current) => {
      let next = current;
      for (const agent of agents) {
        const state = pixelStateFromStatus(agent.status);
        if (!seeded.current) {
          // The first projection is the baseline: never throttle it, or a
          // freshly mounted floor could sit idle for 500ms while work runs.
          next = { ...next, [agent.id]: { state, at: now } };
        } else {
          next = applyPresence(next, agent.id, state, now, minInterval);
        }
      }
      seeded.current = true;
      return next;
    });
  }, [agents, minInterval]);
  return presence;
}
