import type { CostRecordInput } from "@kit/store";
import { describe, expect, it, vi } from "vitest";
import {
  type ManagerReplyCostStore,
  recordManagerReplyCost,
} from "../lib/manager-cost";

function fakeStore() {
  const records: CostRecordInput[] = [];
  const record = vi.fn(async (input: CostRecordInput) => {
    records.push(input);
    return input;
  });
  const store = { costLedger: { record } } as ManagerReplyCostStore;
  return { store, records, record };
}

describe("manager reply cost record", () => {
  it("charges the reply to the manager session, not just the artifact", async () => {
    const { store, records } = fakeStore();
    await recordManagerReplyCost(store, {
      runId: "run_1",
      workspaceId: "default",
      model: "deepseek-pro",
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: "default",
      runId: "run_1",
      scopeKind: "manager",
      scopeId: "run_1",
      managerSessionId: "run_1",
      source: "manager",
      modelId: "deepseek-pro",
      tokensIn: 1000,
      tokensOut: 500,
      tracked: true,
      costCnyMicro: 6000,
    });
  });

  it("keeps an office thread on its own manager session", async () => {
    const { store, records } = fakeStore();
    await recordManagerReplyCost(store, {
      runId: "thread_1",
      workspaceId: "default",
      model: "deepseek-pro",
      inputTokens: 10,
      outputTokens: 5,
      managerSessionId: "thread_1",
    });

    expect(records[0]?.managerSessionId).toBe("thread_1");
    expect(records[0]?.scopeId).toBe("thread_1");
  });

  it("never fails the exchange when the ledger is down", async () => {
    const record = vi.fn(async () => {
      throw new Error("ledger down");
    });
    const store = {
      costLedger: { record },
    } as unknown as ManagerReplyCostStore;
    await expect(
      recordManagerReplyCost(store, {
        runId: "run_2",
        workspaceId: "default",
        model: "deepseek-pro",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledOnce();
  });
});
