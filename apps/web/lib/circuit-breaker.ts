import {
  type CircuitBreakerRecord,
  type CircuitScopeType,
  newId,
} from "@kit/core";
import { type CircuitBreakerEventRecord, appendOp } from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

export interface CircuitBreakerView {
  breakers: CircuitBreakerRecord[];
  events: CircuitBreakerEventRecord[];
}

/** Glass-box read model: current breaker states plus recent transitions. */
export async function loadCircuitBreakers(
  workspaceId?: string,
): Promise<CircuitBreakerView> {
  await ensureStoreSchema();
  const service = getStore().circuitBreakerService;
  const [breakers, events] = await Promise.all([
    service.list({ workspaceId, limit: 100 }),
    service.listEvents(50),
  ]);
  return { breakers, events };
}

export interface ResetCircuitBreakerRequest {
  scopeType: CircuitScopeType;
  scopeKey: string;
  reason: string;
}

/**
 * Operator reset path. A reset is audited to the op log so glass-box review can
 * see who cleared a breaker and why.
 */
export async function resetCircuitBreaker(input: ResetCircuitBreakerRequest) {
  await ensureStoreSchema();
  const store = getStore();
  const record = await store.circuitBreakerService.reset({
    scopeType: input.scopeType,
    scopeKey: input.scopeKey,
    actor: "operator:web",
    reason: input.reason,
  });
  if (!record) {
    return null;
  }
  await appendOp(store, {
    workspaceId: record.workspaceId,
    entityKind: "circuit_breaker",
    entityId: `${record.scopeType}:${record.scopeKey}`,
    op: "circuit_breaker.reset",
    actor: "operator:web",
    origin: "web",
    idempotencyKey: `circuit_breaker.reset:${record.scopeType}:${record.scopeKey}:${newId("reset")}`,
    payload: {
      scopeType: record.scopeType,
      scopeKey: record.scopeKey,
      reason: input.reason,
      recoveredAt: record.recoveredAt,
    },
  }).catch((error: unknown) => {
    console.error(
      `[circuit-breaker] op-log audit failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return record;
}
