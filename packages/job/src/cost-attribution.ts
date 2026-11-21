import { newId } from "@kit/core";
import {
  CostTrackingGateway,
  type CostLedgerSink,
  type ModelGateway,
  createModelGateway,
  loadModelConfig,
  loadPriceTable,
} from "@kit/model";

/**
 * Attribution for a compose/draft call. The draft has no run yet, so its cost
 * is charged to the job draft (`jobId`) instead of an invented run (60 §3.3).
 */
export interface JobCostAttribution {
  workspaceId: string;
  jobId: string;
  sink: CostLedgerSink;
}

/**
 * Build the gateway a composer uses. Without attribution the call is not
 * recorded (legacy callers and tests); web routes always pass one, so every
 * live compose/draft call reaches the cost ledger.
 */
export function composeGateway(input: {
  env: Record<string, string | undefined>;
  attribution?: JobCostAttribution;
  /** `compose:<kind>` or `draft`. */
  source: string;
}): ModelGateway {
  const gateway = createModelGateway(loadModelConfig(input.env));
  if (!input.attribution) {
    return gateway;
  }
  return new CostTrackingGateway(gateway, {
    context: {
      workspaceId: input.attribution.workspaceId,
      scopeKind: "job",
      jobId: input.attribution.jobId,
      scopeId: input.attribution.jobId,
      source: input.source,
    },
    sink: input.attribution.sink,
    priceTable: loadPriceTable(input.env),
    // A re-drafted job really paid again; idempotency is per charged call.
    callIdPrefix: `job:${input.attribution.jobId}:${input.source}:${newId("call")}`,
    onError: (error) => {
      console.error(
        `[cost] ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
