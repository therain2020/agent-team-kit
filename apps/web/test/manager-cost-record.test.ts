import type { CostRecordInput } from "@kit/store";
import { describe, expect, it, vi } from "vitest";
import { publishManagerExchange } from "../lib/manager";

type Store = NonNullable<
  NonNullable<Parameters<typeof publishManagerExchange>[0]]["store"]
>;

function fakeStore() {
  const records: CostRecordInput[] = [];
  const publish = vi.fn(async () => ({
    artifact: { artifactId: "art_exchange" },
  }));
  const addUsage = vi.fn(async () => undefined);
  const record = vi.fn(async (input: CostRecordInput) => {
    records.push(input);
    return input;
  });
  const store = {
    artifactService: { publish },
    managerSessions: { addUsage },
    costLedger: { record },
  } as unknown as Store;
  return { store, records, publish, addUsage };
}

describe("manager exchange cost record", () => {
  it("charges the reply to the manager session, not just the artifact", async () => {
    const { store, records } = fakeStore();
    await publishManagerExchange({
      runId: "run_1",
      workspaceId: "default",
      question: "what happened?",
      answer: "The run succeeded.",
      model: "deepseek-pro",
      inputTokens: 1000,
      outputTokens: 500,
      store,
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
    await publishManagerExchange({
      runId: "thread_1",
      workspaceId: "default",
      question: "status?",
      answer: "Ready.",
      model: "deepseek-pro",
      inputTokens: 10,
      outputTokens: 5,
      managerSessionId: "thread_1",
      store,
    });

    expect(records[0]?.managerSessionId).toBe("thread_1");
    expect(records[0]?.scopeId).toBe("thread_1");
  });

  it("never fails the exchange when the ledger is down", async () => {
    const { store } = fakeStore();
    (
      store.costLedger as unknown as { record: () => Promise<never> }
    ).record = async () => {
      throw new Error("ledger down");
    };
    await expect(
      publishManagerExchange({
        runId: "run_2",
        workspaceId: "default",
        question: "q",
        answer: "a",
        model: "deepseek-pro",
        inputTokens: 1,
        outputTokens: 1,
        store,
      }),
    ).resolves.toMatchObject({ artifactId: "art_exchange" });
  });
});
