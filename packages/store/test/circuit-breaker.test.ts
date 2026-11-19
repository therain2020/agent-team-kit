import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CircuitBreakerConfig,
  type CircuitDimensions,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  circuitScopes,
} from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { CircuitBreakerService } from "../src/circuit-breaker-service";
import { loadStoreConfig } from "../src/config";
import { initStore } from "../src/store";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const CONFIG: CircuitBreakerConfig = {
  ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
  failureThreshold: 3,
  errorRateThreshold: 1,
  windowMs: 10 * 60_000,
  cooldownMs: 30_000,
  halfOpenProbes: 1,
  minRecoveryIntervalMs: 60 * 60_000,
};

const MODEL_KEY = "ws-a|deepseek|flash";
const DIMS: CircuitDimensions = {
  workspaceId: "ws-a",
  provider: "deepseek",
  model: "flash",
  agentId: "agent-1",
};

const BASE = new Date("2026-11-20T00:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(BASE.getTime() + offsetMs);
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-circuit-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  const service = new CircuitBreakerService(
    { sql: store.sql, driver: store.driver },
    CONFIG,
  );
  return { store, service };
}

describe("circuit breaker service (sqlite)", () => {
  it("trips, fast-fails, half-opens after cooldown, and recovers", async () => {
    const { service } = await setup();

    for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
      await service.record(DIMS, false, at(i * 1000));
    }
    const model = await service.get("model", MODEL_KEY);
    expect(model?.state).toBe("open");
    expect(model?.tripCount).toBe(1);

    const blocked = await service.acquire(DIMS, at(5000));
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy).not.toBeNull();

    // Still cooling down (opened at BASE+2000).
    const cooling = await service.acquire(
      DIMS,
      at(2000 + CONFIG.cooldownMs - 1),
    );
    expect(cooling.allowed).toBe(false);

    // Cooldown elapsed -> half-open probe admitted.
    const probing = await service.acquire(DIMS, at(2000 + CONFIG.cooldownMs));
    expect(probing.allowed).toBe(true);
    expect(
      probing.transitions.some((t) => t.transition === "open_to_half_open"),
    ).toBe(true);
    expect((await service.get("model", MODEL_KEY))?.state).toBe("half_open");

    // A successful probe closes the breaker.
    const recovered = await service.record(DIMS, true, at(40_000));
    expect(recovered.transitions.some((t) => t.transition === "recover")).toBe(
      true,
    );
    const closed = await service.get("model", MODEL_KEY);
    expect(closed?.state).toBe("closed");

    const events = await service.listEvents(20);
    expect(events.some((event) => event.action === "trip")).toBe(true);
    expect(events.some((event) => event.action === "half_open")).toBe(true);
    expect(events.some((event) => event.action === "recover")).toBe(true);
  });

  it("re-trips on a failed half-open probe", async () => {
    const { service } = await setup();
    for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
      await service.record(DIMS, false, at(i * 1000));
    }
    await service.acquire(DIMS, at(2000 + CONFIG.cooldownMs));
    expect((await service.get("model", MODEL_KEY))?.state).toBe("half_open");

    const retripped = await service.record(DIMS, false, at(40_000));
    expect(retripped.transitions.some((t) => t.transition === "trip")).toBe(
      true,
    );
    const open = await service.get("model", MODEL_KEY);
    expect(open?.state).toBe("open");
    expect(open?.tripCount).toBe(2);
  });

  it("does not re-trip within 1h of recovery", async () => {
    const { service } = await setup();
    for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
      await service.record(DIMS, false, at(i * 1000));
    }
    await service.acquire(DIMS, at(2000 + CONFIG.cooldownMs));
    await service.record(DIMS, true, at(40_000));
    expect((await service.get("model", MODEL_KEY))?.state).toBe("closed");

    for (let i = 0; i < 5; i += 1) {
      await service.record(DIMS, false, at(50_000 + i * 1000));
    }
    expect((await service.get("model", MODEL_KEY))?.state).toBe("closed");

    await service.record(
      DIMS,
      false,
      at(40_000 + CONFIG.minRecoveryIntervalMs + 1),
    );
    expect((await service.get("model", MODEL_KEY))?.state).toBe("open");
  });

  it("isolates breakers across workspaces", async () => {
    const { service } = await setup();
    const other: CircuitDimensions = { ...DIMS, workspaceId: "ws-b" };
    for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
      await service.record(DIMS, false, at(i * 1000));
    }
    expect((await service.acquire(DIMS, at(5000))).allowed).toBe(false);
    expect((await service.acquire(other, at(5000))).allowed).toBe(true);
    expect(await service.get("workspace", "ws-b")).toBeNull();
  });

  it("resets an operator-cleared breaker and audits the reset", async () => {
    const { service } = await setup();
    for (let i = 0; i < CONFIG.failureThreshold; i += 1) {
      await service.record(DIMS, false, at(i * 1000));
    }
    for (const scope of circuitScopes(DIMS)) {
      const reset = await service.reset({
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        actor: "operator:test",
        reason: "manual clear",
        now: at(5000),
      });
      expect(reset?.state).toBe("closed");
    }
    expect((await service.acquire(DIMS, at(6000))).allowed).toBe(true);

    const events = await service.listEvents(20);
    expect(events.some((event) => event.action === "reset")).toBe(true);
  });
});
