import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EventEnvelope, Run, Stage } from "@kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoreConfig } from "../src/config";
import { initStore } from "../src/store";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-pglite-"));
  dirs.push(dir);
  return loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
}

function event(): EventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId: "evt_local_1",
    type: "demo.event.received",
    schemaVersion: "1.0",
    occurredAt: now,
    receivedAt: now,
    workspaceId: "default",
    idempotencyKey: "idem-local-1",
    traceId: "trace-local-1",
    payloadRef: "inline:{}",
  };
}

function run(): Run {
  const now = new Date().toISOString();
  return {
    runId: "run_local_1",
    eventId: "evt_local_1",
    workspaceId: "default",
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode: "DRY_RUN",
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

function stage(): Stage {
  return {
    stageId: "run_local_1:echo",
    runId: "run_local_1",
    name: "echo",
    status: "pending",
  };
}

describe("pglite embedded store", () => {
  it("creates the schema and round-trips runs, artifacts, and raw SQL", async () => {
    const config = await localConfig();
    expect(config.driver).toBe("pglite");
    const store = await initStore(config);
    closers.push(() => store.close());

    expect(await store.events.insert(event())).toEqual({ inserted: true });
    expect(await store.events.insert(event())).toEqual({ inserted: false });
    await store.runs.create(run());
    await store.stages.create(stage());
    await store.stages.updateStatus(stage().stageId, "succeeded", {
      finishedAt: new Date().toISOString(),
    });

    const published = await store.artifactService.publish({
      workspaceId: "default",
      content: new TextEncoder().encode("hello embedded pg"),
      producer: {
        agentId: "echo",
        agentVersion: "1.0.0",
        promptHash: "hash",
        modelId: "stub",
      },
      inputs: [],
      runId: "run_local_1",
      stageId: "run_local_1:echo",
      runMode: "DRY_RUN",
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
    expect(published.artifact.artifactId).toMatch(/^art_/);

    const runs = await store.runs.list({ limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.runId).toBe("run_local_1");

    const stages = await store.stages.listByRun("run_local_1");
    expect(stages[0]?.status).toBe("succeeded");

    const artifacts = await store.artifactStore.listByRun("run_local_1");
    expect(artifacts).toHaveLength(1);
    const manifest = await store.manifests.get(published.artifact.manifestId);
    expect(manifest?.producer.agentId).toBe("echo");

    const health = await store.sql<Array<{ ok: number }>>`select 1 as ok`;
    expect(health[0]?.ok).toBe(1);
  }, 120_000);

  it("keeps data across close and reopen", async () => {
    const config = await localConfig();
    const first = await initStore(config);
    await first.events.insert(event());
    await first.runs.create(run());
    await first.close();

    const second = await initStore(config);
    closers.push(() => second.close());
    const runs = await second.runs.list({ limit: 5 });
    expect(runs.map((item) => item.runId)).toEqual(["run_local_1"]);
  }, 120_000);
});
