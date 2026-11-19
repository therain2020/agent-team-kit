import {
  type CollectOptions,
  type CollectionRunSummary,
  type InformationCollectorStore,
  collectOnce,
} from "@kit/source";

/**
 * Continuous collection loop entry point (98 I-1).
 *
 * The loop is deliberately thin: it schedules {@link collectOnce} on an
 * interval and never overlaps passes. The actual fetch → capture → event →
 * health work lives in `@kit/source` so the CLI can trigger a single pass with
 * the exact same semantics for tests and drills.
 */
export interface CollectionLoopOptions extends CollectOptions {
  /** Interval between passes in milliseconds. Default 5 minutes. */
  intervalMs?: number;
  /** Run one pass immediately on start. Default true. */
  runImmediately?: boolean;
  onRun?: (summary: CollectionRunSummary) => void;
  onError?: (error: unknown) => void;
}

export interface CollectionLoop {
  /** Run a single pass right now (also used by the scheduled tick). */
  runOnce(): Promise<CollectionRunSummary>;
  stop(): void;
}

export function startCollectionLoop(
  store: InformationCollectorStore,
  options: CollectionLoopOptions = {},
): CollectionLoop {
  const intervalMs = Math.max(
    1000,
    Math.trunc(options.intervalMs ?? 5 * 60_000),
  );
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let stopped = false;

  const runOnce = (): Promise<CollectionRunSummary> =>
    collectOnce(store, options);

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      const summary = await runOnce();
      options.onRun?.(summary);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  if (options.runImmediately !== false) {
    void tick();
  }
  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
