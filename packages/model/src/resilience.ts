import {
  type PriorityClass,
  type Quota,
  type QuotaRequest,
  type QuotaUsage,
  resolveQuota,
} from "@kit/core";

/**
 * 429 / quota handling for the model gateway (60 §3.4).
 *
 * - Retryable failures (429, 408, 5xx, transient network errors) get
 *   exponential backoff with jitter, bounded by max retries. Everything else
 *   (400/401/403/404/422 …) is thrown immediately — no blind retries.
 * - Quota (workspace × provider/model rpm/tpm/concurrency) is enforced before
 *   the call. Overflow is either `queue` (bounded wait) or `reject`.
 */

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 8_000;
export const DEFAULT_BACKOFF_JITTER = 0.2;

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** ±fraction applied around the capped exponential delay. 0 disables jitter. */
  jitterRatio: number;
}

export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}

export class QuotaExceededError extends Error {
  constructor(
    readonly request: QuotaRequest,
    readonly dimension: "rpm" | "tpm" | "concurrency",
    readonly limit: number,
    readonly overflow: "queue" | "reject",
  ) {
    super(
      `model quota exceeded (${dimension}=${limit}) for ${request.workspaceId}/${request.provider}/${request.model}${
        overflow === "queue" ? " after waiting in queue" : ""
      }`,
    );
    this.name = "QuotaExceededError";
  }
}

/** 408, 429 and 5xx are retryable; other 4xx are terminal. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ModelHttpError) {
    return isRetryableStatus(error.status);
  }
  if (error instanceof QuotaExceededError) {
    return false;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) {
      return true;
    }
    // `fetch` rejects with a plain TypeError("fetch failed") on transport errors.
    if (
      error.name === "TypeError" &&
      /fetch failed|network/i.test(error.message)
    ) {
      return true;
    }
  }
  return false;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

/**
 * Delay before retry `attempt` (1-based): capped exponential ± jitter. A
 * provider `Retry-After` is honored, still capped by `maxDelayMs`.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  const ceiling = Math.max(0, policy.maxDelayMs);
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.min(Math.max(0, retryAfterMs), ceiling);
  }
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exp, ceiling);
  const jitter = Math.min(Math.max(policy.jitterRatio, 0), 1) * capped;
  const sampled = capped - jitter + random() * 2 * jitter;
  return Math.round(Math.min(Math.max(sampled, 0), ceiling));
}

export function loadRetryPolicy(
  env: Record<string, string | undefined> = process.env,
): RetryPolicy {
  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0
      ? Math.trunc(parsed)
      : fallback;
  };
  const float = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
      ? parsed
      : fallback;
  };
  return {
    maxRetries: int("KIT_MODEL_MAX_RETRIES", DEFAULT_MAX_RETRIES),
    baseDelayMs: int("KIT_MODEL_BACKOFF_BASE_MS", DEFAULT_BACKOFF_BASE_MS),
    maxDelayMs: int("KIT_MODEL_BACKOFF_MAX_MS", DEFAULT_BACKOFF_MAX_MS),
    jitterRatio: float("KIT_MODEL_BACKOFF_JITTER", DEFAULT_BACKOFF_JITTER),
  };
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const WINDOW_MS = 60_000;

interface QuotaBucket {
  windowStart: number;
  rpm: number;
  tpm: number;
  concurrency: number;
}

export type QuotaDecision =
  | { ok: true; quota: Quota | null }
  | {
      ok: false;
      quota: Quota;
      dimension: "rpm" | "tpm" | "concurrency";
      limit: number;
    };

/**
 * In-process sliding-window quota tracker. Concurrency is released by the
 * caller on completion; rpm/tpm reset every minute.
 */
export class QuotaTracker {
  private readonly buckets = new Map<string, QuotaBucket>();

  constructor(
    private readonly quotas: readonly Quota[],
    private readonly now: () => number = () => Date.now(),
  ) {}

  acquire(request: QuotaRequest, tokens = 0): QuotaDecision {
    const quota = resolveQuota(this.quotas, request);
    const bucket = this.bucket(request);
    if (quota?.rpm !== undefined && bucket.rpm >= quota.rpm) {
      return { ok: false, quota, dimension: "rpm", limit: quota.rpm };
    }
    if (quota?.tpm !== undefined && bucket.tpm + tokens > quota.tpm) {
      return { ok: false, quota, dimension: "tpm", limit: quota.tpm };
    }
    if (
      quota?.concurrency !== undefined &&
      bucket.concurrency >= quota.concurrency
    ) {
      return {
        ok: false,
        quota,
        dimension: "concurrency",
        limit: quota.concurrency,
      };
    }
    bucket.rpm += 1;
    bucket.tpm += tokens;
    bucket.concurrency += 1;
    return { ok: true, quota: quota ?? null };
  }

  release(request: QuotaRequest): void {
    const bucket = this.bucket(request);
    bucket.concurrency = Math.max(0, bucket.concurrency - 1);
  }

  usage(request: QuotaRequest): QuotaUsage {
    const bucket = this.bucket(request);
    return {
      rpm: bucket.rpm,
      tpm: bucket.tpm,
      concurrency: bucket.concurrency,
      quota: resolveQuota(this.quotas, request),
    };
  }

  snapshot(): Array<QuotaRequest & QuotaUsage> {
    const at = this.now();
    const rows: Array<QuotaRequest & QuotaUsage> = [];
    for (const [key, bucket] of this.buckets) {
      const [workspaceId, provider, model] = key.split("|");
      if (!workspaceId || !provider || !model) {
        continue;
      }
      const fresh =
        at - bucket.windowStart < WINDOW_MS
          ? bucket
          : {
              windowStart: at,
              rpm: 0,
              tpm: 0,
              concurrency: bucket.concurrency,
            };
      rows.push({
        workspaceId,
        provider,
        model,
        rpm: fresh.rpm,
        tpm: fresh.tpm,
        concurrency: fresh.concurrency,
        quota: resolveQuota(this.quotas, { workspaceId, provider, model }),
      });
    }
    return rows;
  }

  private bucket(request: QuotaRequest): QuotaBucket {
    const key = `${request.workspaceId}|${request.provider}|${request.model}`;
    const at = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { windowStart: at, rpm: 0, tpm: 0, concurrency: 0 };
      this.buckets.set(key, bucket);
      return bucket;
    }
    if (at - bucket.windowStart >= WINDOW_MS) {
      bucket.windowStart = at;
      bucket.rpm = 0;
      bucket.tpm = 0;
    }
    return bucket;
  }
}

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface ResilienceContext {
  request: QuotaRequest;
  /** Estimated input tokens used against `tpm`. */
  tokens: number;
  priority?: PriorityClass;
  signal?: AbortSignal;
}

export interface ResilientGatewayOptions {
  retry?: RetryPolicy;
  quotas?: readonly Quota[];
  tracker?: QuotaTracker;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Queue-poll interval while waiting for a quota slot. */
  quotaPollMs?: number;
  onRetry?: (event: RetryEvent) => void;
}

export function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Applies quota admission and retry/backoff around a gateway call. Exported as
 * a plain function so both `complete` and `completeWithTools` share one path.
 */
export async function runWithResilience<T>(
  call: () => Promise<T>,
  context: ResilienceContext,
  options: ResilientGatewayOptions = {},
): Promise<T> {
  const retry = options.retry ?? loadRetryPolicy();
  const quotas = options.quotas ?? [];
  const tracker =
    options.tracker ??
    (quotas.length > 0 ? new QuotaTracker(quotas, options.now) : null);
  const sleep = options.sleep ?? sleepWithAbort;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const waitForQuota = async (
    quotaTracker: QuotaTracker | null,
    ctx: ResilienceContext,
  ): Promise<boolean> => {
    if (!quotaTracker) {
      return false;
    }
    const pollMs = Math.max(10, options.quotaPollMs ?? 250);
    for (;;) {
      const decision = quotaTracker.acquire(ctx.request, ctx.tokens);
      if (decision.ok) {
        return true;
      }
      const overflow = decision.quota.overflow;
      if (overflow === "reject") {
        throw new QuotaExceededError(
          ctx.request,
          decision.dimension,
          decision.limit,
          overflow,
        );
      }
      const elapsed = now() - startedAt;
      const remaining = decision.quota.queueTimeoutMs - elapsed;
      if (remaining <= 0) {
        throw new QuotaExceededError(
          ctx.request,
          decision.dimension,
          decision.limit,
          overflow,
        );
      }
      await sleep(Math.min(pollMs, remaining), ctx.signal);
    }
  };

  const acquired = await waitForQuota(tracker, context);
  try {
    let attempt = 0;
    for (;;) {
      try {
        return await call();
      } catch (error) {
        if (!isRetryableModelError(error) || attempt >= retry.maxRetries) {
          throw error;
        }
        attempt += 1;
        const retryAfterMs =
          error instanceof ModelHttpError ? error.retryAfterMs : undefined;
        const delayMs = computeBackoffDelay(
          attempt,
          retry,
          random,
          retryAfterMs,
        );
        options.onRetry?.({ attempt, delayMs, error });
        await sleep(delayMs, context.signal);
      }
    }
  } finally {
    if (acquired) {
      tracker?.release(context.request);
    }
  }
}
