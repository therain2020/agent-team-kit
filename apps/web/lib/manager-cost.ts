import { newId } from "@kit/core";
import {
  computeCostMicro,
  loadPriceTable,
  resolveModelPrice,
} from "@kit/model";
import type { CostRecordInput } from "@kit/store";

export interface ManagerReplyCostInput {
  runId: string;
  workspaceId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Manager session being charged; defaults to the run id. */
  managerSessionId?: string;
}

/** Minimal store surface so this module stays free of React/Next imports. */
export interface ManagerReplyCostStore {
  costLedger: {
    record(input: CostRecordInput): Promise<unknown>;
  };
}

/**
 * Charge a manager chat reply to its manager session. Ledger failures are
 * logged, never allowed to fail an answer that already streamed (60 §3.3).
 */
export async function recordManagerReplyCost(
  store: ManagerReplyCostStore,
  input: ManagerReplyCostInput,
): Promise<void> {
  try {
    const now = new Date();
    const price = resolveModelPrice(loadPriceTable(), input.model, now);
    const sessionId = input.managerSessionId ?? input.runId;
    await store.costLedger.record({
      workspaceId: input.workspaceId,
      runId: input.runId,
      scopeKind: "manager",
      scopeId: sessionId,
      managerSessionId: sessionId,
      source: "manager",
      modelId: input.model,
      provider: price.provider,
      tokensIn: input.inputTokens,
      tokensOut: input.outputTokens,
      unitPriceInMicro: price.inputPer1kMicro,
      unitPriceOutMicro: price.outputPer1kMicro,
      priceVersion: price.priceVersion,
      costCnyMicro: computeCostMicro(
        price,
        input.inputTokens,
        input.outputTokens,
      ),
      tracked: price.tracked,
      untrackedReason: price.untrackedReason,
      callId: `manager:${sessionId}:${newId("call")}`,
      ts: now,
    });
  } catch (error) {
    console.error("failed to record manager reply cost", error);
  }
}
