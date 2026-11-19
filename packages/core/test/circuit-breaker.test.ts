import { describe, expect, it } from "vitest";
import {
  type CircuitBreakerConfig,
  type CircuitBreakerRecord,
  type CircuitDimensions,
  CircuitOpenError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  applyCircuitOutcome,
  circuitAccess,
  circuitScopes,
  loadCircuitBreakerConfig,
  newCircuitBreakerRecord,
  resetCircuitBreaker,
} from "../src/index";

const T0 = new Date("2026-11-20T00:00:00.000Z");

const config: CircuitBreakerConfig = {
  ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
  failureThreshold: 3,
  errorRateThreshold: 0.5,
  windowMs: 10 * 60_000,
  cooldownMs: 30_000,
  halfOpenProbes: 1,
  minRecoveryIntervalMs: 60 * 60_000,
};

// `feed` writes outcome i at T0 + i*1000, so three failures trip at T0+2000.
const OPENED_MS = 2000;

const dims: CircuitDimensions = {
  workspaceId: "ws-a",
  provider: "deepseek",
  model: "deepseek-flash",
  agentId: "agent-1",
};

function scope() {
  return {
    scopeType: "model" as const,
    scopeKey: "ws-a|deepseek|deepseek-flash",
    workspaceId: "ws-a",
  };
}

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function fresh(): CircuitBreakerRecord {
  return newCircuitBreakerRecord(scope(), T0.toISOString());
}

function feed(
  record: CircuitBreakerRecord,
  outcomes: boolean[],
  startMs = 0,
): { record: CircuitBreakerRecord; transitions: string[] } {
  let current = record;
  const transitions: string[] = [];
  outcomes.forEach((ok, index) => {
    const result = applyCircuitOutcome(
      current,
      ok,
      at(startMs + index * 1000),
      config,
    );
    current = result.record;
    transitions.push(result.transition);
  });
  return { record: current, transitions };
}

describe("circuit breaker state machine", () => {
  it("trips when consecutive failures reach the threshold", () => {
    const { record, transitions } = feed(fresh(), [false, false, false]);
    expect(record.state).toBe("open");
    expect(record.consecutiveFailures).toBe(3);
    expect(record.tripCount).toBe(1);
    expect(transitions).toEqual(["none", "none", "trip"]);
  });

  it("trips on error rate within the window", () => {
    const { record } = feed(fresh(), [false, true, false, false]);
    // consecutive resets on success, but 3/4 failures cross the rate threshold
    expect(record.state).toBe("open");
  });

  it("fast-fails while open and admits a probe after cooldown", () => {
    const tripped = feed(fresh(), [false, false, false]).record;
    expect(tripped.openedAt).toBe(at(OPENED_MS).toISOString());

    const cooling = circuitAccess(
      tripped,
      at(OPENED_MS + config.cooldownMs - 1),
      config,
    );
    expect(cooling.allowed).toBe(false);
    expect(cooling.record?.state).toBe("open");
    expect(new CircuitOpenError(tripped).message).toContain("circuit open");

    const probing = circuitAccess(
      tripped,
      at(OPENED_MS + config.cooldownMs),
      config,
    );
    expect(probing.allowed).toBe(true);
    expect(probing.transition).toBe("open_to_half_open");
    expect(probing.record?.state).toBe("half_open");
  });

  it("recovers after a successful half-open probe", () => {
    const tripped = feed(fresh(), [false, false, false]).record;
    const halfOpen = circuitAccess(
      tripped,
      at(OPENED_MS + config.cooldownMs),
      config,
    ).record as CircuitBreakerRecord;
    const result = applyCircuitOutcome(halfOpen, true, at(40_000), config);
    expect(result.transition).toBe("recover");
    expect(result.record.state).toBe("closed");
    expect(result.record.recoveredAt).toBe(at(40_000).toISOString());
    expect(circuitAccess(result.record, at(41_000), config).allowed).toBe(true);
  });

  it("re-trips on a failed half-open probe", () => {
    const tripped = feed(fresh(), [false, false, false]).record;
    const halfOpen = circuitAccess(
      tripped,
      at(OPENED_MS + config.cooldownMs),
      config,
    ).record as CircuitBreakerRecord;
    const result = applyCircuitOutcome(halfOpen, false, at(40_000), config);
    expect(result.transition).toBe("trip");
    expect(result.record.state).toBe("open");
    expect(result.record.tripCount).toBe(2);
  });

  it("does not re-trip within 1h of recovery", () => {
    // Recover first.
    const tripped = feed(fresh(), [false, false, false]).record;
    const halfOpen = circuitAccess(
      tripped,
      at(OPENED_MS + config.cooldownMs),
      config,
    ).record as CircuitBreakerRecord;
    const recovered = applyCircuitOutcome(
      halfOpen,
      true,
      at(40_000),
      config,
    ).record;
    expect(recovered.state).toBe("closed");

    // Hammer it with failures inside the debounce window.
    const within = feed(recovered, [false, false, false, false, false], 50_000);
    expect(within.record.state).toBe("closed");
    expect(within.transitions.every((t) => t !== "trip")).toBe(true);
    expect(within.transitions).toContain("suppressed");

    // Once the debounce elapses, failures trip again.
    const after = feed(
      within.record,
      [false],
      40_000 + config.minRecoveryIntervalMs + 1,
    );
    expect(after.record.state).toBe("open");
    expect(after.transitions[0]).toBe("trip");
  });

  it("resets a breaker back to closed", () => {
    const tripped = feed(fresh(), [false, false, false]).record;
    const reset = resetCircuitBreaker(tripped, at(50_000));
    expect(reset.state).toBe("closed");
    expect(reset.consecutiveFailures).toBe(0);
    expect(reset.window).toHaveLength(0);
    expect(reset.recoveredAt).toBe(at(50_000).toISOString());
  });

  it("isolates scopes across workspaces and agents", () => {
    const a = circuitScopes(dims);
    const b = circuitScopes({ ...dims, workspaceId: "ws-b" });
    const c = circuitScopes({ ...dims, agentId: "agent-2" });

    const keySet = (scopes: ReturnType<typeof circuitScopes>) =>
      new Set(scopes.map((s) => `${s.scopeType}:${s.scopeKey}`));

    const aKeys = keySet(a);
    expect([...aKeys].some((key) => keySet(b).has(key))).toBe(false);
    // agent scope differs per agent
    expect(
      [...aKeys].some((key) => keySet(c).has(key) && key.startsWith("agent:")),
    ).toBe(false);
    expect(a.some((s) => s.scopeType === "workspace")).toBe(true);
  });

  it("keeps the minimum recovery interval at 1h even from the environment", () => {
    const loaded = loadCircuitBreakerConfig({
      KIT_CIRCUIT_MIN_RECOVERY_MS: "1000",
    });
    expect(loaded.minRecoveryIntervalMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });
});
