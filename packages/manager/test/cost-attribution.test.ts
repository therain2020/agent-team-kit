import type { CostCallRecord, ModelGateway } from "@kit/model";
import { describe, expect, it } from "vitest";
import { attributedManagerGateway } from "../src/cost-attribution";

const inner: ModelGateway = {
  complete: async () => ({
    text: "answer",
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      modelId: "deepseek-pro",
      provider: "deepseek",
      unitPriceIn: 0.002,
      unitPriceOut: 0.008,
      priceVersion: "2026-11-01",
      tracked: true,
    },
  }),
  completeWithTools: async () => ({
    text: "",
    toolCalls: [],
    message: { role: "assistant" as const, content: "" },
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
};

describe("manager cost attribution", () => {
  it("charges a reply to the manager session and the run", async () => {
    const records: CostCallRecord[] = [];
    const gateway = attributedManagerGateway(inner, {
      sink: { record: (record) => records.push(record) },
      workspaceId: "default",
      managerSessionId: "run_1",
      runId: "run_1",
    });

    await gateway.complete({
      model: "deepseek-pro",
      instructions: "answer",
      input: "question",
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: "default",
      runId: "run_1",
      scopeKind: "manager",
      scopeId: "run_1",
      managerSessionId: "run_1",
      source: "manager",
      costCnyMicro: 6000,
    });
  });

  it("keeps an office reply (no run) on its own session scope", async () => {
    const records: CostCallRecord[] = [];
    const gateway = attributedManagerGateway(inner, {
      sink: { record: (record) => records.push(record) },
      workspaceId: "default",
      managerSessionId: "thread_1",
    });

    await gateway.complete({
      model: "deepseek-pro",
      instructions: "answer",
      input: "question",
    });

    expect(records[0]?.runId).toBe("manager:thread_1");
    expect(records[0]?.managerSessionId).toBe("thread_1");
  });
});
