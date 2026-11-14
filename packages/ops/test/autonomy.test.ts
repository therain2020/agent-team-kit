import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listActivity } from "@kit/activity";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enableAutonomyPreset,
  getActiveAutonomyPreset,
  getOpsGate,
  parseOnCallPolicy,
  rollbackAutonomyPreset,
  saveOpsPolicy,
} from "../src/index";

let dir: string;
let store: Awaited<ReturnType<typeof initStore>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-autonomy-"));
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

describe("autonomy preset", () => {
  it("enables the self-hosted LIVE preset and records an audit event", async () => {
    const preset = await enableAutonomyPreset(store, {
      config: { applyMode: "low", dailyCostCny: 3, dailyRuns: 1, maxTasks: 1 },
      actor: "operator:test",
      reason: "acceptance run",
    });

    expect(preset.level).toBe("self-hosted-live");
    expect(preset.status).toBe("active");
    expect(preset.config.applyMode).toBe("low");
    expect(preset.config.dailyCostCny).toBe(3);
    expect(preset.appliedBy).toBe("operator:test");

    const active = await getActiveAutonomyPreset(store);
    expect(active?.presetId).toBe(preset.presetId);

    const audit = await listActivity(store, { kind: "ops.autonomy.enabled" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      presetId: preset.presetId,
      reason: "acceptance run",
    });
  });

  it("applies defaults when no config is passed", async () => {
    const preset = await enableAutonomyPreset(store);

    expect(preset.config).toEqual({
      applyMode: "low-medium",
      dailyCostCny: 5,
      dailyRuns: 2,
      maxTasks: 2,
      allowNight: true,
    });
  });

  it("supersedes the previous preset instead of stacking", async () => {
    const first = await enableAutonomyPreset(store);
    const second = await enableAutonomyPreset(store, {
      config: { dailyCostCny: 9 },
    });

    const active = await getActiveAutonomyPreset(store);
    expect(active?.presetId).toBe(second.presetId);

    const rows = await store.sql<Array<{ preset_id: string; status: string }>>`
      SELECT preset_id, status FROM ops_autonomy_presets ORDER BY applied_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.preset_id === first.presetId)?.status).toBe(
      "superseded",
    );
  });

  it("rolls back to factory defaults and records the rollback", async () => {
    await enableAutonomyPreset(store);
    const rolledBack = await rollbackAutonomyPreset(store, {
      actor: "operator:test",
      reason: "stop the loop",
    });

    expect(rolledBack?.status).toBe("rolled_back");
    expect(rolledBack?.rolledBackBy).toBe("operator:test");
    expect(rolledBack?.rollbackReason).toBe("stop the loop");
    expect(await getActiveAutonomyPreset(store)).toBeNull();

    const audit = await listActivity(store, {
      kind: "ops.autonomy.rolled_back",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      presetId: rolledBack?.presetId,
      reason: "stop the loop",
    });
  });

  it("returns null when there is nothing to roll back", async () => {
    expect(await rollbackAutonomyPreset(store)).toBeNull();
  });

  it("keeps the night gate read-only until the preset opens the exception", async () => {
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
    const night = new Date("2026-11-15T23:00:00Z");

    const before = await getOpsGate(store, night);
    expect(before.readOnly).toBe(true);
    expect(before.nightException).toBe(false);

    await enableAutonomyPreset(store, { config: { allowNight: true } });
    const during = await getOpsGate(store, night);
    expect(during.readOnly).toBe(false);
    expect(during.nightException).toBe(true);

    await rollbackAutonomyPreset(store);
    const after = await getOpsGate(store, night);
    expect(after.readOnly).toBe(true);
    expect(after.nightException).toBe(false);
  });

  it("respects allowNight=false", async () => {
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
    await enableAutonomyPreset(store, { config: { allowNight: false } });

    const gate = await getOpsGate(store, new Date("2026-11-15T23:00:00Z"));
    expect(gate.readOnly).toBe(true);
    expect(gate.nightException).toBe(false);
  });

  it("rejects invalid preset config", async () => {
    await expect(
      enableAutonomyPreset(store, {
        config: { applyMode: "all" as unknown as "low" },
      }),
    ).rejects.toThrow();
  });
});
