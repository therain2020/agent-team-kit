"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalTowerSnapshot } from "./inbox-shared";

export interface ApprovalQueueState {
  snapshot: ApprovalTowerSnapshot;
  refreshing: boolean;
  error: string | null;
  /** Advances on every poll so the SLA buckets re-render with fresh time. */
  now: number;
  refresh: () => Promise<void>;
}

/**
 * Polls the approval tower read model. Kept deliberately small so the polling
 * source can be swapped for the #138 world stream once it lands: components
 * only depend on the returned snapshot and refresh callback.
 */
export function useApprovalQueue(
  initial: ApprovalTowerSnapshot,
  intervalMs = 8000,
): ApprovalQueueState {
  const [snapshot, setSnapshot] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Seed from the server timestamp so SSR and hydration bucket identically;
  // the mount effect then switches to the live clock.
  const [now, setNow] = useState(() => Date.parse(initial.generatedAt) || 0);
  const inFlight = useRef<AbortController | null>(null);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      // A poll may already be in flight with pre-mutation data; queue one more
      // pass so a decision/takeover never gets overwritten by a stale poll.
      refreshQueued.current = true;
      return;
    }
    do {
      refreshQueued.current = false;
      const controller = new AbortController();
      inFlight.current = controller;
      setRefreshing(true);
      try {
        const response = await fetch("/api/inbox/queue", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as
          | ApprovalTowerSnapshot
          | { error?: string };
        if (!response.ok || !("approvals" in payload)) {
          throw new Error(
            "error" in payload && payload.error
              ? payload.error
              : `request failed (${response.status})`,
          );
        }
        setSnapshot(payload);
        setError(null);
        setNow(Date.now());
      } catch (problem) {
        if (controller.signal.aborted) {
          break;
        }
        setError(problem instanceof Error ? problem.message : "refresh failed");
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
        }
      }
    } while (refreshQueued.current);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = (immediate: boolean) => {
      if (timer !== null || document.visibilityState !== "visible") {
        return;
      }
      if (immediate) {
        void refresh();
      }
      timer = setInterval(() => void refresh(), intervalMs);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        start(true);
      } else {
        stop();
      }
    };

    // The server already rendered a fresh snapshot; don't refetch on mount.
    start(false);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [intervalMs, refresh]);

  useEffect(() => {
    setNow(Date.now());
    const ticker = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(ticker);
  }, []);

  return { snapshot, refreshing, error, now, refresh };
}
