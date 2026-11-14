import { initStore } from "@kit/store";
import { trace } from "@opentelemetry/api";
import { Context } from "@temporalio/activity";
import type {
  DemoInput,
  FinishInput,
  PreparedRun,
  StageInput,
  StageResult,
} from "./types";

type Store = Awaited<ReturnType<typeof initStore>>;

let storePromise: Promise<Store> | undefined;

function getStore(): Promise<Store> {
  storePromise ??= initStore();
  return storePromise;
}

const RUN_MODE = "DRY_RUN" as const;
const PRODUCER = {
  agentId: "demo-agent",
  agentVersion: "1.0.0",
  promptHash: "sha256:demo",
  modelId: "stub",
};

export async function prepareRun(input: DemoInput): Promise<PreparedRun> {
  const store = await getStore();
  const now = new Date().toISOString();

  await store.runs.create({
    runId: input.runId,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    workflowId: "demo",
    workflowVersion: "1.0",
    runMode: RUN_MODE,
    status: "running",
    createdAt: now,
    updatedAt: now,
  });

  const stage1Id = `${input.runId}:stage-1`;
  const stage2Id = `${input.runId}:stage-2`;

  await store.stages.create({
    stageId: stage1Id,
    runId: input.runId,
    name: "stage-1",
    status: "pending",
  });
  await store.stages.create({
    stageId: stage2Id,
    runId: input.runId,
    name: "stage-2",
    status: "pending",
  });

  return { stage1Id, stage2Id };
}

export async function runStage(input: StageInput): Promise<StageResult> {
  const span = trace.getTracer("kit-worker").startSpan("stage.run");
  span.setAttribute("run.id", input.runId);
  span.setAttribute("stage.id", input.stageId);
  span.setAttribute("stage.name", input.stageName);

  try {
    const store = await getStore();

    const existing = await store.artifactStore.findCommittedByRunStage(
      input.runId,
      input.stageId,
    );

    if (existing) {
      span.setAttribute("artifact.reused", true);
      await store.stages.updateStatus(input.stageId, "succeeded", {
        finishedAt: new Date().toISOString(),
      });
      return { artifactId: existing.artifactId, reused: true };
    }

    await store.stages.updateStatus(input.stageId, "running", {
      startedAt: new Date().toISOString(),
    });

    const content = new TextEncoder().encode(
      `${input.stageName}:${input.runId}`,
    );

    const published = await store.artifactService.publish({
      workspaceId: input.workspaceId,
      content,
      producer: PRODUCER,
      inputs: input.inputArtifactId
        ? [{ artifactId: input.inputArtifactId, version: 1 }]
        : [],
      runId: input.runId,
      stageId: input.stageId,
      runMode: RUN_MODE,
      cost: { currency: "CNY", amount: 0, tokens: 0 },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });

    span.setAttribute("artifact.id", published.artifact.artifactId);
    await sleepWithHeartbeat(input.sleepMs ?? 0);

    await store.stages.updateStatus(input.stageId, "succeeded", {
      finishedAt: new Date().toISOString(),
    });

    return { artifactId: published.artifact.artifactId, reused: false };
  } finally {
    span.end();
  }
}

export async function finishRun(input: FinishInput): Promise<void> {
  const store = await getStore();
  await store.runs.updateStatus(
    input.runId,
    "succeeded",
    new Date().toISOString(),
  );
}

async function sleepWithHeartbeat(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  const step = 500;
  let elapsed = 0;

  while (elapsed < ms) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(step, ms - elapsed)),
    );
    Context.current().heartbeat();
    elapsed += step;
  }
}
