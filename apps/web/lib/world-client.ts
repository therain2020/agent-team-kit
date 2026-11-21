"use client";

import { useSyncExternalStore } from "react";
import {
  WORLD_BATCH_MS,
  type WorldClientState,
  type WorldDelta,
  type WorldSnapshotResult,
  applyWorldDelta,
  applyWorldSnapshot,
  initialWorldState,
  mergeDeltas,
  pushWorldDelta,
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
/** Snapshot polling cadence when SSE cannot be established (97 §3.2). */
const POLL_MS = 5_000;
/** Retry SSE occasionally while polling so a recovered server goes live again. */
const POLL_SSE_RETRY_MS = 30_000;
/** Stream failures without a single opened frame before polling takes over. */
const POLL_AFTER_ATTEMPTS = 2;

let state: WorldClientState = initialWorldState;
const listeners = new Set<() => void>();
let generation = 0;
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let running = false;
/** Deltas buffered for the current 250ms batch window. */
let queue: WorldDelta[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let queueDegraded = false;
let polling = false;
let pollFailures = 0;
let pollInFlight = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollSseTimer: ReturnType<typeof setInterval> | null = null;

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

/** Drops any buffered deltas; used on disconnect and fresh snapshots. */
function resetQueue(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  queue = [];
  queueDegraded = false;
}

/** Buffers a delta for the 250ms batch; the oldest events drop past the cap. */
function enqueueDelta(delta: WorldDelta, gen: number): void {
  const pushed = pushWorldDelta(queue, delta);
  queue = pushed.queue;
  if (pushed.dropped > 0) {
    queueDegraded = true;
  }
  if (flushTimer) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (gen !== generation) {
      queue = [];
      queueDegraded = false;
      return;
    }
    if (queue.length === 0) {
      return;
    }
    const merged = mergeDeltas(queue);
    const degraded = queueDegraded;
    queue = [];
    queueDegraded = false;
    const applied = applyWorldDelta(state, merged);
    if (applied === state) {
      return;
    }
    setState(degraded ? { ...applied, degraded: true } : applied);
  }, WORLD_BATCH_MS);
}

function start(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  document.addEventListener("visibilitychange", handleVisibility);
  if (typeof EventSource === "undefined") {
    // No SSE in this environment: poll snapshots instead of failing silently.
    startPolling(generation);
    return;
  }
  void resync();
}

function stop(): void {
  generation += 1;
  closeStream();
  clearRetry();
  stopPolling();
  resetQueue();
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
  stopPolling();
  // Recovered network: a fresh snapshot is authoritative, then stream resumes.
  void resync();
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
  if (polling) {
    void pollOnce(generation);
    return;
  }
  // Coming back to a hidden tab resyncs the snapshot before resuming (§3.2).
  attempt = 0;
  void resync();
}

/**
 * Snapshot polling fallback: used when SSE is unavailable or never opens. The
 * floor sees `polling` instead of a dead `live`, keeps the last snapshot and
 * retries the stream every 30s so a recovered server goes live again.
 */
function startPolling(gen: number): void {
  if (polling) {
    return;
  }
  polling = true;
  pollFailures = 0;
  closeStream();
  clearRetry();
  resetQueue();
  setState({ ...state, status: "polling", error: state.error });
  void pollOnce(gen);
  pollSseTimer = setInterval(() => {
    if (gen === generation && polling) {
      openStream(gen);
    }
  }, POLL_SSE_RETRY_MS);
}

function stopPolling(): void {
  polling = false;
  pollInFlight = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (pollSseTimer) {
    clearInterval(pollSseTimer);
    pollSseTimer = null;
  }
}

async function pollOnce(gen: number): Promise<void> {
  if (gen !== generation || !polling || pollInFlight) {
    return;
  }
  pollInFlight = true;
  try {
    const response = await fetch(SNAPSHOT_URL, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = (await response.json()) as WorldSnapshotResult;
    if (gen !== generation || !polling) {
      return;
    }
    pollFailures = 0;
    setState(applyWorldSnapshot(state, payload));
    attempt = 0;
  } catch (error) {
    if (gen !== generation || !polling) {
      return;
    }
    pollFailures += 1;
    const offline = !isOnline() || pollFailures >= OFFLINE_AFTER_ATTEMPTS;
    setState({
      ...state,
      status: offline ? "offline" : "polling",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    pollInFlight = false;
    if (gen === generation && polling) {
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void pollOnce(gen);
      }, POLL_MS);
    }
  }
}

/**
 * Fetches a fresh snapshot, then resumes the stream at the snapshot cursor.
 * Also used for the first load so the stream never replays history.
 */
async function resync(): Promise<void> {
  const gen = ++generation;
  closeStream();
  clearRetry();
  stopPolling();
  resetQueue();
  // Keep "live"/"polling" while a recovery snapshot is in flight; a failure
  // below still demotes the pill.
  setState({
    ...state,
    status: state.world ? state.status : "reconnecting",
    error: null,
  });

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
    fail(gen, error instanceof Error ? error.message : String(error));
  }
}

function openStream(gen: number): void {
  if (gen !== generation || typeof window === "undefined") {
    return;
  }
  if (typeof EventSource === "undefined") {
    startPolling(gen);
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
    stopPolling();
    attempt = 0;
    pollFailures = 0;
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
      enqueueDelta(delta, gen);
    } catch {
      // Ignore malformed frames; the next delta or resync corrects the world.
    }
  });

  next.addEventListener("error", () => {
    if (gen !== generation) {
      return;
    }
    fail(gen, "connection lost");
  });
}

/**
 * Marks the connection degraded and schedules a retry. Retries always resync
 * the snapshot first: the cursor makes deltas idempotent, and the snapshot is
 * the authority the floor reconciles against after a disconnect.
 */
function fail(gen: number, message: string): void {
  if (gen !== generation) {
    return;
  }
  closeStream();
  attempt += 1;
  if (!isOnline()) {
    setState({ ...state, status: "offline", error: message });
    scheduleRetry(gen);
    return;
  }
  if (polling) {
    // A failed SSE retry while polling: stay on polling, the loop keeps going.
    setState({ ...state, status: "polling", error: message });
    return;
  }
  if (attempt >= POLL_AFTER_ATTEMPTS) {
    // SSE never opened: fall back to snapshots instead of a dead live pill.
    startPolling(gen);
    return;
  }
  setState({ ...state, status: "reconnecting", error: message });
  scheduleRetry(gen);
}

function scheduleRetry(gen: number): void {
  clearRetry();
  const delay = reconnectDelay(attempt - 1);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (gen !== generation || !running) {
      return;
    }
    if (!isOnline()) {
      // Stay offline and keep a capped retry; the `online` event fires sooner.
      scheduleRetry(gen);
      return;
    }
    void resync();
  }, delay);
}
