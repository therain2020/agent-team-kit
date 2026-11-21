import { newId } from "@kit/core";
import {
  CostTrackingGateway,
  type CostLedgerSink,
  type ModelGateway,
  loadPriceTable,
} from "@kit/model";

/**
 * Attribution for evolution cycle calls. A cycle is not a run, so every model
 * call is charged to the cycle (`changeId`) instead (60 §3.3).
 */
export interface EvolutionCostAttribution {
  sink: CostLedgerSink;
  workspaceId?: string;
}

export interface EvolutionCallScope {
  attribution: EvolutionCostAttribution;
  workspaceId: string;
  changeId: string;
  /** `proposal`, `score`, `canary`, ... — labels the ledger source. */
  phase: string;
}

/** Attribution carried down to a score/canary call site. */
export interface EvolutionCallAttribution {
  attribution: EvolutionCostAttribution;
  workspaceId: string;
  changeId: string;
  phase?: string;
}

export function evolutionCallScope(
  attribution: EvolutionCallAttribution,
  fallbackPhase: string,
): EvolutionCallScope {
  return {
    attribution: attribution.attribution,
    workspaceId: attribution.workspaceId,
    changeId: attribution.changeId,
    phase: attribution.phase ?? fallbackPhase,
  };
}

export function attributedEvolutionGateway(
  inner: ModelGateway,
  scope: EvolutionCallScope,
): ModelGateway {
  return new CostTrackingGateway(inner, {
    context: {
      workspaceId: scope.workspaceId,
      scopeKind: "evolution",
      changeId: scope.changeId,
      scopeId: scope.changeId,
      source: `evolution:${scope.phase}`,
    },
    sink: scope.attribution.sink,
    priceTable: loadPriceTable(),
    // Re-running a cycle phase really paid again; ids are per charged call.
    callIdPrefix: `evolution:${scope.changeId}:${scope.phase}:${newId("call")}`,
    onError: (error) => {
      console.error(
        `[cost] ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}
