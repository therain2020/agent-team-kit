import type { CostCallRecord, ModelGateway } from "@kit/model";
import { describe, expect, it } from "vitest";
import { attributedEvolutionGateway } from "../src/cost-attribution";

const inner: ModelGateway = {
  complete: async () => ({
    text: "candidate instructions",
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
    message: { role: "assistant", content: "" },
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
};

describe("evolution cost attribution", () => {
  it("charges a cycle phase to its change id", async () => {
    const records: CostCallRecord[] = [];
    const gateway = attributedEvolutionGateway(inner, {
      attribution: {
        sink: { record: (record) => records.push(record) },
      },
      workspaceId: "default",
      changeId: "cyc_1",
      phase: "proposal",
    });

    await gateway.complete({
      model: "deepseek-pro",
      instructions: "improve",
      input: "evidence",
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      workspaceId: "default",
      runId: "evolution:cyc_1",
      scopeKind: "evolution",
      scopeId: "cyc_1",
      changeId: "cyc_1",
      source: "evolution:proposal",
      costCnyMicro: 6000,
    });
  });
});
