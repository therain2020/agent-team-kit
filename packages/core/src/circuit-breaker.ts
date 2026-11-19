import { z } from "zod";

/**
 * Circuit breaker state machine (60 §3.2, 61 单租户故障, D-37).
 *
 * A breaker is tracked per dimension — workspace, provider, model and agent —
 * so a single failing workspace, provider, model or agent cannot degrade the
 * others. Every request is evaluated against all of its scopes and is fast
 * failed when any scope is open. Recovery always passes through a cooldown and
 * a half-open probe phase, and re-tripping is debounced for a minimum recovery
 * interval to avoid flapping (60 §5: no re-trip within 1h of recovery).
 *
 * The pure helpers never touch storage; persistence lives in
 * `@kit/store` (`CircuitBreakerService`).
 */

export const circuitStateSchema = z.enum(["closed", "open", "half_open"]);

export type CircuitState = z.infer<typeof circuitStateSchema>;

export const circuitScopeTypeSchema = z.enum([
  "workspace",
  "provider",
  "model",
  "agent",
]);

export type CircuitScopeType = z.infer<typeof circuitScopeTypeSchema>;

export const CIRCUIT_BREAKER_MIN_RECOVERY_MS = 60 * 60 * 1000;

export const circuitBreakerConfigSchema = z.object({
  /** Consecutive failures that trip a closed breaker. */
  failureThreshold: z.number().int().positive().default(5),
  /** Error rate within the statistic window that trips a closed breaker. */
  errorRateThreshold: z.number().min(0).max(1).default(0.5),
  /** Rolling statistic window for the error-rate check. */
  windowMs: z.number().int().nonnegative().default(60_000),
  /** Time an open breaker waits before admitting a half-open probe. */
  cooldownMs: z.number().int().nonnegative().default(30_000),
  /** Successful probes required before a half-open breaker closes. */
  halfOpenProbes: z.number().int().positive().default(1),
  /** Minimum gap after recovery before the breaker may trip again. */
  minRecoveryIntervalMs: z
    .number()
    .int()
    .nonnegative()
    .default(CIRCUIT_BREAKER_MIN_RECOVERY_MS),
});

export type CircuitBreakerConfig = z.infer<typeof circuitBreakerConfigSchema>;

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig =
  circuitBreakerConfigSchema.parse({});

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/**
 * Load breaker tuning from the environment. Unset or invalid values fall back
 * to the defaults above; the minimum recovery interval never drops below the
 * contractual 1h debounce.
 */
export function loadCircuitBreakerConfig(
  env: Record<string, string | undefined> = process.env,
): CircuitBreakerConfig {
  const minRecoveryIntervalMs = Math.max(
    CIRCUIT_BREAKER_MIN_RECOVERY_MS,
    envInt(
      env.KIT_CIRCUIT_MIN_RECOVERY_MS,
      DEFAULT_CIRCUIT_BREAKER_CONFIG.minRecoveryIntervalMs,
    ),
  );
  const errorRate = Number(env.KIT_CIRCUIT_ERROR_RATE);
  return {
    failureThreshold: Math.max(
      1,
      envInt(
        env.KIT_CIRCUIT_FAILURE_THRESHOLD,
        DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
      ),
    ),
    errorRateThreshold:
      Number.isFinite(errorRate) && errorRate >= 0 && errorRate <= 1
        ? errorRate
        : DEFAULT_CIRCUIT_BREAKER_CONFIG.errorRateThreshold,
    windowMs: envInt(
      env.KIT_CIRCUIT_WINDOW_MS,
      DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs,
    ),
    cooldownMs: envInt(
      env.KIT_CIRCUIT_COOLDOWN_MS,
      DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs,
    ),
    halfOpenProbes: Math.max(
      1,
      envInt(
        env.KIT_CIRCUIT_HALF_OPEN_PROBES,
        DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenProbes,
      ),
    ),
    minRecoveryIntervalMs,
  };
}

export interface CircuitDimensions {
  workspaceId: string;
  provider: string;
  model: string;
  agentId?: string;
}

export interface CircuitScope {
  scopeType: CircuitScopeType;
  scopeKey: string;
  workspaceId: string;
}

/**
 * The scopes a request contributes to. Keys are workspace-prefixed so the same
 * provider/model/agent failing in one workspace never opens another's breaker.
 */
export function circuitScopes(input: CircuitDimensions): CircuitScope[] {
  const workspaceId = input.workspaceId;
  const scopes: CircuitScope[] = [
    { scopeType: "workspace", scopeKey: workspaceId, workspaceId },
    {
      scopeType: "provider",
      scopeKey: `${workspaceId}|${input.provider}`,
      workspaceId,
    },
    {
      scopeType: "model",
      scopeKey: `${workspaceId}|${input.provider}|${input.model}`,
      workspaceId,
    },
  ];
  if (input.agentId) {
    scopes.push({
      scopeType: "agent",
      scopeKey: `${workspaceId}|${input.agentId}`,
      workspaceId,
    });
  }
  return scopes;
}

export interface CircuitSample {
  at: string;
  ok: boolean;
}

export interface CircuitBreakerRecord {
  scopeType: CircuitScopeType;
  scopeKey: string;
  workspaceId: string;
  state: CircuitState;
  consecutiveFailures: number;
  window: CircuitSample[];
  openedAt: string | null;
  halfOpenStartedAt: string | null;
  halfOpenSuccesses: number;
  lastTripAt: string | null;
  recoveredAt: string | null;
  tripCount: number;
  updatedAt: string;
}

export function newCircuitBreakerRecord(
  scope: CircuitScope,
  now: string,
): CircuitBreakerRecord {
  return {
    scopeType: scope.scopeType,
    scopeKey: scope.scopeKey,
    workspaceId: scope.workspaceId,
    state: "closed",
    consecutiveFailures: 0,
    window: [],
    openedAt: null,
    halfOpenStartedAt: null,
    halfOpenSuccesses: 0,
    lastTripAt: null,
    recoveredAt: null,
    tripCount: 0,
    updatedAt: now,
  };
}

export type CircuitTransition =
  | "none"
  | "trip"
  | "recover"
  | "open_to_half_open"
  | "suppressed";

export interface CircuitAccessDecision {
  allowed: boolean;
  /** Why the request was rejected; null when allowed. */
  reason: string | null;
  transition: CircuitTransition;
  record: CircuitBreakerRecord | null;
}

function pruneWindow(
  window: readonly CircuitSample[],
  nowMs: number,
  windowMs: number,
): CircuitSample[] {
  return window.filter((sample) => {
    const at = Date.parse(sample.at);
    return Number.isFinite(at) && nowMs - at <= windowMs;
  });
}

/**
 * Decide whether a request may proceed. An open breaker whose cooldown has
 * elapsed transitions to half-open and admits one probe; an open breaker still
 * inside its cooldown fast-fails.
 */
export function circuitAccess(
  record: CircuitBreakerRecord | null,
  now: Date,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
): CircuitAccessDecision {
  if (!record) {
    return { allowed: true, reason: null, transition: "none", record: null };
  }
  if (record.state === "closed") {
    return { allowed: true, reason: null, transition: "none", record };
  }
  if (record.state === "half_open") {
    return { allowed: true, reason: null, transition: "none", record };
  }

  const nowMs = now.getTime();
  const openedMs = record.openedAt ? Date.parse(record.openedAt) : nowMs;
  if (nowMs - openedMs >= config.cooldownMs) {
    const next: CircuitBreakerRecord = {
      ...record,
      state: "half_open",
      halfOpenStartedAt: now.toISOString(),
      halfOpenSuccesses: 0,
      updatedAt: now.toISOString(),
    };
    return {
      allowed: true,
      reason: null,
      transition: "open_to_half_open",
      record: next,
    };
  }

  return {
    allowed: false,
    reason: `circuit open (${record.scopeType}/${record.scopeKey}); cooling down`,
    transition: "none",
    record,
  };
}

function shouldTrip(
  consecutiveFailures: number,
  window: readonly CircuitSample[],
  config: CircuitBreakerConfig,
): boolean {
  if (consecutiveFailures >= config.failureThreshold) {
    return true;
  }
  if (window.length < config.failureThreshold) {
    return false;
  }
  const failures = window.reduce(
    (count, sample) => count + (sample.ok ? 0 : 1),
    0,
  );
  return failures / window.length >= config.errorRateThreshold;
}

export interface CircuitOutcomeResult {
  record: CircuitBreakerRecord;
  transition: CircuitTransition;
}

/**
 * Fold one call outcome into the breaker. Failures are counted against the
 * window and consecutive-failure threshold; recoveries re-open the breaker on
 * the first failed probe. Within `minRecoveryIntervalMs` after a recovery,
 * tripping is suppressed so a flaky dependency does not oscillate.
 */
export function applyCircuitOutcome(
  record: CircuitBreakerRecord,
  success: boolean,
  now: Date,
  config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
): CircuitOutcomeResult {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  // Outcomes that arrive after a trip (in-flight requests) are ignored.
  if (record.state === "open") {
    return { record, transition: "none" };
  }

  if (record.state === "half_open") {
    if (success) {
      const successes = record.halfOpenSuccesses + 1;
      if (successes >= config.halfOpenProbes) {
        return {
          record: {
            ...record,
            state: "closed",
            consecutiveFailures: 0,
            window: [],
            openedAt: null,
            halfOpenStartedAt: null,
            halfOpenSuccesses: 0,
            recoveredAt: nowIso,
            updatedAt: nowIso,
          },
          transition: "recover",
        };
      }
      return {
        record: {
          ...record,
          halfOpenSuccesses: successes,
          updatedAt: nowIso,
        },
        transition: "none",
      };
    }
    return {
      record: {
        ...record,
        state: "open",
        openedAt: nowIso,
        halfOpenStartedAt: null,
        halfOpenSuccesses: 0,
        lastTripAt: nowIso,
        tripCount: record.tripCount + 1,
        updatedAt: nowIso,
      },
      transition: "trip",
    };
  }

  // closed
  const window = pruneWindow(record.window, nowMs, config.windowMs);
  const sample: CircuitSample = { at: nowIso, ok: success };
  window.push(sample);

  if (success) {
    return {
      record: {
        ...record,
        consecutiveFailures: 0,
        window,
        updatedAt: nowIso,
      },
      transition: "none",
    };
  }

  const consecutiveFailures = record.consecutiveFailures + 1;
  const recoveredMs = record.recoveredAt
    ? Date.parse(record.recoveredAt)
    : Number.NaN;
  const debounced =
    Number.isFinite(recoveredMs) &&
    nowMs - recoveredMs < config.minRecoveryIntervalMs;

  if (!debounced && shouldTrip(consecutiveFailures, window, config)) {
    return {
      record: {
        ...record,
        state: "open",
        consecutiveFailures,
        window,
        openedAt: nowIso,
        halfOpenStartedAt: null,
        halfOpenSuccesses: 0,
        lastTripAt: nowIso,
        tripCount: record.tripCount + 1,
        updatedAt: nowIso,
      },
      transition: "trip",
    };
  }

  return {
    record: {
      ...record,
      consecutiveFailures,
      window,
      updatedAt: nowIso,
    },
    transition: debounced ? "suppressed" : "none",
  };
}

/** Manual reset returns a breaker to a clean closed state. */
export function resetCircuitBreaker(
  record: CircuitBreakerRecord,
  now: Date,
): CircuitBreakerRecord {
  const nowIso = now.toISOString();
  return {
    ...record,
    state: "closed",
    consecutiveFailures: 0,
    window: [],
    openedAt: null,
    halfOpenStartedAt: null,
    halfOpenSuccesses: 0,
    recoveredAt: nowIso,
    updatedAt: nowIso,
  };
}

export class CircuitOpenError extends Error {
  constructor(
    readonly blockedBy: Pick<
      CircuitBreakerRecord,
      "scopeType" | "scopeKey" | "state" | "openedAt" | "lastTripAt"
    >,
    message?: string,
  ) {
    super(
      message ??
        `circuit open at ${blockedBy.scopeType}/${blockedBy.scopeKey}; request fast-failed`,
    );
    this.name = "CircuitOpenError";
  }
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError;
}
