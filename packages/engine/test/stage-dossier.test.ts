import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArtifactService,
  type PublishInput,
  initStore,
  loadStoreConfig,
} from "@kit/store";
import type { PackStageExecutionInput } from "@kit/workflow";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeEngineStore,
  executePackStage,
  preparePackRun,
} from "../src/pack-activities";

let dir: string;
let env: Record<string, string>;
let store: Awaited<ReturnType<typeof initStore>>;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "kit-stage-dossier-"));
  env = {
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  };
  Object.assign(process.env, env);
  store = await initStore(loadStoreConfig(env));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeEngineStore();
  await store.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function createRun(
  runId: string,
  stageNames: string[] = ["draft", "polish"],
): Promise<void> {
  await preparePackRun({
    runId,
    eventId: `evt_${runId}`,
    workspaceId: "default",
    workflowId: "dossier-demo",
    workflowVersion: "1.2",
    runMode: "DRY_RUN",
    stages: stageNames.map((name) => ({
      stageId: `${runId}:${name}`,
      name,
      agentId: "echo",
    })),
  });
}

function stageInput(
  runId: string,
  stageId: string,
  overrides: Partial<PackStageExecutionInput> = {},
): PackStageExecutionInput {
  return {
    runId,
    workspaceId: "default",
    stageId: `${runId}:${stageId}`,
    stageName: stageId,
    type: "agent",
    agentId: "echo",
    modelAlias: "deepseek-flash",
    instructions: `You are the ${stageId} agent.`,
    inputText: "hello dossier",
    stub: true,
    runMode: "DRY_RUN",
    ...overrides,
  };
}

async function artifactByStageId(
  runId: string,
  stageId: string,
): Promise<{ artifactId: string; content: string } | null> {
  const artifact = await store.artifactStore.findCommittedByRunStage(
    runId,
    stageId,
  );
  if (!artifact) {
    return null;
  }
  const blob = await store.blobs.findById(artifact.blobId);
  if (!blob) {
    return null;
  }
  const bytes = await store.blobClient.get(blob.storageKey);
  return {
    artifactId: artifact.artifactId,
    content: new TextDecoder().decode(bytes),
  };
}

describe("stage dossier", () => {
  it("writes one instructions and one transcript artifact per stage", async () => {
    const runId = "run_dossier_happy";
    await createRun(runId);

    const first = await executePackStage(stageInput(runId, "draft"));
    const second = await executePackStage(
      stageInput(runId, "polish", { inputArtifactId: first.artifactId }),
    );

    for (const stageId of [`${runId}:draft`, `${runId}:polish`]) {
      const instructions = await artifactByStageId(
        runId,
        `${stageId}:instructions`,
      );
      const transcript = await artifactByStageId(
        runId,
        `${stageId}:transcript`,
      );
      expect(instructions).not.toBeNull();
      expect(transcript).not.toBeNull();
    }

    const instructions = await artifactByStageId(
      runId,
      `${runId}:draft:instructions`,
    );
    const instructionsContent = JSON.parse(instructions?.content ?? "{}") as {
      kind?: string;
      instructions?: string;
      truncated?: boolean;
      workflowId?: string;
      workflowVersion?: string;
    };
    expect(instructionsContent.kind).toBe("stage.instructions");
    expect(instructionsContent.instructions).toBe("You are the draft agent.");
    expect(instructionsContent.truncated).toBe(false);
    expect(instructionsContent.workflowId).toBe("dossier-demo");
    expect(instructionsContent.workflowVersion).toBe("1.2");

    const transcript = await artifactByStageId(
      runId,
      `${runId}:polish:transcript`,
    );
    const transcriptContent = JSON.parse(transcript?.content ?? "{}") as {
      kind?: string;
      instructionsArtifactId?: string | null;
      outputArtifactId?: string | null;
      inputs?: Array<{ artifactId: string; version: number }>;
      gateScore?: number | null;
      toolCalls?: number;
      turns?: unknown[];
      finalResponse?: string;
    };
    expect(transcriptContent.kind).toBe("stage.transcript");
    expect(transcriptContent.outputArtifactId).toBe(second.artifactId);
    expect(transcriptContent.instructionsArtifactId).not.toBeNull();
    expect(transcriptContent.inputs).toEqual([
      { artifactId: first.artifactId, version: 1 },
    ]);
    expect(transcriptContent.gateScore).toBeNull();
    expect(transcriptContent.toolCalls).toBe(0);
    expect(transcriptContent.turns).toHaveLength(1);
    expect(transcriptContent.finalResponse).toContain("[stub:deepseek-flash]");

    // The store derives `consumed` edges from the transcript manifest inputs.
    const ancestry = await store.artifactStore.ancestryOf(
      transcript?.artifactId ?? "",
      1,
    );
    expect(ancestry.map((node) => node.artifactId)).toContain(first.artifactId);

    const artifacts = await store.artifactStore.listByRun(runId);
    expect(artifacts).toHaveLength(6);
  });

  it("truncates oversized prompts, redacts secrets, and marks truncated", async () => {
    const runId = "run_dossier_truncate";
    await createRun(runId, ["long"]);

    const instructions = `${"secret=super-secret-value ".repeat(400)}tail`;
    await executePackStage(stageInput(runId, "long", { instructions }));

    const artifact = await artifactByStageId(
      runId,
      `${runId}:long:instructions`,
    );
    const content = JSON.parse(artifact?.content ?? "{}") as {
      instructions?: string;
      truncated?: boolean;
    };

    expect(content.truncated).toBe(true);
    expect(content.instructions?.endsWith("…[truncated]")).toBe(true);
    expect(content.instructions?.includes("super-secret-value")).toBe(false);
    expect(content.instructions?.includes("secret=[redacted]")).toBe(true);
  });

  it("keeps running when the dossier write fails", async () => {
    const runId = "run_dossier_best_effort";
    await createRun(runId, ["resilient"]);

    const original = ArtifactService.prototype.publish;
    vi.spyOn(ArtifactService.prototype, "publish").mockImplementation(
      async function (
        this: ArtifactService,
        input: PublishInput,
      ): Promise<Awaited<ReturnType<ArtifactService["publish"]>>> {
        if (input.stageId.endsWith(":instructions")) {
          throw new Error("dossier store offline");
        }
        return original.call(this, input);
      },
    );

    const result = await executePackStage(stageInput(runId, "resilient"));
    expect(result.artifactId).not.toBe("");

    const instructions = await artifactByStageId(
      runId,
      `${runId}:resilient:instructions`,
    );
    const transcript = await artifactByStageId(
      runId,
      `${runId}:resilient:transcript`,
    );
    expect(instructions).toBeNull();
    expect(transcript).not.toBeNull();

    const transcriptContent = JSON.parse(transcript?.content ?? "{}") as {
      instructionsArtifactId?: string | null;
    };
    expect(transcriptContent.instructionsArtifactId).toBeNull();
  });
});
