import { quotaSchema } from "@kit/core";
import { describe, expect, it } from "vitest";
import {
  type ModelGateway,
  ModelHttpError,
  QuotaExceededError,
  QuotaTracker,
  ResilientModelGateway,
  type RetryPolicy,
  computeBackoffDelay,
  isRetryableModelError,
  parseRetryAfterMs,
} from "../src/index";

const REQUEST = {
  model: "deepseek-flash",
  instructions: "test",
  input: "hello",
};

function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitterRatio: 0,
    ...overrides,
  };
}

function failingGateway(
  errors: unknown[],
  successText = "ok",
): ModelGateway & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete() {
      calls += 1;
      const error = errors[calls - 1];
      if (error) {
        throw error;
      }
      return { text: successText, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async completeWithTools() {
      throw new Error("not used");
    },
  };
}

describe("model error classification", () => {
  it("retries 429/408/5xx and never other 4xx", () => {
    expect(isRetryableModelError(new ModelHttpError(429, "rate limited"))).toBe(
      true,
    );
    expect(isRetryableModelError(new ModelHttpError(408, "timeout"))).toBe(
      true,
    );
    expect(isRetryableModelError(new ModelHttpError(500, "boom"))).toBe(true);
    expect(isRetryableModelError(new ModelHttpError(503, "unavailable"))).toBe(
      true,
    );
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableModelError(new ModelHttpError(status, "no"))).toBe(
        false,
      );
    }
    expect(isRetryableModelError(new Error("model request failed"))).toBe(
      false,
    );
    const network = new TypeError("fetch failed");
    expect(isRetryableModelError(network)).toBe(true);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
    expect(parseRetryAfterMs("1.5")).toBe(1_500);
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
    const future = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    expect(parsed).toBeGreaterThan(3_000);
    expect(parsed).toBeLessThanOrEqual(5_000);
  });
});

describe("exponential backoff with jitter", () => {
  it("grows exponentially and caps", () => {
    expect(computeBackoffDelay(1, policy(), () => 0)).toBe(100);
    expect(computeBackoffDelay(2, policy(), () => 0)).toBe(200);
    expect(computeBackoffDelay(3, policy(), () => 0)).toBe(400);
    expect(computeBackoffDelay(10, policy(), () => 0)).toBe(1_000);
  });

  it("stays inside the jitter band and respects Retry-After", () => {
    const jittered = policy({ jitterRatio: 0.5 });
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = computeBackoffDelay(3, jittered, () => random);
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThanOrEqual(600);
    }
    // Retry-After is honored but capped by maxDelayMs.
    expect(computeBackoffDelay(1, policy(), () => 0.5, 250)).toBe(250);
    expect(computeBackoffDelay(1, policy(), () => 0.5, 9_999)).toBe(1_000);
    // Retry-After overrides the exponential+jitter entirely.
    expect(computeBackoffDelay(5, jittered, () => 1, 750)).toBe(750);
  });

  it("produces a distribution, not a single fixed delay", () => {
    const delays = new Set(
      Array.from({ length: 20 }, (_, i) =>
        computeBackoffDelay(2, policy({ jitterRatio: 0.5 }), () => i / 20),
      ),
    );
    expect(delays.size).toBeGreaterThan(5);
  });
});

describe("QuotaTracker", () => {
  const quota = quotaSchema.parse({
    workspaceId: "alpha",
    rpm: 2,
    tpm: 100,
    concurrency: 1,
  });
  const request = {
    workspaceId: "alpha",
    provider: "deepseek",
    model: "flash",
  };

  it("enforces rpm/tpm/concurrency per workspace", () => {
    let now = 0;
    const tracker = new QuotaTracker([quota], () => now);
    expect(tracker.acquire(request, 40).ok).toBe(true);
    // Concurrency is checked after rpm/tpm; release before the rpm is spent.
    expect(tracker.acquire(request, 40)).toMatchObject({
      ok: false,
      dimension: "concurrency",
    });
    tracker.release(request);
    expect(tracker.acquire(request, 40).ok).toBe(true);
    expect(tracker.acquire(request, 40)).toMatchObject({
      ok: false,
      dimension: "rpm",
    });
    now = 60_001;
    const tpm = new QuotaTracker([quota], () => now);
    expect(tpm.acquire(request, 90).ok).toBe(true);
    expect(tpm.acquire(request, 90)).toMatchObject({
      ok: false,
      dimension: "tpm",
    });
  });

  it("does not share buckets across workspaces", () => {
    const tracker = new QuotaTracker([quotaSchema.parse({ rpm: 1 })]);
    expect(tracker.acquire(request).ok).toBe(true);
    expect(tracker.acquire({ ...request, workspaceId: "beta" }).ok).toBe(true);
    expect(tracker.acquire(request)).toMatchObject({
      ok: false,
      dimension: "rpm",
    });
  });
});

describe("ResilientModelGateway", () => {
  it("retries a 429 then succeeds with backoff", async () => {
    const inner = failingGateway([new ModelHttpError(429, "slow down")]);
    const delays: number[] = [];
    const gateway = new ResilientModelGateway(inner, "deepseek", {
      retry: policy(),
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });
    const response = await gateway.complete(REQUEST);
    expect(response.text).toBe("ok");
    expect(inner.calls).toBe(2);
    expect(delays).toEqual([100]);
  });

  it("does not retry a 400", async () => {
    const inner = failingGateway([new ModelHttpError(400, "bad request")]);
    const gateway = new ResilientModelGateway(inner, "deepseek", {
      retry: policy(),
      sleep: async () => {
        throw new Error("must not sleep");
      },
    });
    await expect(gateway.complete(REQUEST)).rejects.toMatchObject({
      status: 400,
    });
    expect(inner.calls).toBe(1);
  });

  it("stops after maxRetries and throws the last retryable error", async () => {
    const inner = failingGateway([
      new ModelHttpError(503, "down"),
      new ModelHttpError(503, "down"),
      new ModelHttpError(503, "down"),
      new ModelHttpError(503, "down"),
    ]);
    const gateway = new ResilientModelGateway(inner, "deepseek", {
      retry: policy({ maxRetries: 3 }),
      sleep: async () => {},
    });
    await expect(gateway.complete(REQUEST)).rejects.toMatchObject({
      status: 503,
    });
    expect(inner.calls).toBe(4);
  });

  it("rejects immediately when overflow is `reject`", async () => {
    const gateway = new ResilientModelGateway(failingGateway([]), "deepseek", {
      retry: policy(),
      quotas: [quotaSchema.parse({ rpm: 1, overflow: "reject" })],
    });
    await gateway.complete(REQUEST);
    await expect(gateway.complete(REQUEST)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("queues with a bounded timeout when overflow is `queue`", async () => {
    let now = 0;
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const inner: ModelGateway = {
      async complete() {
        calls += 1;
        if (calls === 1) {
          await first;
        }
        return { text: "ok", usage: { inputTokens: 0, outputTokens: 0 } };
      },
      async completeWithTools() {
        throw new Error("not used");
      },
    };
    const gateway = new ResilientModelGateway(inner, "deepseek", {
      retry: policy(),
      quotas: [
        quotaSchema.parse({
          concurrency: 1,
          overflow: "queue",
          queueTimeoutMs: 100,
        }),
      ],
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      quotaPollMs: 40,
    });
    const running = gateway.complete(REQUEST);
    await expect(gateway.complete(REQUEST)).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    resolveFirst?.();
    await expect(running).resolves.toMatchObject({ text: "ok" });
  });
});
