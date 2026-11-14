import { createHash, createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type ActivityInput, appendActivity } from "@kit/activity";
import { type CoderResult, coderSandboxRoot, runCoderTask } from "@kit/coder";
import { newId } from "@kit/core";
import { deliverArtifact } from "@kit/delivery";
import {
  type ModelMessage,
  StubModelGateway,
  createModelGateway,
} from "@kit/model";
import { initStore } from "@kit/store";
import {
  type Tool,
  type ToolContext,
  createDeclarativeTools,
  executeTool,
  getTool,
  toolDefinitions,
} from "@kit/tools";
import type {
  PackStageExecutionInput,
  PackStageExecutionResult,
  PreparePackRunInput,
  RequestApprovalInput,
  RequestApprovalResult,
} from "@kit/workflow";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { heartbeat } from "./heartbeat";
import { assertKillSwitchClear } from "./kill-switch";

type Store = Awaited<ReturnType<typeof initStore>>;

const MAX_REVISIONS = 2;

let storePromise: Promise<Store> | undefined;

function getStore(): Promise<Store> {
  storePromise ??= initStore();
  return storePromise;
}

// Observability must never break a run.
async function safeActivity(store: Store, input: ActivityInput): Promise<void> {
  try {
    await appendActivity(store, input);
  } catch (error) {
    console.error(
      `[activity] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function closeEngineStore(): Promise<void> {
  const current = storePromise;
  storePromise = undefined;
  if (current) {
    const store = await current;
    await store.close();
  }
}

export async function preparePackRun(
  input: PreparePackRunInput,
): Promise<void> {
  const store = await getStore();
  await assertKillSwitchClear(store, { workspaceId: input.workspaceId }, "run");
  const now = new Date().toISOString();

  await store.runs.create({
    runId: input.runId,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    runMode: input.runMode,
    status: "running",
    createdAt: now,
    updatedAt: now,
  });

  for (const stage of input.stages) {
    await store.stages.create({
      stageId: stage.stageId,
      runId: input.runId,
      name: stage.name,
      status: "pending",
    });
  }

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    kind: "run.started",
    status: "running",
    summary: input.workflowId,
    payload: { workflowVersion: input.workflowVersion, runMode: input.runMode },
  });
}

export async function executePackStage(
  input: PackStageExecutionInput,
): Promise<PackStageExecutionResult> {
  const span = trace.getTracer("kit-worker").startSpan("stage.run");
  span.setAttribute("run.id", input.runId);
  span.setAttribute("stage.id", input.stageId);
  span.setAttribute("stage.name", input.stageName);
  span.setAttribute("stage.type", input.type);
  if (input.agentId) {
    span.setAttribute("agent.id", input.agentId);
  }
  if (input.modelAlias) {
    span.setAttribute("model.alias", input.modelAlias);
  }
  span.setAttribute("stub", input.stub);
  span.setAttribute("run.mode", input.runMode);

  try {
    const result = await executePackStageInner(input);
    span.setAttribute("approval.required", result.approvalRequired === true);
    if (result.approvalRequestId) {
      span.setAttribute("approval.request_id", result.approvalRequestId);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}

async function executePackStageInner(
  input: PackStageExecutionInput,
): Promise<PackStageExecutionResult> {
  const store = await getStore();
  await assertKillSwitchClear(
    store,
    {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      stageId: input.stageId,
      stageName: input.stageName,
    },
    "stage",
  );

  const existing = await store.artifactStore.findCommittedByRunStage(
    input.runId,
    input.stageId,
  );

  if (existing) {
    const text = await readArtifactText(store, existing);
    await store.stages.updateStatus(input.stageId, "succeeded", {
      finishedAt: new Date().toISOString(),
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      agentId: input.agentId,
      kind: "stage.reused",
      status: "succeeded",
      summary: existing.artifactId,
    });
    return { artifactId: existing.artifactId, text, reused: true };
  }

  await store.stages.updateStatus(input.stageId, "running", {
    startedAt: new Date().toISOString(),
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "stage.started",
    status: "running",
    summary: input.stageName,
    payload: { type: input.type },
  });

  let draftText = input.inputText;
  let draftArtifactId = input.inputArtifactId;

  if (input.gate && !input.gateApproved) {
    const gate = await gateWithRevisions(
      store,
      input,
      draftText,
      draftArtifactId,
    );

    if (gate.approvalRequired) {
      return {
        artifactId: gate.artifactId ?? draftArtifactId ?? "",
        text: gate.text,
        reused: false,
        approvalRequired: true,
        effectiveInputArtifactId: gate.artifactId ?? draftArtifactId,
        effectiveInputText: gate.text,
        approvalRequestId: gate.approvalRequestId,
        approvalExpiresAt: gate.approvalExpiresAt,
      };
    }

    draftText = gate.text;
    draftArtifactId = gate.artifactId;
  }

  heartbeat();

  let text = draftText;
  let costAmount = 0;
  let tokens = 0;
  let modelId = "none";
  let coderFailure: string | undefined;

  if (input.type === "agent") {
    const modelAlias = input.modelAlias ?? "deepseek-flash";
    const modelInput =
      input.includeInitialInput && input.evidenceText
        ? `Evidence set:\n${input.evidenceText}\n\nPrevious stage output:\n${draftText}`
        : draftText;
    const extraTools = createDeclarativeTools(input.packTools ?? [], {
      allowCommand: process.env.KIT_TOOLS_ALLOW_COMMAND === "1",
    });
    const definitions = toolDefinitions(input.tools ?? [], extraTools);

    if (definitions.length > 0 && !input.stub) {
      const result = await runAgentWithTools({
        store,
        input,
        modelAlias,
        instructions: input.instructions ?? "",
        modelInput,
        tools: definitions,
        extraTools,
      });
      text = result.text;
      costAmount = result.costCny;
      tokens = result.tokens;
    } else {
      await assertKillSwitchClear(
        store,
        {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          stageId: input.stageId,
          stageName: input.stageName,
        },
        "model",
      );
      const gateway = input.stub
        ? new StubModelGateway()
        : createModelGateway();
      const response = await gateway.complete({
        model: modelAlias,
        instructions: input.instructions ?? "",
        input: modelInput,
      });
      text = response.text;
      costAmount = response.usage.costCny ?? 0;
      tokens = response.usage.inputTokens + response.usage.outputTokens;
      await safeActivity(store, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: input.stageId,
        agentId: input.agentId,
        kind: "model.turn",
        status: "completed",
        summary: response.text.slice(0, 500),
        payload: {
          model: modelAlias,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          toolCalls: 0,
        },
      });
    }
    modelId = modelAlias;
  } else if (input.type === "coder") {
    await assertKillSwitchClear(
      store,
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        stageId: input.stageId,
        stageName: input.stageName,
      },
      "tool",
    );
    const heartbeatTimer = setInterval(() => {
      heartbeat();
    }, 30_000);
    try {
      const coder = await runCoderStage(store, input, draftText);
      text = coder.text;
      tokens = coder.tokens;
      modelId = input.coder ?? "dsh";
      coderFailure = coder.ok
        ? undefined
        : (coder.error ?? coder.summary ?? "coder failed");
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  heartbeat();

  const published = await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(text),
    producer: {
      agentId: input.agentId ?? "workflow",
      agentVersion: "1.0.0",
      promptHash: hash(input.instructions ?? input.stageName),
      modelId,
    },
    inputs: (input.inputArtifactIds?.length
      ? input.inputArtifactIds
      : draftArtifactId
        ? [draftArtifactId]
        : []
    ).map((artifactId) => ({ artifactId, version: 1 })),
    runId: input.runId,
    stageId: input.stageId,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: costAmount, tokens },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "artifact.published",
    status: "completed",
    summary: published.artifact.artifactId,
    payload: { modelId, tokens, costCny: costAmount },
  });

  if (coderFailure) {
    await store.stages.updateStatus(input.stageId, "failed", {
      finishedAt: new Date().toISOString(),
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      agentId: input.agentId,
      kind: "stage.finished",
      status: "failed",
      summary: coderFailure,
    });
    throw new Error(`coder stage failed: ${coderFailure}`);
  }

  await store.stages.updateStatus(input.stageId, "succeeded", {
    finishedAt: new Date().toISOString(),
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "stage.finished",
    status: "succeeded",
    summary: input.stageName,
    payload: { artifactId: published.artifact.artifactId, tokens },
  });

  return {
    artifactId: published.artifact.artifactId,
    text,
    reused: false,
    ...(input.gate
      ? {
          effectiveInputArtifactId: draftArtifactId,
          effectiveInputText: draftText,
        }
      : {}),
  };
}

export async function finishPackRun(input: {
  runId: string;
}): Promise<void> {
  const store = await getStore();
  await store.runs.updateStatus(
    input.runId,
    "succeeded",
    new Date().toISOString(),
  );
}

export async function failPackRun(input: {
  runId: string;
  reason: string;
}): Promise<void> {
  const store = await getStore();
  await store.runs.updateStatus(
    input.runId,
    "failed",
    new Date().toISOString(),
  );
}

export async function deliverPackRun(input: {
  runId: string;
  workspaceId: string;
  artifactId: string;
  channel: "im" | "email" | "local_file" | "webhook";
  runMode: "DRY_RUN" | "LIVE";
}): Promise<void> {
  const store = await getStore();
  await assertKillSwitchClear(
    store,
    { workspaceId: input.workspaceId },
    "delivery",
  );
  let result: Awaited<ReturnType<typeof deliverArtifact>>;

  try {
    const artifact = await store.artifactStore.findById(input.artifactId);
    if (!artifact) {
      throw new Error(`artifact not found: ${input.artifactId}`);
    }
    const manifest = await store.manifests.get(artifact.manifestId);
    const blob = await store.blobs.findById(artifact.blobId);
    if (!blob) {
      throw new Error(`blob not found for artifact ${input.artifactId}`);
    }
    const bytes = await store.blobClient.get(blob.storageKey);
    const markdown = new TextDecoder().decode(bytes);

    result = await deliverArtifact({
      channel: input.channel,
      runId: input.runId,
      artifactId: input.artifactId,
      title: manifest
        ? `${input.runId} · ${manifest.stageId}`
        : input.artifactId,
      markdown,
      runMode: input.runMode,
    });
  } catch (error) {
    result = {
      ok: false,
      channel: input.channel,
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(JSON.stringify(result, null, 2)),
    producer: {
      agentId: "delivery",
      agentVersion: "1.0.0",
      promptHash: createHash("sha256")
        .update(`delivery:${input.channel}`)
        .digest("hex"),
      modelId: "delivery",
    },
    inputs: [{ artifactId: input.artifactId, version: 1 }],
    runId: input.runId,
    stageId: `${input.artifactId}:delivery`,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
}

async function runCoderStage(
  store: Store,
  input: PackStageExecutionInput,
  draftText: string,
): Promise<{
  text: string;
  tokens: number;
  ok: boolean;
  summary: string;
  error?: string;
}> {
  const coder = input.coder ?? "dsh";
  const repoRoot = resolveRepoRoot();
  const slug = input.stageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sandboxRoot = coderSandboxRoot("stages", input.runId, slug);
  await mkdir(path.dirname(sandboxRoot), { recursive: true });

  const goal =
    input.goal ??
    `Complete stage "${input.stageName}" in this repository with the smallest correct change.`;
  const acceptance =
    input.acceptance ??
    "The stage is implemented, relevant checks pass, and the diff is minimal.";
  const context = [
    input.evidenceText ? `Evidence set:\n${input.evidenceText}` : "",
    draftText ? `Previous stage output:\n${draftText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "coder.started",
    status: "running",
    summary: `${coder} started`,
    payload: { stage: input.stageName, goal },
  });

  let eventChain = Promise.resolve();
  let result: CoderResult;
  try {
    result = await runCoderTask({
      coder,
      runId: input.runId,
      taskId: input.stageId,
      goal,
      acceptance,
      instructions: input.instructions ?? "",
      context,
      repoRoot,
      sandboxRoot,
      timeoutMs: input.timeoutMs ?? 25 * 60 * 1000,
      installDeps: process.env.KIT_CODER_INSTALL !== "0",
      keepSandbox: process.env.KIT_CODER_KEEP === "1",
      onEvent: (event) => {
        eventChain = eventChain.then(() =>
          safeActivity(store, {
            workspaceId: input.workspaceId,
            runId: input.runId,
            stageId: input.stageId,
            agentId: input.agentId,
            kind: `coder.${event.kind}`,
            status: event.status,
            tool: event.tool,
            summary: event.summary,
            payload: {
              turn: event.turn,
              step: event.step,
              ...(event.callId ? { callId: event.callId } : {}),
              ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
            },
          }),
        );
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      coder,
      ok: false,
      exitCode: null,
      summary: message,
      transcript: "",
      durationMs: 0,
      changedFiles: [],
      diff: "",
      error: message,
      sandbox: { mode: "copy", baselineSha: "", setupLog: "" },
    };
  }

  await eventChain;
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "coder.finished",
    status: result.ok ? "completed" : "failed",
    summary: result.summary,
    payload: {
      coder: result.coder,
      changedFiles: result.changedFiles,
      tokens: result.tokens ?? 0,
      ...(result.error ? { error: result.error } : {}),
    },
  });

  await publishCoderArtifacts(store, input, result);
  const text = renderCoderReport(input, result);
  return {
    text,
    tokens: result.tokens ?? 0,
    ok: result.ok,
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
  };
}

async function publishCoderArtifacts(
  store: Store,
  input: PackStageExecutionInput,
  result: CoderResult,
): Promise<void> {
  const publish = async (suffix: string, content: string, modelId: string) => {
    await store.artifactService.publish({
      workspaceId: input.workspaceId,
      content: new TextEncoder().encode(content),
      producer: {
        agentId: input.agentId ?? `coder:${result.coder}`,
        agentVersion: "0.9.0",
        promptHash: hash(`coder:${result.coder}`),
        modelId,
      },
      inputs: (input.inputArtifactIds?.length
        ? input.inputArtifactIds
        : input.inputArtifactId
          ? [input.inputArtifactId]
          : []
      ).map((artifactId) => ({ artifactId, version: 1 })),
      runId: input.runId,
      stageId: `${input.stageId}:coder:${suffix}`,
      runMode: input.runMode,
      cost: {
        currency: "CNY",
        amount: 0,
        tokens: suffix === "result" ? (result.tokens ?? 0) : 0,
      },
      sensitivity: "internal",
      retentionClass: "artifact_365d",
    });
  };

  await publish(
    "result",
    JSON.stringify(
      {
        coder: result.coder,
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        tokens: result.tokens ?? 0,
        summary: result.summary,
        error: result.error,
        changedFiles: result.changedFiles,
        sandbox: result.sandbox,
      },
      null,
      2,
    ),
    result.coder,
  );
  await publish(
    "transcript",
    result.transcript || "(empty transcript)",
    "none",
  );
  await publish("diff", result.diff || "(no diff)", "none");
}

function renderCoderReport(
  input: PackStageExecutionInput,
  result: CoderResult,
): string {
  const files =
    result.changedFiles.length > 0
      ? result.changedFiles.join("\n- ")
      : "(none)";
  const sandbox = result.sandbox.baselineSha
    ? `${result.sandbox.mode} @ ${result.sandbox.baselineSha.slice(0, 12)}`
    : `${result.sandbox.mode} (no baseline)`;
  return `# Coder stage: ${input.stageName}

- coder: ${result.coder}
- status: ${result.ok ? "ok" : "failed"}
- duration: ${Math.round(result.durationMs / 1000)}s
- tokens: ${result.tokens ?? 0}
- sandbox: ${sandbox}
${result.error ? `- error: ${result.error}\n` : ""}${result.timedOut ? "- timed out: true\n" : ""}
## Changed files
- ${files}

## Summary
${result.summary || "(no summary)"}

## Setup
${result.sandbox.setupLog || "(none)"}
`;
}

async function runAgentWithTools(input: {
  store: Store;
  input: PackStageExecutionInput;
  modelAlias: string;
  instructions: string;
  modelInput: string;
  tools: ReturnType<typeof toolDefinitions>;
  extraTools: Tool[];
}): Promise<{ text: string; costCny: number; tokens: number }> {
  const gateway = createModelGateway();
  const repoRoot = resolveRepoRoot();
  const sandboxRoot = path.join(
    repoRoot,
    ".tmp",
    "workspaces",
    input.input.runId,
  );
  await mkdir(sandboxRoot, { recursive: true });
  const context: ToolContext = {
    repoRoot,
    sandboxRoot,
    runId: input.input.runId,
    workspaceId: input.input.workspaceId,
    runMode: input.input.runMode,
    allowNetwork:
      input.input.runMode === "LIVE" ||
      process.env.KIT_TOOLS_ALLOW_NETWORK === "1",
    allowLocalhost: process.env.KIT_TOOLS_ALLOW_LOCALHOST !== "0",
  };

  const messages: ModelMessage[] = [
    {
      role: "system",
      content: `${input.instructions}

## Tool use rules
- Use only the declared tools. Never invent tool output.
- Work on this repository only. Read before writing.
- Put proposed changes in the run sandbox with workspace.write. Never claim the real repository was modified; use workspace.diff to show the patch.
- For security work, scope scanning to this repository. Do not attack third-party systems.
- For UX work, local URLs may be inspected only when the browser adapter is configured.
- After tools, finish with: findings, files changed, tests/commands run, risks, and next action.`,
    },
    { role: "user", content: input.modelInput },
  ];

  const maxSteps = Math.max(
    1,
    Math.min(Number(process.env.KIT_TOOL_MAX_STEPS ?? 10), 20),
  );
  const maxToolCalls = Math.max(
    1,
    Math.min(Number(process.env.KIT_TOOL_MAX_CALLS ?? 24), 60),
  );
  let costCny = 0;
  let tokens = 0;
  let toolCalls = 0;
  let toolIndex = 0;
  let lastText = "";
  const startedAt = Date.now();

  for (let step = 0; step < maxSteps; step += 1) {
    heartbeat();
    await assertKillSwitchClear(
      input.store,
      {
        workspaceId: input.input.workspaceId,
        agentId: input.input.agentId,
        stageId: input.input.stageId,
        stageName: input.input.stageName,
      },
      "model",
    );
    const response = await gateway.completeWithTools({
      model: input.modelAlias,
      messages,
      tools: input.tools,
      temperature: 0,
      maxTokens: 4096,
    });
    costCny += response.usage.costCny ?? 0;
    tokens += response.usage.inputTokens + response.usage.outputTokens;
    if (response.text) {
      lastText = response.text;
    }
    await safeActivity(input.store, {
      workspaceId: input.input.workspaceId,
      runId: input.input.runId,
      stageId: input.input.stageId,
      agentId: input.input.agentId,
      kind: "model.turn",
      status: "completed",
      summary: (response.text || `step ${step + 1}`).slice(0, 500),
      payload: {
        step: step + 1,
        model: input.modelAlias,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        toolCalls: response.toolCalls.length,
      },
    });
    if (response.toolCalls.length === 0) {
      return {
        text: response.text || lastText || "(no output)",
        costCny,
        tokens,
      };
    }
    messages.push(response.message);

    for (const call of response.toolCalls) {
      toolCalls += 1;
      toolIndex += 1;
      if (toolCalls > maxToolCalls) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "ERROR: tool call budget exhausted",
        });
        continue;
      }
      const started = Date.now();
      let content = "";
      let isError = false;
      await assertKillSwitchClear(
        input.store,
        {
          workspaceId: input.input.workspaceId,
          agentId: input.input.agentId,
          stageId: input.input.stageId,
          stageName: input.input.stageName,
        },
        "tool",
      );
      await safeActivity(input.store, {
        workspaceId: input.input.workspaceId,
        runId: input.input.runId,
        stageId: input.input.stageId,
        agentId: input.input.agentId,
        kind: "tool.call",
        status: "running",
        tool: call.name,
        summary: call.name,
        payload: { index: toolIndex, arguments: call.arguments },
      });
      try {
        const tool = getTool(call.name, input.extraTools);
        if (!tool) {
          throw new Error(`unknown tool: ${call.name}`);
        }
        const result = await executeTool(
          call.name,
          call.arguments,
          context,
          input.extraTools,
        );
        content = result.content;
        isError = result.isError === true;
      } catch (error) {
        content = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      const durationMs = Date.now() - started;
      await publishToolArtifact(input.store, input.input, {
        index: toolIndex,
        tool: call.name,
        args: call.arguments,
        content,
        isError,
        durationMs,
      });
      await safeActivity(input.store, {
        workspaceId: input.input.workspaceId,
        runId: input.input.runId,
        stageId: input.input.stageId,
        agentId: input.input.agentId,
        kind: "tool.result",
        status: isError ? "failed" : "completed",
        tool: call.name,
        summary: content.slice(0, 500),
        payload: { index: toolIndex, durationMs, isError },
      });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: content.slice(0, 30_000),
      });
      heartbeat();
    }

    if (Date.now() - startedAt > 8 * 60 * 1000) {
      break;
    }
  }

  messages.push({
    role: "user",
    content:
      "Tool budget reached. Do not call more tools. Give the final summary with findings, files changed, commands run, risks, and next action.",
  });
  await assertKillSwitchClear(
    input.store,
    {
      workspaceId: input.input.workspaceId,
      agentId: input.input.agentId,
      stageId: input.input.stageId,
      stageName: input.input.stageName,
    },
    "model",
  );
  const final = await gateway.completeWithTools({
    model: input.modelAlias,
    messages,
    tools: input.tools,
    temperature: 0,
    maxTokens: 4096,
  });
  costCny += final.usage.costCny ?? 0;
  tokens += final.usage.inputTokens + final.usage.outputTokens;
  return {
    text: final.text || lastText || "(tool budget reached; no final summary)",
    costCny,
    tokens,
  };
}

async function publishToolArtifact(
  store: Store,
  input: PackStageExecutionInput,
  call: {
    index: number;
    tool: string;
    args: Record<string, unknown>;
    content: string;
    isError: boolean;
    durationMs: number;
  },
): Promise<void> {
  const content = JSON.stringify(
    {
      tool: call.tool,
      arguments: call.args,
      isError: call.isError,
      durationMs: call.durationMs,
      result: call.content.slice(0, 20_000),
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );
  await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(content),
    producer: {
      agentId: input.agentId ?? "tool",
      agentVersion: "1.0.0",
      promptHash: hash(`tool:${call.tool}`),
      modelId: "tool",
    },
    inputs: [],
    runId: input.runId,
    stageId: `${input.stageId}:tool:${call.index}`,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
}

function resolveRepoRoot(): string {
  const cwd = process.cwd();
  if (
    path.basename(cwd) === "runtime" &&
    path.basename(path.dirname(cwd)) === "apps"
  ) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

export function deterministicGate(text: string): {
  pass: boolean;
  reasons: string[];
} {
  const trimmed = text.trim();
  const reasons: string[] = [];

  if (trimmed.length < 20) {
    reasons.push("output shorter than 20 characters");
  }
  if (/\bTODO\b/i.test(trimmed)) {
    reasons.push("contains TODO");
  }
  if (/\{\{[^}]+\}\}/.test(trimmed)) {
    reasons.push("contains unresolved template placeholder");
  }

  return { pass: reasons.length === 0, reasons };
}

async function gateWithRevisions(
  store: Store,
  input: PackStageExecutionInput,
  initialText: string,
  initialArtifactId: string | undefined,
): Promise<{
  text: string;
  artifactId?: string;
  summary: string;
  approvalRequired?: boolean;
  approvalRequestId?: string;
  approvalExpiresAt?: string;
}> {
  let text = initialText;
  let artifactId = initialArtifactId;
  let summary = "";
  const gateRefs: Array<{ artifactId: string; version: number }> = [];

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt += 1) {
    const gate = await evaluateGate(store, input, text, artifactId, attempt);
    if (gate.artifactId) {
      gateRefs.push({ artifactId: gate.artifactId, version: 1 });
    }
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      agentId: input.agentId,
      kind: "gate.evaluated",
      status: gate.pass ? "passed" : "failed",
      summary: gate.summary,
      payload: {
        attempt: attempt + 1,
        ...(gate.artifactId ? { artifactId: gate.artifactId } : {}),
      },
    });
    if (gate.pass) {
      return { text, artifactId, summary: gate.summary };
    }

    summary = gate.summary;

    if (attempt === MAX_REVISIONS || !input.revision) {
      break;
    }

    const revision = await reviseDraft(
      store,
      input,
      text,
      artifactId,
      gate.summary,
      attempt + 1,
    );
    text = revision.text;
    artifactId = revision.artifactId;
  }

  const approval = input.approval;
  const riskClass = approval?.riskClass ?? "medium";
  if (approval?.mode === "never") {
    throw new Error(`quality gate failed: ${summary || "revisions exhausted"}`);
  }

  const runCostCny = await calculateRunCost(store, input.runId);
  if (
    approval?.mode === "auto" &&
    autoApprovalAllowed(approval, runCostCny, input.stageName, riskClass)
  ) {
    await recordAutoApproval(store, input, {
      requestType: "gate_failure",
      summary,
      draftArtifactId: artifactId,
      riskClass,
      runCostCny,
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      agentId: input.agentId,
      kind: "approval.auto_approved",
      status: "completed",
      summary,
      payload: { riskClass, runCostCny, requestType: "gate_failure" },
    });
    return { text, artifactId, summary };
  }

  const request = await createApprovalRequest(store, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    runMode: input.runMode,
    stageId: input.stageId,
    stageName: input.stageName,
    requestType: "gate_failure",
    summary,
    draftArtifactId: artifactId,
    options: ["approve", "abort"],
    riskClass,
    ttlMs: approval?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
    gateRefs,
    notify: approval?.notify,
  });

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "approval.requested",
    status: "pending",
    summary,
    payload: {
      requestId: request.requestId,
      expiresAt: request.expiresAt,
      riskClass,
      requestType: "gate_failure",
    },
  });

  return {
    text,
    artifactId,
    summary,
    approvalRequired: true,
    approvalRequestId: request.requestId,
    approvalExpiresAt: request.expiresAt,
  };
}

export async function requestApproval(
  input: RequestApprovalInput,
): Promise<RequestApprovalResult> {
  const store = await getStore();
  const runCostCny = await calculateRunCost(store, input.runId);

  if (input.approval.mode === "never") {
    return { required: false, runCostCny };
  }

  if (
    input.approval.mode === "auto" &&
    autoApprovalAllowed(
      input.approval,
      runCostCny,
      input.stageName,
      input.approval.riskClass,
    )
  ) {
    await recordAutoApproval(store, input, {
      requestType: input.requestType,
      summary: input.summary,
      draftArtifactId: input.draftArtifactId,
      riskClass: input.approval.riskClass,
      runCostCny,
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      kind: "approval.auto_approved",
      status: "completed",
      summary: input.summary,
      payload: {
        riskClass: input.approval.riskClass,
        runCostCny,
        requestType: input.requestType,
      },
    });
    return { required: false, autoApproved: true, runCostCny };
  }

  const stageSuffix = `approval-request-${input.requestType}`;
  const existing = await store.artifactStore.findCommittedByRunStage(
    input.runId,
    `${input.stageId}:${stageSuffix}`,
  );
  if (existing) {
    try {
      const parsed = JSON.parse(await readArtifactText(store, existing)) as {
        requestId?: string;
        expiresAt?: string;
      };
      if (parsed.requestId) {
        return {
          required: true,
          requestId: parsed.requestId,
          expiresAt: parsed.expiresAt,
          runCostCny,
        };
      }
    } catch {
      // fall through and create a fresh request
    }
  }

  const request = await createApprovalRequest(store, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    runMode: input.runMode,
    stageId: input.stageId,
    stageName: input.stageName,
    requestType: input.requestType,
    summary: input.summary,
    draftArtifactId: input.draftArtifactId,
    options: input.options,
    riskClass: input.approval.riskClass,
    ttlMs: input.approval.ttlMs,
    notify: input.approval.notify,
    stageSuffix,
  });

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    kind: "approval.requested",
    status: "pending",
    summary: input.summary,
    payload: {
      requestId: request.requestId,
      expiresAt: request.expiresAt,
      riskClass: input.approval.riskClass,
      requestType: input.requestType,
    },
  });

  return {
    required: true,
    requestId: request.requestId,
    expiresAt: request.expiresAt,
    runCostCny,
  };
}

async function createApprovalRequest(
  store: Store,
  input: {
    runId: string;
    workspaceId: string;
    runMode: "DRY_RUN" | "LIVE";
    stageId: string;
    stageName: string;
    requestType: "stage_before" | "stage_after" | "gate_failure";
    summary: string;
    draftArtifactId?: string;
    options: string[];
    riskClass: "low" | "medium" | "high";
    ttlMs: number;
    gateRefs?: Array<{ artifactId: string; version: number }>;
    notify?: { webhook?: string; tokenEnv?: string };
    stageSuffix?: string;
  },
): Promise<{ requestId: string; expiresAt: string }> {
  const requestId = newId("apr");
  const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
  const request = {
    requestId,
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageName,
    requestType: input.requestType,
    draftArtifactId: input.draftArtifactId ?? null,
    draftVersion: 1,
    summary: input.summary,
    options: input.options,
    riskClass: input.riskClass,
    gateRefs: input.gateRefs ?? [],
    requestedBy: "manager",
    expiresAt,
    ttlMs: input.ttlMs,
  };

  let notified = false;
  let notifyError: string | undefined;
  if (input.notify?.webhook) {
    try {
      await notifyApprovalWebhook(input.notify, request);
      notified = true;
    } catch (error) {
      notifyError = error instanceof Error ? error.message : String(error);
    }
  }

  await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(
      JSON.stringify({ ...request, notified, notifyError }, null, 2),
    ),
    producer: {
      agentId: "manager",
      agentVersion: "1.0.0",
      promptHash: hash("approval-request"),
      modelId: "none",
    },
    inputs: input.draftArtifactId
      ? [{ artifactId: input.draftArtifactId, version: 1 }]
      : [],
    runId: input.runId,
    stageId: `${input.stageId}:${input.stageSuffix ?? "approval-request"}`,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });

  return { requestId, expiresAt };
}

async function recordAutoApproval(
  store: Store,
  input: {
    runId: string;
    workspaceId: string;
    runMode: "DRY_RUN" | "LIVE";
    stageId: string;
    stageName: string;
  },
  details: {
    requestType: "stage_before" | "stage_after" | "gate_failure";
    summary: string;
    draftArtifactId?: string;
    riskClass: "low" | "medium" | "high";
    runCostCny: number;
  },
): Promise<void> {
  const decisionId = newId("dec");
  const content = {
    decisionId,
    runId: input.runId,
    stageId: input.stageId,
    stageName: input.stageName,
    requestType: details.requestType,
    decision: "approve",
    actor: "policy:autopilot",
    rationale: `auto-approved by pack policy (${details.requestType}); cost ${details.runCostCny.toFixed(4)} CNY`,
    riskClass: details.riskClass,
    runCostCny: details.runCostCny,
    summary: details.summary,
    createdAt: new Date().toISOString(),
  };

  await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(JSON.stringify(content, null, 2)),
    producer: {
      agentId: "policy",
      agentVersion: "1.0.0",
      promptHash: hash("auto-approval"),
      modelId: "none",
    },
    inputs: details.draftArtifactId
      ? [{ artifactId: details.draftArtifactId, version: 1 }]
      : [],
    runId: input.runId,
    stageId: `${input.stageId}:manager-decision-auto-${decisionId}`,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: 0, tokens: 0 },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
}

function autoApprovalAllowed(
  approval: NonNullable<PackStageExecutionInput["approval"]>,
  runCostCny: number,
  stageName: string,
  riskClass: "low" | "medium" | "high",
): boolean {
  const when = approval.autoApproveWhen;
  if (!when) {
    return false;
  }
  if (when.maxRunCostCny !== undefined && runCostCny > when.maxRunCostCny) {
    return false;
  }
  if (when.riskClass && !when.riskClass.includes(riskClass)) {
    return false;
  }
  if (
    when.stages &&
    !when.stages.includes(stageName) &&
    !when.stages.includes("*")
  ) {
    return false;
  }
  return true;
}

async function calculateRunCost(store: Store, runId: string): Promise<number> {
  const artifacts = await store.artifactStore.listByRun(runId);
  let total = 0;
  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    total += manifest?.cost.amount ?? 0;
  }
  return Math.round(total * 10000) / 10000;
}

async function notifyApprovalWebhook(
  notify: { webhook?: string; tokenEnv?: string },
  payload: Record<string, unknown>,
): Promise<void> {
  if (!notify.webhook) {
    return;
  }
  const body = JSON.stringify({
    type: "approval.requested",
    ...payload,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "agent-team-kit/0.1",
  };
  const token = notify.tokenEnv ? process.env[notify.tokenEnv] : undefined;
  if (token) {
    headers["x-kit-signature"] = `sha256=${createHmac("sha256", token)
      .update(body)
      .digest("hex")}`;
  }
  const response = await fetch(notify.webhook, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`webhook ${response.status} ${response.statusText}`);
  }
}

export async function setPackRunStatus(input: {
  runId: string;
  status: "paused" | "running";
}): Promise<void> {
  const store = await getStore();
  await store.runs.updateStatus(
    input.runId,
    input.status,
    new Date().toISOString(),
  );
}

async function evaluateGate(
  store: Store,
  input: PackStageExecutionInput,
  draftText: string,
  draftArtifactId: string | undefined,
  attempt: number,
): Promise<{ pass: boolean; artifactId: string; summary: string }> {
  if (!input.gate) {
    throw new Error("gate input missing");
  }

  const gateStageId = `${input.stageId}:gate:${attempt}`;
  const existing = await store.artifactStore.findCommittedByRunStage(
    input.runId,
    gateStageId,
  );

  if (existing) {
    const content = await readArtifactText(store, existing);
    try {
      const parsed = JSON.parse(content) as {
        pass?: boolean;
        rationale?: string;
      };
      return {
        pass: parsed.pass === true,
        artifactId: existing.artifactId,
        summary: parsed.rationale ?? "",
      };
    } catch {
      return {
        pass: false,
        artifactId: existing.artifactId,
        summary: "invalid gate artifact",
      };
    }
  }

  const deterministic = deterministicGate(draftText);
  let pass = deterministic.pass;
  let scores: Record<string, number> = {};
  let rationale = deterministic.reasons.join("; ");
  let judgeModel = "stub";
  let cost = 0;
  let tokens = 0;

  if (!input.stub) {
    await assertKillSwitchClear(
      store,
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        stageId: input.stageId,
        stageName: input.stageName,
      },
      "model",
    );
    judgeModel = "deepseek-pro";
    const gateway = createModelGateway();
    const dimensions = Object.entries(input.gate.dimensions)
      .map(([name, config]) => `${name} (weight ${config.weight})`)
      .join(", ");

    const response = await gateway.complete({
      model: judgeModel,
      instructions: `You are an independent quality evaluator. Score the draft on these dimensions from 0 to 1: ${dimensions}. Verify that every [S#] citation exists in the evidence set. Return JSON only: {"scores":{"dimension":0.0},"rationale":"short"}.`,
      input: `Evidence set:\n${input.evidenceText ?? "(none)"}\n\nDraft:\n${draftText}`,
    });

    cost = response.usage.costCny ?? 0;
    tokens = response.usage.inputTokens + response.usage.outputTokens;

    const parsed = parseJudge(response.text);
    scores = parsed.scores;
    rationale = parsed.rationale || rationale;

    if (Object.keys(scores).length === 0) {
      pass = false;
    }

    for (const [name, config] of Object.entries(input.gate.dimensions)) {
      const threshold =
        config.threshold > 1 ? config.threshold / 5 : config.threshold;
      if ((scores[name] ?? 0) < threshold) {
        pass = false;
      }
    }
  }

  const thresholds = Object.fromEntries(
    Object.entries(input.gate.dimensions).map(([name, config]) => [
      name,
      config.threshold > 1 ? config.threshold / 5 : config.threshold,
    ]),
  );

  const content = JSON.stringify(
    {
      pass,
      attempt,
      deterministic,
      scores,
      thresholds,
      rationale,
      rubricRef: input.gate.ref,
      judgeModel,
      draftChars: draftText.length,
    },
    null,
    2,
  );

  const published = await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(content),
    producer: {
      agentId: "evaluator",
      agentVersion: "1.0.0",
      promptHash: hash(input.gate.ref),
      modelId: judgeModel,
    },
    inputs: draftArtifactId
      ? [{ artifactId: draftArtifactId, version: 1 }]
      : [],
    runId: input.runId,
    stageId: gateStageId,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: cost, tokens },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });

  heartbeat();

  return {
    pass,
    artifactId: published.artifact.artifactId,
    summary: rationale,
  };
}

async function reviseDraft(
  store: Store,
  input: PackStageExecutionInput,
  draftText: string,
  draftArtifactId: string | undefined,
  feedback: string,
  revisionIndex: number,
): Promise<{ text: string; artifactId: string }> {
  if (!input.revision) {
    throw new Error("revision spec missing");
  }

  await assertKillSwitchClear(
    store,
    {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      stageId: input.stageId,
      stageName: input.stageName,
    },
    "model",
  );
  const gateway = input.stub ? new StubModelGateway() : createModelGateway();
  const response = await gateway.complete({
    model: input.revision.modelAlias,
    instructions: input.revision.instructions,
    input: `Evidence set:\n${input.evidenceText ?? "(none)"}\n\nCurrent draft:\n${draftText}\n\nQuality gate feedback:\n${feedback}\n\nRevise the draft to fix these issues. Keep [S#] citations and the Recommendations section.`,
  });

  const published = await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(response.text),
    producer: {
      agentId: input.revision.agentId,
      agentVersion: "1.0.0",
      promptHash: hash(input.revision.instructions),
      modelId: input.revision.modelAlias,
    },
    inputs: draftArtifactId
      ? [{ artifactId: draftArtifactId, version: 1 }]
      : [],
    runId: input.runId,
    stageId: `${input.stageId}:revision-${revisionIndex}`,
    runMode: input.runMode,
    cost: {
      currency: "CNY",
      amount: response.usage.costCny ?? 0,
      tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });

  heartbeat();

  return { text: response.text, artifactId: published.artifact.artifactId };
}

function parseJudge(text: string): {
  scores: Record<string, number>;
  rationale: string;
} {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      scores?: Record<string, unknown>;
      rationale?: unknown;
    };
    const scores: Record<string, number> = {};

    for (const [name, value] of Object.entries(parsed.scores ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) {
        scores[name] = value;
      }
    }

    return {
      scores,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    };
  } catch {
    return { scores: {}, rationale: "invalid judge response" };
  }
}

async function readArtifactText(
  store: Store,
  artifact: { artifactId: string; manifestId: string; blobId: string },
): Promise<string> {
  const blob = await store.blobs.findById(artifact.blobId);
  if (!blob) {
    return "";
  }
  const bytes = await store.blobClient.get(blob.storageKey);
  return new TextDecoder().decode(bytes);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
