import { type ActivityInput, appendActivity } from "@kit/activity";
import {
  type CircuitBreakerRecord,
  type CircuitDimensions,
  CircuitOpenError,
} from "@kit/core";
import { type AlertInput, emitAlert } from "@kit/ops";
import type { CircuitScopeTransition, initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface CircuitCallContext {
  workspaceId: string;
  agentId?: string;
  modelAlias: string;
  provider?: string;
}

/**
 * Resolve the breaker dimensions for a model call. D-37 fixes a single
 * provider (DeepSeek, two versions), so the provider defaults to `deepseek`
 * unless overridden; the model is the configured alias.
 */
export function circuitDimensions(
  context: CircuitCallContext,
): CircuitDimensions {
  return {
    workspaceId: context.workspaceId,
    provider: context.provider ?? process.env.KIT_MODEL_PROVIDER ?? "deepseek",
    model: context.modelAlias,
    ...(context.agentId ? { agentId: context.agentId } : {}),
  };
}

// Observability must never break a run.
async function safeActivity(store: Store, input: ActivityInput): Promise<void> {
  try {
    await appendActivity(store, input);
  } catch (error) {
    console.error(
      `[circuit-breaker] activity failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function safeAlert(store: Store, input: AlertInput): Promise<void> {
  try {
    await emitAlert(store, input);
  } catch (error) {
    console.error(
      `[circuit-breaker] alert failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function describe(record: CircuitBreakerRecord): string {
  return `${record.scopeType}/${record.scopeKey}`;
}

/**
 * Emit activity (and alerts for trip/recover) for transitions produced by the
 * store service. Half-open entries are logged but not alerted.
 */
export async function notifyCircuitTransitions(
  store: Store,
  dims: CircuitDimensions,
  transitions: readonly CircuitScopeTransition[],
): Promise<void> {
  for (const { record, transition, previousState } of transitions) {
    if (transition === "open_to_half_open") {
      await safeActivity(store, {
        workspaceId: dims.workspaceId,
        agentId: dims.agentId,
        kind: "circuit_breaker.half_open",
        status: "half_open",
        summary: `${describe(record)} half-open; probing ${dims.model}`,
        payload: { scopeType: record.scopeType, scopeKey: record.scopeKey },
      });
      continue;
    }

    if (transition === "trip") {
      await safeActivity(store, {
        workspaceId: dims.workspaceId,
        agentId: dims.agentId,
        kind: "circuit_breaker.tripped",
        status: "open",
        summary: `${describe(record)} tripped from ${previousState}`,
        payload: {
          scopeType: record.scopeType,
          scopeKey: record.scopeKey,
          tripCount: record.tripCount,
          consecutiveFailures: record.consecutiveFailures,
          model: dims.model,
          provider: dims.provider,
        },
      });
      await safeAlert(store, {
        workspaceId: dims.workspaceId,
        tier: "P2",
        kind: "circuit.tripped",
        title: `Circuit breaker open: ${describe(record)}`,
        body: `${dims.provider}/${dims.model} for ${dims.workspaceId} tripped after ${record.consecutiveFailures} failures; requests fast-fail until cooldown and a successful probe.`,
        dedupeKey: `circuit.tripped:${record.scopeType}:${record.scopeKey}`,
        source: "circuit-breaker",
        meta: {
          scopeType: record.scopeType,
          scopeKey: record.scopeKey,
          tripCount: record.tripCount,
        },
      });
      continue;
    }

    if (transition === "recover") {
      await safeActivity(store, {
        workspaceId: dims.workspaceId,
        agentId: dims.agentId,
        kind: "circuit_breaker.recovered",
        status: "closed",
        summary: `${describe(record)} recovered to closed`,
        payload: {
          scopeType: record.scopeType,
          scopeKey: record.scopeKey,
          recoveredAt: record.recoveredAt,
        },
      });
      await safeAlert(store, {
        workspaceId: dims.workspaceId,
        tier: "P3",
        kind: "circuit.recovered",
        title: `Circuit breaker recovered: ${describe(record)}`,
        body: `${dims.provider}/${dims.model} for ${dims.workspaceId} passed its health probe and closed.`,
        dedupeKey: `circuit.recovered:${record.scopeType}:${record.scopeKey}`,
        source: "circuit-breaker",
        meta: {
          scopeType: record.scopeType,
          scopeKey: record.scopeKey,
          recoveredAt: record.recoveredAt,
        },
      });
    }
  }
}

/**
 * Fast-fail when any dimension of the call is open. Throws {@link CircuitOpenError}
 * so callers stop before spending budget or hitting the provider (D-37: no
 * cross-provider fallback on sensitive paths).
 */
export async function assertCircuitClosed(
  store: Store,
  dims: CircuitDimensions,
  now: Date = new Date(),
): Promise<void> {
  const outcome = await store.circuitBreakerService.acquire(dims, now);
  await notifyCircuitTransitions(store, dims, outcome.transitions);
  if (outcome.allowed) {
    return;
  }
  if (outcome.blockedBy) {
    await safeActivity(store, {
      workspaceId: dims.workspaceId,
      agentId: dims.agentId,
      kind: "circuit_breaker.blocked",
      status: "blocked",
      summary: `${describe(outcome.blockedBy)} fast-failed ${dims.model}`,
      payload: {
        scopeType: outcome.blockedBy.scopeType,
        scopeKey: outcome.blockedBy.scopeKey,
        model: dims.model,
      },
    });
    throw new CircuitOpenError(outcome.blockedBy, outcome.reason ?? undefined);
  }
  throw new CircuitOpenError(
    {
      scopeType: "workspace",
      scopeKey: dims.workspaceId,
      state: "open",
      openedAt: null,
      lastTripAt: null,
    },
    outcome.reason ?? "circuit open",
  );
}

export async function recordCircuitOutcome(
  store: Store,
  dims: CircuitDimensions,
  success: boolean,
  now: Date = new Date(),
): Promise<void> {
  const outcome = await store.circuitBreakerService.record(dims, success, now);
  await notifyCircuitTransitions(store, dims, outcome.transitions);
}

/**
 * Guard a model call with the breaker: fast-fail when open, otherwise run the
 * call and fold success/failure back into every dimension.
 */
export async function callWithCircuitBreaker<T>(
  store: Store,
  dims: CircuitDimensions,
  call: () => Promise<T>,
): Promise<T> {
  await assertCircuitClosed(store, dims);
  const settle = (success: boolean) =>
    recordCircuitOutcome(store, dims, success).catch((error: unknown) => {
      // The breaker is advisory telemetry; a write failure must not turn a
      // successful model call into a run failure.
      console.error(
        `[circuit-breaker] record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  try {
    const value = await call();
    await settle(true);
    return value;
  } catch (error) {
    await settle(false);
    throw error;
  }
}
