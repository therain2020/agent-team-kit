import type { ManagerSessionRecord } from "@kit/store";
import { describe, expect, it, vi } from "vitest";
import {
  checkManagerBudget,
  recordManagerRejection,
} from "../lib/manager-budget";

type Store = NonNullable<Parameters<typeof checkManagerBudget>[0]["store"]>;

type PublishInput = {
  content: Uint8Array;
  cost: { currency: "CNY"; amount: number; tokens: number };
};

function usage(
  overrides: Partial<ManagerSessionRecord> = {},
): ManagerSessionRecord {
  return {
    workspaceId: "default",
    sessionId: "run_1",
    windowStartedAt: "2026-11-15T10:00:00.000Z",
    windowEndsAt: "2026-11-15T10:03:00.000Z",
    firstAt: "2026-11-15T10:00:00.000Z",
    lastAt: "2026-11-15T10:01:00.000Z",
    tokens: 1000,
    costCny: 0.1,
    exchanges: 1,
    rejections: 0,
    lastRejectionReason: null,
    updatedAt: "2026-11-15T10:01:00.000Z",
    ...overrides,
  };
}

function fakeStore(record: ManagerSessionRecord | null) {
  const addUsage = vi.fn();
  const recordRejection = vi.fn(
    async (input: { reason: string; now: string }) => ({
      ...(record ?? usage()),
      rejections: (record?.rejections ?? 0) + 1,
      lastRejectionReason: input.reason,
      lastAt: input.now,
      updatedAt: input.now,
    }),
  );
  const publish = vi.fn(async (_input: PublishInput) => ({
    artifact: { artifactId: "art_budget" },
  }));

  return {
    store: {
      managerSessions: {
        get: vi.fn(async () => record),
        addUsage,
        recordRejection,
        reset: vi.fn(),
      },
      artifactService: { publish },
    } as unknown as Store,
    addUsage,
    recordRejection,
    publish,
  };
}

describe("manager budget guard", () => {
  it("denies an over-limit request before recording model usage", async () => {
    const { store, addUsage } = fakeStore(
      usage({ tokens: 16_000, exchanges: 3 }),
    );

    const check = await checkManagerBudget({
      workspaceId: "default",
      sessionId: "run_1",
      store,
      now: new Date("2026-11-15T10:02:00.000Z"),
    });

    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(check.reason).toBe("tokens");
      expect(check.snapshot.tokens).toBe(16_000);
    }
    expect(addUsage).not.toHaveBeenCalled();
  });

  it("records a rejection without charging tokens or cost", async () => {
    const { store, addUsage, recordRejection, publish } = fakeStore(
      usage({ tokens: 16_000, costCny: 1.5 }),
    );

    await recordManagerRejection({
      workspaceId: "default",
      sessionId: "run_1",
      runId: "run_1",
      reason: "tokens",
      store,
      now: new Date("2026-11-15T10:02:30.000Z"),
    });

    expect(addUsage).not.toHaveBeenCalled();
    expect(recordRejection).toHaveBeenCalledOnce();
    expect(recordRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        sessionId: "run_1",
        reason: "tokens",
      }),
    );

    const published = publish.mock.calls[0]?.[0];
    if (!published) {
      throw new Error("expected a rejection audit artifact");
    }
    const audit = JSON.parse(new TextDecoder().decode(published.content)) as {
      tokens: number;
      costCny: number;
      reason: string;
    };
    expect(audit.tokens).toBe(16_000);
    expect(audit.costCny).toBeCloseTo(1.5);
    expect(audit.reason).toBe("tokens");
    expect(published.cost).toEqual({ currency: "CNY", amount: 0, tokens: 0 });
  });
});
