import { newId } from "@kit/core";
import {
  type CostLedgerSink,
  CostTrackingGateway,
  type ModelGateway,
  loadPriceTable,
} from "@kit/model";

/**
 * Attribution for a manager reply. It is charged to the manager session
 * (`managerSessionId`) in addition to the run it discusses, so replies stay
 * traceable even when they are not part of a run's stage output (60 §3.3).
 */
export interface ManagerCostAttribution {
  sink: CostLedgerSink;
  workspaceId: string;
  /** Session the operator is talking to, e.g. the run id or office thread id. */
  managerSessionId: string;
  /** Run under discussion, when there is one. */
  runId?: string;
  source?: string;
}

export function attributedManagerGateway(
  inner: ModelGateway,
  attribution: ManagerCostAttribution,
): ModelGateway {
  return new CostTrackingGateway(inner, {
    context: {
      workspaceId: attribution.workspaceId,
      scopeKind: "manager",
      managerSessionId: attribution.managerSessionId,
      scopeId: attribution.managerSessionId,
      ...(attribution.runId ? { runId: attribution.runId } : {}),
      source: attribution.source ?? "manager",
    },
    sink: attribution.sink,
    priceTable: loadPriceTable(),
    // Every reply is a separate paid call; ids stay unique per answer.
    callIdPrefix: `manager:${attribution.managerSessionId}:${newId("call")}`,
    onError: (error) => {
      console.error(
        `[cost] ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
