"use client";

import { useSyncExternalStore } from "react";
import {
  type WorldClientState,
  type WorldDelta,
  type WorldSnapshotResult,
  applyWorldDelta,
  applyWorldSnapshot,
  initialWorldState,
  reconnectDelay,
} from "./world-state";

/**
 * Shared world subscription (97 §3.2, 97.6).
 *
 * One `EventSource` per tab: every surface (office floor, factory line) calls
 * `useWorld()` and they all share this module-level store. The first subscriber
 * opens the stream, the last one closes it. On disconnect the client reconnects
 * with exponential backoff and resumes from the last applied `seq`; a full
 * snapshot resync happens on first load, network recovery and visibility
 * recovery. Nothing here mutates server state — the stream is the single source
 * of truth and wins over optimistic local edits.
 */

const SNAPSHOT_URL = "/api/world";
const STREAM_URL = "/api/world/stream";
/** After this many consecutive failures the pill says "offline" (still retrying). */
const OFFLINE_AFTER_ATTEMPTS = 4;

let state: WorldClientState = initialWorldState;
const listeners = new Set<() => void>();
let generation = 0;
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let running = false;

function setState(next: WorldClientState): void {
  if (next === state) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getWorldState(): WorldClientState {
  return state;
}

function getServerWorldState(): WorldClientState {
  return initialWorldState;
}

export function subscribeWorld(listener: () => void): () => void {
  listeners.add(listener);
  if (!running) {
    running = true;
    start();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && running) {
      running = false;
      stop();
    }
  };
}

/** React binding: `{ world, seq, status, lastUpdatedAt }` (97.6 acceptance). */
export function useWorld(): WorldClientState {
  return useSyncExternalStore(
    subscribeWorld,
    getWorldState,
    getServerWorldState,
  );
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function closeStream(): void {
  if (!source) {
    return;
  }
  source.close();
  source = null;
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function start(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  document.addEventListener("visibilitychange", handleVisibility);
  void resync();
}

function stop(): void {
  generation += 1;
  closeStream();
  clearRetry();
  attempt = 0;
  if (typeof window === "undefined") {
    return;
  }
  window.removeEventListener("online", handleOnline);
  window.removeEventListener("offline", handleOffline);
  document.removeEventListener("visibilitychange", handleVisibility);
}

function handleOnline(): void {
  attempt = 0;
  reconnectNow();
}

function handleOffline(): void {
  if (state.status !== "offline") {
    setState({ ...state, status: "offline", error: "network offline" });
  }
}

function handleVisibility(): void {
  if (document.visibilityState !== "visible") {
    return;
  }
  if (state.status !== "live") {
    reconnectNow();
  }
}

function reconnectNow(): void {
  generation += 1;
  closeStream();
  clearRetry();
  if (!state.world) {
    void resync();
    return;
  }
  openStream(generation);
}

/**
 * Fetches a fresh snapshot, then resumes the stream at the snapshot cursor.
 * Also used for the first load so the stream never replays history.
 */
async function resync(): Promise<void> {
  const gen = ++generation;
  closeStream();
  clearRetry();
  setState({ ...state, status: "reconnecting", error: null });

  try {
    const response = await fetch(SNAPSHOT_URL, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as WorldSnapshotResult;
    if (gen !== generation) {
      return;
    }
    setState(applyWorldSnapshot(state, payload));
    openStream(gen);
  } catch (error) {
    if (gen !== generation) {
      return;
    }
    fail(gen, true, error instanceof Error ? error.message : String(error));
  }
}

function openStream(gen: number): void {
  if (gen !== generation || typeof window === "undefined") {
    return;
  }
  closeStream();
  const params = new URLSearchParams({ after: String(state.seq) });
  const next = new EventSource(`${STREAM_URL}?${params.toString()}`);
  source = next;

  next.addEventListener("open", () => {
    if (gen !== generation) {
      return;
    }
    attempt = 0;
    setState({ ...state, status: "live", error: null });
  });

  next.addEventListener("world", (event) => {
    if (gen !== generation) {
      return;
    }
    try {
      const delta = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as WorldDelta;
      attempt = 0;
      setState(applyWorldDelta(state, delta));
    } catch {
      // Ignore malformed frames; the next delta or resync corrects the world.
    }
  });

  next.addEventListener("error", () => {
    if (gen !== generation) {
      return;
    }
    fail(gen, false, "connection lost");
  });
}

/**
 * Marks the connection degraded and schedules a retry. `snapshot` controls
 * whether the retry re-reads the snapshot (needed when the stream never opened)
 * or just resumes from the last applied seq.
 */
function fail(gen: number, snapshot: boolean, message: string): void {
  if (gen !== generation) {
    return;
  }
  closeStream();
  attempt += 1;
  const offline = !isOnline() || attempt >= OFFLINE_AFTER_ATTEMPTS;
  setState({
    ...state,
    status: offline ? "offline" : "reconnecting",
    error: message,
  });
  scheduleRetry(gen, snapshot);
}

function scheduleRetry(gen: number, snapshot: boolean): void {
  clearRetry();
  const delay = reconnectDelay(attempt - 1);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (gen !== generation || !running) {
      return;
    }
    if (!isOnline()) {
      // Stay offline and keep a capped retry; the `online` event fires sooner.
      scheduleRetry(gen, snapshot);
      return;
    }
    if (snapshot || !state.world) {
      void resync();
      return;
    }
    openStream(gen);
  }, delay);
}
