import type { ManagerSessionRecord } from "@kit/store";
import { describe, expect, it } from "vitest";
import {
  MANAGER_COST_LIMIT_CNY,
  MANAGER_TOKEN_LIMIT,
  MANAGER_WINDOW_MS,
  assessManagerBudget,
  managerBudgetMessage,
} from "../lib/manager-budget-window";

function record(
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
    costCny: 0.2,
    exchanges: 1,
    rejections: 0,
    lastRejectionReason: null,
    updatedAt: "2026-11-15T10:01:00.000Z",
    ...overrides,
  };
}

describe("manager session budget", () => {
  it("allows usage below both limits", () => {
    const snapshot = assessManagerBudget(record(), {
      workspaceId: "default",
      sessionId: "run_1",
      now: new Date("2026-11-15T10:02:00.000Z"),
    });

    expect(snapshot.blockedReason).toBeNull();
    expect(snapshot.remainingTokens).toBe(MANAGER_TOKEN_LIMIT - 1000);
    expect(snapshot.remainingCostCny).toBeCloseTo(MANAGER_COST_LIMIT_CNY - 0.2);
    expect(snapshot.remainingMs).toBe(60_000);
  });

  it("blocks at the token limit", () => {
    const snapshot = assessManagerBudget(
      record({ tokens: MANAGER_TOKEN_LIMIT }),
      {
        workspaceId: "default",
        sessionId: "run_1",
        now: new Date("2026-11-15T10:02:00.000Z"),
      },
    );

    expect(snapshot.blockedReason).toBe("tokens");
    expect(snapshot.remainingTokens).toBe(0);
  });

  it("blocks at the cost limit without changing usage", () => {
    const snapshot = assessManagerBudget(
      record({ costCny: MANAGER_COST_LIMIT_CNY, rejections: 2 }),
      {
        workspaceId: "default",
        sessionId: "run_1",
        now: new Date("2026-11-15T10:02:00.000Z"),
      },
    );

    expect(snapshot.blockedReason).toBe("cost");
    expect(snapshot.tokens).toBe(1000);
    expect(snapshot.costCny).toBeCloseTo(MANAGER_COST_LIMIT_CNY);
  });

  it("treats an expired window as fresh", () => {
    const now = new Date("2026-11-15T10:04:00.000Z");
    const snapshot = assessManagerBudget(
      record({ tokens: MANAGER_TOKEN_LIMIT }),
      { workspaceId: "default", sessionId: "run_1", now },
    );

    expect(snapshot.tokens).toBe(0);
    expect(snapshot.costCny).toBe(0);
    expect(snapshot.blockedReason).toBeNull();
    expect(snapshot.windowStartedAt).toBe(now.toISOString());
    expect(snapshot.windowEndsAt).toBe(
      new Date(now.getTime() + MANAGER_WINDOW_MS).toISOString(),
    );
  });

  it("explains how to recover when blocked", () => {
    const snapshot = assessManagerBudget(
      record({ tokens: MANAGER_TOKEN_LIMIT }),
      {
        workspaceId: "default",
        sessionId: "run_1",
        now: new Date("2026-11-15T10:02:00.000Z"),
      },
    );
    const message = managerBudgetMessage(snapshot, "tokens");

    expect(message).toContain("16000/16000 tokens");
    expect(message).toContain("Reset the window or try again in 60s");
  });
});
