import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Producer } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRunDetail } from "../lib/runs";

const producer: Producer = {
  agentId: "echo",
  agentVersion: "1.0.0",
  promptHash: "hash",
  modelId: "deepseek-flash",
};

let dir: string;
let store: Awaited<ReturnType<typeof initStore>>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-web-dossier-"));
  store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
});

afterAll(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function publish(
  runId: string,
  stageId: string,
  content: unknown,
): Promise<string> {
  const published = await store.artifactService.publish({
    workspaceId: "default",
    content: new TextEncoder().encode(
      typeof content === "string" ? content : JSON.stringify(content),
    ),
    producer,
    inputs: [],
    runId,
    stageId,
    runMode: "DRY_RUN",
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
  return published.artifact.artifactId;
}

async function createRun(runId: string): Promise<string> {
  const now = new Date().toISOString();
  await store.runs.create({
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "wf",
    workflowVersion: "1",
    runMode: "DRY_RUN",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
  });
  return now;
}

describe("loadRunDetail stage dossiers", () => {
  it("exposes instructions, transcript, gate score and tool calls per stage", async () => {
    const runId = "run_web_dossier";
    const now = await createRun(runId);

    const draftStageId = `${runId}:draft`;
    const polishStageId = `${runId}:polish`;
    await store.stages.create({
      stageId: draftStageId,
      runId,
      name: "draft",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
    });
    await store.stages.create({
      stageId: polishStageId,
      runId,
      name: "polish",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
    });

    const instructionsArtifactId = await publish(
      runId,
      `${draftStageId}:instructions`,
      {
        kind: "stage.instructions",
        instructions: "Draft the report.",
        truncated: false,
      },
    );
    const transcriptArtifactId = await publish(
      runId,
      `${draftStageId}:transcript`,
      {
        kind: "stage.transcript",
        gateScore: 0.82,
        toolCalls: 3,
        turns: [],
      },
    );

    const detail = await loadRunDetail(runId, store);
    expect(detail).not.toBeNull();
    // Existing fields stay intact.
    expect(detail?.stages).toHaveLength(2);
    expect(detail?.artifacts).toHaveLength(2);

    expect(detail?.stageDossiers[draftStageId]).toEqual({
      instructionsArtifactId,
      transcriptArtifactId,
      gateScore: 0.82,
      toolCalls: 3,
    });
    // A stage without dossier artifacts still has an entry, with nulls.
    expect(detail?.stageDossiers[polishStageId]).toEqual({
      instructionsArtifactId: null,
      transcriptArtifactId: null,
      gateScore: null,
      toolCalls: 0,
    });
  });

  it("does not misclassify coder transcripts as stage transcripts", async () => {
    const runId = "run_web_dossier_coder";
    const now = await createRun(runId);
    const stageId = `${runId}:build`;
    await store.stages.create({
      stageId,
      runId,
      name: "build",
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
    });
    await publish(runId, `${stageId}:coder:transcript`, "coder output");
    await publish(runId, `${stageId}:coder:result`, { ok: true });

    const detail = await loadRunDetail(runId, store);
    expect(detail?.stageDossiers[stageId]).toEqual({
      instructionsArtifactId: null,
      transcriptArtifactId: null,
      gateScore: null,
      toolCalls: 0,
    });
  });
});
