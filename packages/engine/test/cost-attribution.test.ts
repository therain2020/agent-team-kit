import type { CostCallRecord, ModelGateway, PriceTable } from "@kit/model";
import { describe, expect, it, vi } from "vitest";
import {
  recordCoderCost,
  recordToolCall,
  trackedGateway,
} from "../src/cost-attribution";

type FakeStore = Parameters<typeof trackedGateway>[0];

function fakeStore(records: CostCallRecord[]) {
  const registerPriceTable = vi.fn(async (_table: PriceTable) => undefined);
  const store = {
    costLedger: {
      record: vi.fn(async (record: CostCallRecord) => {
        records.push(record);
        return record;
      }),
      registerPriceTable,
    },
  };
  return { store: store as unknown as FakeStore, registerPriceTable };
}

const baseGateway: ModelGateway = {
  complete: vi.fn(async () => ({
    text: "ok",
    usage: {
      inputTokens: 1000,
      outputTokens: 0,
      modelId: "deepseek-flash",
      provider: "deepseek",
      unitPriceIn: 0.001,
      unitPriceOut: 0.002,
      priceVersion: "2026-11-01",
      tracked: true,
    },
  })),
  completeWithTools: vi.fn(async () => ({
    text: "ok",
    toolCalls: [],
    message: { role: "assistant" as const, content: "ok" },
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
};

describe("engine cost attribution", () => {
  it("wraps a gateway with workspace/run/stage/agent attribution", async () => {
    const records: CostCallRecord[] = [];
    const { store, registerPriceTable } = fakeStore(records);
    const gateway = trackedGateway(
      store,
      {
        workspaceId: "default",
        runId: "run_1",
        stageId: "run_1:s1",
        agentId: "writer",
        source: "judge",
      },
      baseGateway,
    );
    await gateway.complete({
      model: "deepseek-flash",
      instructions: "",
      input: "",
    });

    expect(registerPriceTable).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: "default",
      runId: "run_1",
      stageId: "run_1:s1",
      agentId: "writer",
      source: "judge",
      costCnyMicro: 1000,
      tracked: true,
    });
  });

  it("records executed tool calls at the configured price", async () => {
    const records: CostCallRecord[] = [];
    const { store } = fakeStore(records);
    await recordToolCall(
      store,
      {
        workspaceId: "default",
        runId: "run_1",
        stageId: "run_1:s1",
        agentId: "writer",
      },
      "workspace.read",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe("tool:workspace.read");
    // Default per-call price is an explicit 0, tracked.
    expect(records[0]?.costCnyMicro).toBe(0);
    expect(records[0]?.tracked).toBe(true);
    expect(records[0]?.priceVersion).toBe("tools@1");
  });

  it("records unpriced coder tokens as untracked spend", async () => {
    const records: CostCallRecord[] = [];
    const { store } = fakeStore(records);
    await recordCoderCost(
      store,
      {
        workspaceId: "default",
        runId: "run_1",
        stageId: "run_1:s1",
        agentId: "writer",
      },
      { coder: "dsh", tokens: 1234 },
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: "coder",
      modelId: "dsh",
      tokensIn: 1234,
      tracked: false,
      costCnyMicro: 0,
    });
    expect(records[0]?.untrackedReason).toContain("dsh");
  });
});
