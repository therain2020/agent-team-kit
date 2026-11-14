import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ackAlert,
  emitAlert,
  getOpsGate,
  getOpsPolicy,
  listAlerts,
  parseOnCallPolicy,
  recordAlert,
  saveOpsPolicy,
} from "../src/index";

let dir: string;
let store: Awaited<ReturnType<typeof initStore>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-ops-"));
  store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ops repository", () => {
  it("round-trips the on-call policy", async () => {
    const saved = await saveOpsPolicy(store, "default", {
      channels: { P0: ["email"] },
      monthlyBudget: 5,
    });

    expect(saved.channels.P0).toEqual(["email"]);
    expect(saved.monthlyBudget).toBe(5);

    const loaded = await getOpsPolicy(store, "default");
    expect(loaded.channels.P0).toEqual(["email"]);
    expect(loaded.monthlyBudget).toBe(5);
    expect(loaded.nightMode.enabled).toBe(true);
  });

  it("aggregates duplicate alerts within the tier window", async () => {
    const now = new Date("2026-11-15T12:00:00Z");
    const policy = parseOnCallPolicy({ aggregationMinutes: { P1: 10 } });

    const first = await recordAlert(
      store,
      { tier: "P1", kind: "test", title: "boom", runId: "run_1" },
      { now, policy },
    );
    const second = await recordAlert(
      store,
      { tier: "P1", kind: "test", title: "boom", runId: "run_1" },
      { now: new Date(now.getTime() + 60_000), policy },
    );
    const third = await recordAlert(
      store,
      { tier: "P1", kind: "test", title: "boom", runId: "run_1" },
      { now: new Date(now.getTime() + 12 * 60_000), policy },
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.alert.count).toBe(2);
    expect(third.duplicate).toBe(false);
    expect(await listAlerts(store)).toHaveLength(2);
  });

  it("redacts credential-like values from stored alerts", async () => {
    const { alert } = await recordAlert(store, {
      tier: "P2",
      kind: "test",
      title: "token=abc123",
      body: "Authorization: Bearer abcdef api_key=xyz",
    });

    expect(alert.title).not.toContain("abc123");
    expect(alert.body).not.toContain("abcdef");
    expect(alert.body).not.toContain("xyz");
    expect(alert.title).toContain("[redacted]");
    expect(alert.body).toContain("[redacted]");
  });

  it("acknowledges alerts", async () => {
    const { alert } = await recordAlert(store, {
      tier: "P2",
      kind: "test",
      title: "ack me",
    });

    const acked = await ackAlert(store, alert.alertId, "tester");
    expect(acked?.status).toBe("acknowledged");
    expect(acked?.acknowledgedBy).toBe("tester");
  });

  it("suppresses non-P0 pushes at night without failing", async () => {
    await saveOpsPolicy(
      store,
      "default",
      parseOnCallPolicy({
        nightMode: {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
        },
        aggregationMinutes: { P1: 0 },
      }),
    );

    const result = await emitAlert(
      store,
      { tier: "P1", kind: "night", title: "night alert", runId: "run_1" },
      { now: new Date("2026-11-15T23:00:00Z") },
    );

    expect(result.routing.suppressed).toBe(true);
    expect(result.routing.reason).toBe("night_mode");
    expect(result.deliveries).toEqual([]);
    expect(result.alert.notifyState).toBe("suppressed_night");
  });

  it("reports a read-only gate only inside night hours", async () => {
    await saveOpsPolicy(
      store,
      "default",
      parseOnCallPolicy({
        nightMode: {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
        },
      }),
    );

    const night = await getOpsGate(store, new Date("2026-11-15T23:00:00Z"));
    const day = await getOpsGate(store, new Date("2026-11-15T12:00:00Z"));

    expect(night.readOnly).toBe(true);
    expect(night.nightMode).toBe(true);
    expect(day.readOnly).toBe(false);
  });
});
