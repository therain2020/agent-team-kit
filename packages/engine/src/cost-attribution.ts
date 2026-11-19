import { newId } from "@kit/core";
import {
  type CostCallContext,
  CostTrackingGateway,
  type ModelGateway,
  cnyToMicro,
  computeCostMicro,
  loadPriceTable,
  resolveModelPrice,
  resolveToolCallPrice,
} from "@kit/model";
import type { initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Engine-side glue for cost attribution: wraps every model gateway so calls
 * are charged at one point, and records tool/coder calls that never flow
 * through a gateway. Ledger failures are logged, never allowed to fail a run
 * that has already paid for the call.
 */
export function trackedGateway(
  store: Store,
  context: CostCallContext,
  inner: ModelGateway,
): ModelGateway {
  ensurePriceTable(store);
  return new CostTrackingGateway(inner, {
    context,
    sink: { record: (record) => store.costLedger.record(record) },
    priceTable: loadPriceTable(),
    // A re-executed stage really paid again (budget charges re-book as well),
    // so ids are unique per execution; idempotency is per charged call.
    callIdPrefix: [
      context.runId,
      context.stageId ?? "",
      context.agentId ?? "",
      context.source ?? "model",
      newId("call"),
    ].join(":"),
    onError: logCostError,
  });
}

/** Charge one executed tool call at its configured per-call price. */
export async function recordToolCall(
  store: Store,
  context: CostCallContext,
  toolName: string,
): Promise<void> {
  try {
    const price = resolveToolCallPrice(toolName);
    // One tool call is priced as a single unit, expressed as 1,000 input
    // "tokens" at the configured per-call rate so the unit-price columns stay
    // meaningful across sources.
    await store.costLedger.record({
      workspaceId: context.workspaceId,
      runId: context.runId,
      stageId: context.stageId ?? null,
      agentId: context.agentId ?? null,
      source: `tool:${toolName}`,
      modelId: toolName,
      provider: "local",
      tokensIn: 1000,
      tokensOut: 0,
      unitPriceInMicro: cnyToMicro(price.unitPriceCny),
      unitPriceOutMicro: 0,
      priceVersion: price.priceVersion,
      costCnyMicro: cnyToMicro(price.unitPriceCny),
      tracked: true,
      callId: `${context.runId}:${context.stageId ?? ""}:${context.agentId ?? ""}:tool:${toolName}:${newId("t")}`,
    });
  } catch (error) {
    logCostError(error);
  }
}

/**
 * Charge a coder/CLI stage by its reported tokens. Coder pricing is usually
 * absent from the provider price table (subscription CLIs), which records the
 * call as `untracked` instead of pretending it was free.
 */
export async function recordCoderCost(
  store: Store,
  context: CostCallContext,
  input: { coder: string; tokens: number },
): Promise<void> {
  try {
    const table = loadPriceTable();
    const price = resolveModelPrice(table, input.coder);
    const tokensIn = Math.max(0, Math.round(input.tokens));
    const costCnyMicro = computeCostMicro(price, tokensIn, 0);
    await store.costLedger.record({
      workspaceId: context.workspaceId,
      runId: context.runId,
      stageId: context.stageId ?? null,
      agentId: context.agentId ?? null,
      source: "coder",
      modelId: input.coder,
      provider: price.provider,
      tokensIn,
      tokensOut: 0,
      unitPriceInMicro: price.inputPer1kMicro,
      unitPriceOutMicro: price.outputPer1kMicro,
      priceVersion: price.priceVersion,
      costCnyMicro,
      tracked: price.tracked,
      untrackedReason: price.untrackedReason,
      callId: `${context.runId}:${context.stageId ?? ""}:${context.agentId ?? ""}:coder:${newId("c")}`,
    });
  } catch (error) {
    logCostError(error);
  }
}

/** Link a stage's earlier records to the artifact version it published. */
export async function attachStageArtifact(
  store: Store,
  input: {
    workspaceId: string;
    runId: string;
    stageId: string;
    artifactId: string;
  },
): Promise<void> {
  try {
    await store.costLedger.attachArtifact(input);
  } catch (error) {
    logCostError(error);
  }
}

const registeredStores = new WeakSet<Store>();

function ensurePriceTable(store: Store): void {
  if (registeredStores.has(store)) {
    return;
  }
  registeredStores.add(store);
  store.costLedger.registerPriceTable(loadPriceTable()).catch(logCostError);
}

function logCostError(error: unknown): void {
  console.error(
    `[cost] ${error instanceof Error ? error.message : String(error)}`,
  );
}
