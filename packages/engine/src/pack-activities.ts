import { createHash, createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type ActivityInput, appendActivity } from "@kit/activity";
import {
  type CoderResult,
  type CoderStreamEvent,
  coderSandboxRoot,
  runCoderTask,
} from "@kit/coder";
import { cnyToMicro, newId, runModeAllowsOutbound } from "@kit/core";
import { deliverArtifact } from "@kit/delivery";
import {
  type ModelMessage,
  StubModelGateway,
  calculateCostCny,
  createModelGateway,
} from "@kit/model";
import { type AlertInput, emitAlert, getOpsGate } from "@kit/ops";
import {
  type BudgetRecord,
  type OpLogEntry,
  appendOp,
  initStore,
  verifyArtifactVersion,
} from "@kit/store";
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
import { callWithCircuitBreaker, circuitDimensions } from "./circuit-breaker";
import {
  attachStageArtifact,
  recordCoderCost,
  recordToolCall,
  trackedGateway,
} from "./cost-attribution";
import { heartbeat } from "./heartbeat";
import { assertKillSwitchClear } from "./kill-switch";
import { createSideEffectGateway } from "./side-effect-gateway";
import {
  type TranscriptToolCall,
  type TranscriptTurn,
  computeGateScore,
  publishStageInstructions,
  publishStageTranscript,
  summarizeRequest,
  summarizeResponse,
  summarizeToolArgs,
  summarizeToolResult,
} from "./stage-dossier";
import { assertWriteLeaseActive, writeLeaseOptions } from "./write-lease";

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

// The op log is audit; a failed audit write must not fail a run.
async function safeOp(store: Store, entry: OpLogEntry): Promise<void> {
  try {
    await appendOp(store, entry);
  } catch (error) {
    console.error(
      `[op-log] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Alerting must never break a run.
async function safeAlert(store: Store, input: AlertInput): Promise<void> {
  try {
    await emitAlert(store, input);
  } catch (error) {
    console.error(
      `[ops] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The approvals entity is a projection of the approval artifact; failing to
// write it delays the inbox entry but must never abort the run.
function logApprovalEnqueueError(error: unknown): void {
  console.error(
    `[approvals] ${error instanceof Error ? error.message : String(error)}`,
  );
}

class BudgetPauseError extends Error {
  constructor(
    message: string,
    readonly blockingBudgetId?: string,
  ) {
    super(message);
    this.name = "BudgetPauseError";
  }
}

function estimateModelCall(
  modelAlias: string,
  inputChars: number,
  maxOutputTokens: number,
): { cnyMicro: number; tokens: number } {
  const inputTokens = Math.max(1, Math.ceil(inputChars) + 500);
  const outputTokens = Math.max(1, Math.ceil(maxOutputTokens));
  return {
    cnyMicro: cnyToMicro(
      calculateCostCny(modelAlias, inputTokens, outputTokens),
    ),
    tokens: inputTokens + outputTokens,
  };
}

function messageChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      chars += message.content?.length ?? 0;
      for (const call of message.toolCalls ?? []) {
        chars += call.name.length + JSON.stringify(call.arguments).length;
      }
      continue;
    }
    if (message.role === "tool") {
      chars += message.content.length + (message.name?.length ?? 0);
      continue;
    }
    chars += message.content.length;
  }
  return chars;
}

function coderTokenBound(): number {
  const parsed = Number(process.env.KIT_CODER_MAX_TOKENS ?? 200_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 200_000;
}

async function pauseForBudget(
  store: Store,
  input: PackStageExecutionInput,
  message: string,
  blocking: BudgetRecord | null,
): Promise<void> {
  await store.runs.updateStatus(
    input.runId,
    "paused",
    new Date().toISOString(),
    writeLeaseOptions(),
  );
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "run",
    entityId: input.runId,
    op: "run.pause",
    actor: "engine",
    origin: "system",
    payload: {
      stageId: input.stageId,
      reason: message,
      blockingBudgetId: blocking?.budgetId ?? null,
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "budget.exceeded",
    status: "paused",
    summary: message,
    payload: blocking
      ? {
          budgetId: blocking.budgetId,
          scope: blocking.scope,
          spentCnyMicro: blocking.spentCnyMicro,
          reservedCnyMicro: blocking.reservedCnyMicro,
          limitCnyMicro: blocking.limitCnyMicro,
          spentTokens: blocking.spentTokens,
          reservedTokens: blocking.reservedTokens,
          limitTokens: blocking.limitTokens,
        }
      : {},
  });
}

async function emitBudgetAlerts(
  store: Store,
  input: PackStageExecutionInput,
  alerts: BudgetRecord[],
): Promise<void> {
  for (const budget of alerts) {
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      agentId: input.agentId,
      kind: "budget.warning",
      status: "warning",
      summary: `${budget.scope} budget reached 80%`,
      payload: {
        budgetId: budget.budgetId,
        scope: budget.scope,
        targetKey: budget.targetKey,
        spentCnyMicro: budget.spentCnyMicro,
        limitCnyMicro: budget.limitCnyMicro,
        spentTokens: budget.spentTokens,
        limitTokens: budget.limitTokens,
      },
    });
  }
}

async function withBudget<T>(
  store: Store,
  input: PackStageExecutionInput,
  purpose: string,
  estimate: { cnyMicro: number; tokens: number },
  call: () => Promise<T>,
  usage: (value: T) => { cny: number; tokens: number },
): Promise<T> {
  const reserved = await store.budgetService.reserve({
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    purpose,
    amountCnyMicro: estimate.cnyMicro,
    amountTokens: estimate.tokens,
  });
  if (!reserved.ok) {
    await pauseForBudget(store, input, reserved.message, reserved.blocking);
    throw new BudgetPauseError(reserved.message, reserved.blocking?.budgetId);
  }

  let value: T;
  try {
    value = await call();
  } catch (error) {
    await store.budgetService
      .release(reserved.reservationId)
      .catch(() => undefined);
    throw error;
  }

  const used = usage(value);
  const committed = await store.budgetService.commit(reserved.reservationId, {
    cnyMicro: cnyToMicro(used.cny),
    tokens: used.tokens,
  });
  if (!committed.ok) {
    throw new Error(committed.message ?? "budget commit failed");
  }
  await emitBudgetAlerts(store, input, committed.alerts);
  if (committed.overshoot) {
    const message = "provider usage exceeded the reserved budget bound";
    await pauseForBudget(store, input, message, null);
    throw new BudgetPauseError(message);
  }
  return value;
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
  assertWriteLeaseActive();
  const store = await getStore();
  await assertKillSwitchClear(store, { workspaceId: input.workspaceId }, "run");
  const now = new Date().toISOString();

  const budget = await store.budgetService.ensureRunBudgets({
    workspaceId: input.workspaceId,
    runId: input.runId,
    ...(input.budget ? { spec: input.budget } : {}),
    stages: input.stages.map((stage) => ({
      stageId: stage.stageId,
      ...(stage.agentId ? { agentId: stage.agentId } : {}),
    })),
  });
  if (!budget.ok) {
    throw new Error(`budget setup failed: ${budget.errors.join("; ")}`);
  }

  await store.runs.create({
    runId: input.runId,
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    runMode: input.runMode,
    status: "running",
    ...(input.origin ? { originKind: input.origin.kind } : {}),
    ...(input.origin?.triggerId ? { triggerId: input.origin.triggerId } : {}),
    ...(input.origin?.triggerRunId
      ? { triggerRunId: input.origin.triggerRunId }
      : {}),
    ...(input.origin?.reactionRuleId
      ? { reactionRuleId: input.origin.reactionRuleId }
      : {}),
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

  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "run",
    entityId: input.runId,
    op: "run.create",
    actor: "engine",
    origin: "system",
    idempotencyKey: `run.create:${input.runId}`,
    payload: {
      eventId: input.eventId,
      workflowId: input.workflowId,
      workflowVersion: input.workflowVersion,
      runMode: input.runMode,
      stages: input.stages.map((stage) => stage.stageId),
    },
  });

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
    if (error instanceof BudgetPauseError) {
      span.setAttribute("budget.paused", true);
      span.setStatus({ code: SpanStatusCode.OK });
      return {
        artifactId: "",
        text: "",
        reused: false,
        budgetPaused: true,
        budgetSummary: error.message,
        ...(error.blockingBudgetId
          ? { blockingBudgetId: error.blockingBudgetId }
          : {}),
      };
    }
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
  assertWriteLeaseActive();
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
    // Resume-from-artifact is the local checkpoint (61 §3.5): verify sha256
    // and Manifest integrity before reusing the committed version.
    const integrity = await verifyArtifactVersion(
      store,
      existing.artifactId,
      existing.version,
    );
    if (!integrity.ok) {
      const reason = `artifact integrity check failed: ${integrity.problems
        .map((problem) => `${problem.code}=${problem.detail}`)
        .join("; ")}`;
      await safeOp(store, {
        workspaceId: input.workspaceId,
        entityKind: "stage",
        entityId: input.stageId,
        op: "stage.integrity.failed",
        actor: "engine",
        origin: "system",
        payload: {
          runId: input.runId,
          artifactId: existing.artifactId,
          problems: integrity.problems,
        },
      });
      await safeActivity(store, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: input.stageId,
        agentId: input.agentId,
        kind: "stage.integrity.failed",
        status: "failed",
        summary: reason.slice(0, 500),
        payload: { artifactId: existing.artifactId },
      });
      throw new Error(reason);
    }
    const text = await readArtifactText(store, existing);
    await store.stages.updateStatus(
      input.stageId,
      "succeeded",
      {
        finishedAt: new Date().toISOString(),
      },
      writeLeaseOptions(),
    );
    await safeOp(store, {
      workspaceId: input.workspaceId,
      entityKind: "stage",
      entityId: input.stageId,
      op: "stage.status",
      actor: "engine",
      origin: "system",
      payload: {
        runId: input.runId,
        status: "succeeded",
        reused: true,
        artifactId: existing.artifactId,
      },
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

  const startedAt = new Date().toISOString();
  await store.stages.updateStatus(
    input.stageId,
    "running",
    { startedAt },
    writeLeaseOptions(),
  );
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "stage",
    entityId: input.stageId,
    op: "stage.status",
    actor: "engine",
    origin: "system",
    payload: { runId: input.runId, status: "running", type: input.type },
  });

  const promptHash = hash(input.instructions ?? input.stageName);
  const run = await store.runs.get(input.runId).catch(() => null);
  const workflowId = run?.workflowId ?? null;
  const workflowVersion = run?.workflowVersion ?? null;
  const instructionsArtifactId = await publishStageInstructions(store, input, {
    promptHash,
    modelId:
      input.type === "coder"
        ? (input.coder ?? "dsh")
        : input.type === "agent"
          ? (input.modelAlias ?? "deepseek-flash")
          : "none",
    workflowId,
    workflowVersion,
  });

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "stage.started",
    status: "running",
    summary: input.stageName,
    payload: {
      type: input.type,
      ...(instructionsArtifactId ? { instructionsArtifactId } : {}),
    },
  });

  let draftText = input.inputText;
  let draftArtifactId = input.inputArtifactId;
  let gateScore: number | null = null;

  if (input.gate && !input.gateApproved) {
    const gate = await gateWithRevisions(
      store,
      input,
      draftText,
      draftArtifactId,
    );

    gateScore = gate.gateScore;

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
  assertWriteLeaseActive();

  let text = draftText;
  let costAmount = 0;
  let tokens = 0;
  let modelId = "none";
  let coderFailure: string | undefined;
  const turns: TranscriptTurn[] = [];

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
      turns.push(...result.turns);
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
      const gateway = trackedGateway(
        store,
        {
          workspaceId: input.workspaceId,
          runId: input.runId,
          stageId: input.stageId,
          agentId: input.agentId,
        },
        input.stub ? new StubModelGateway() : createModelGateway(),
      );
      const instructions = input.instructions ?? "";
      const response = await withBudget(
        store,
        input,
        "model",
        estimateModelCall(
          modelAlias,
          instructions.length + modelInput.length,
          4096,
        ),
        () =>
          callWithCircuitBreaker(
            store,
            circuitDimensions({
              workspaceId: input.workspaceId,
              agentId: input.agentId,
              modelAlias,
            }),
            () =>
              gateway.complete({
                model: modelAlias,
                instructions,
                input: modelInput,
              }),
          ),
        (value) => ({
          cny: value.usage.costCny ?? 0,
          tokens: value.usage.inputTokens + value.usage.outputTokens,
        }),
      );
      text = response.text;
      costAmount = response.usage.costCny ?? 0;
      tokens = response.usage.inputTokens + response.usage.outputTokens;
      turns.push({
        index: 1,
        kind: "model",
        requestSummary: summarizeRequest(modelInput).text,
        responseSummary: summarizeResponse(response.text).text,
        toolCalls: [],
      });
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
      turns.push(...coder.turns);
      coderFailure = coder.ok
        ? undefined
        : (coder.error ?? coder.summary ?? "coder failed");
    } finally {
      clearInterval(heartbeatTimer);
    }
    await recordCoderCost(
      store,
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: input.stageId,
        agentId: input.agentId,
      },
      { coder: input.coder ?? "dsh", tokens },
    );
  }

  heartbeat();
  assertWriteLeaseActive();

  const inputRefs = (
    input.inputArtifactIds?.length
      ? input.inputArtifactIds
      : draftArtifactId
        ? [draftArtifactId]
        : []
  ).map((artifactId) => ({ artifactId, version: 1 }));

  const published = await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(text),
    producer: {
      agentId: input.agentId ?? "workflow",
      agentVersion: "1.0.0",
      promptHash,
      modelId,
    },
    inputs: inputRefs,
    runId: input.runId,
    stageId: input.stageId,
    runMode: input.runMode,
    cost: { currency: "CNY", amount: costAmount, tokens },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
  await attachStageArtifact(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    artifactId: published.artifact.artifactId,
  });

  const transcriptArtifactId = await publishStageTranscript(store, input, {
    instructionsArtifactId,
    outputArtifactId: published.artifact.artifactId,
    inputs: inputRefs,
    gateScore,
    turns,
    finalResponse: text,
    promptHash,
    modelId,
    workflowId,
    workflowVersion,
    startedAt,
  });

  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "artifact.published",
    status: "completed",
    summary: published.artifact.artifactId,
    payload: {
      modelId,
      tokens,
      costCny: costAmount,
      ...(instructionsArtifactId ? { instructionsArtifactId } : {}),
      ...(transcriptArtifactId ? { transcriptArtifactId } : {}),
    },
  });

  if (coderFailure) {
    await store.stages.updateStatus(
      input.stageId,
      "failed",
      {
        finishedAt: new Date().toISOString(),
      },
      writeLeaseOptions(),
    );
    await safeOp(store, {
      workspaceId: input.workspaceId,
      entityKind: "stage",
      entityId: input.stageId,
      op: "stage.status",
      actor: "engine",
      origin: "system",
      payload: { runId: input.runId, status: "failed", error: coderFailure },
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      agentId: input.agentId,
      kind: "stage.finished",
      status: "failed",
      summary: coderFailure,
      payload: {
        ...(instructionsArtifactId ? { instructionsArtifactId } : {}),
        ...(transcriptArtifactId ? { transcriptArtifactId } : {}),
      },
    });
    throw new Error(`coder stage failed: ${coderFailure}`);
  }

  await store.stages.updateStatus(
    input.stageId,
    "succeeded",
    {
      finishedAt: new Date().toISOString(),
    },
    writeLeaseOptions(),
  );
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "stage",
    entityId: input.stageId,
    op: "stage.status",
    actor: "engine",
    origin: "system",
    payload: {
      runId: input.runId,
      status: "succeeded",
      artifactId: published.artifact.artifactId,
      tokens,
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: input.stageId,
    agentId: input.agentId,
    kind: "stage.finished",
    status: "succeeded",
    summary: input.stageName,
    payload: {
      artifactId: published.artifact.artifactId,
      tokens,
      ...(instructionsArtifactId ? { instructionsArtifactId } : {}),
      ...(transcriptArtifactId ? { transcriptArtifactId } : {}),
    },
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
  assertWriteLeaseActive();
  const store = await getStore();
  await store.runs.updateStatus(
    input.runId,
    "succeeded",
    new Date().toISOString(),
    writeLeaseOptions(),
  );
  const run = await store.runs.get(input.runId);
  const workspaceId = run?.workspaceId ?? "default";
  await safeOp(store, {
    workspaceId,
    entityKind: "run",
    entityId: input.runId,
    op: "run.status",
    actor: "engine",
    origin: "system",
    payload: { status: "succeeded" },
  });
  await alertCostAnomaly(store, workspaceId, input.runId);
}

/**
 * Emit one daily cost-anomaly alert when today's spend is a z-score outlier
 * against the trailing baseline (60 §3.3); deduplicated per workspace-day.
 */
async function alertCostAnomaly(
  store: Store,
  workspaceId: string,
  runId: string,
): Promise<void> {
  let anomaly:
    | { dayKey: string; costCnyMicro: number; zScore: number }
    | undefined;
  try {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10);
    anomaly = (
      await store.costLedger.anomalies({ workspaceId, until: now })
    ).find((item) => item.dayKey === dayKey);
  } catch (error) {
    console.error(
      `[cost] anomaly check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!anomaly) {
    return;
  }
  await safeAlert(store, {
    workspaceId,
    tier: "P2",
    kind: "cost.anomaly",
    title: `Daily cost anomaly (${anomaly.dayKey})`,
    body: `Daily spend ¥${(anomaly.costCnyMicro / 1_000_000).toFixed(4)} is z=${anomaly.zScore} above the trailing baseline.`,
    dedupeKey: `cost.anomaly:${workspaceId}:${anomaly.dayKey}`,
    runId,
    source: "engine",
    meta: {
      dayKey: anomaly.dayKey,
      costCnyMicro: anomaly.costCnyMicro,
      zScore: anomaly.zScore,
    },
  });
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
    writeLeaseOptions(),
  );
  const run = await store.runs.get(input.runId);
  await safeOp(store, {
    workspaceId: run?.workspaceId ?? "default",
    entityKind: "run",
    entityId: input.runId,
    op: "run.status",
    actor: "engine",
    origin: "system",
    payload: { status: "failed", reason: input.reason },
  });
  await safeAlert(store, {
    workspaceId: run?.workspaceId ?? "default",
    tier: "P1",
    kind: "run.failed",
    title: `Run failed: ${input.runId}`,
    body: input.reason,
    runId: input.runId,
    source: "engine",
  });
}

export async function deliverPackRun(input: {
  runId: string;
  workspaceId: string;
  artifactId: string;
  channel: "im" | "email" | "local_file" | "webhook";
  runMode: "DRY_RUN" | "LIVE";
}): Promise<void> {
  assertWriteLeaseActive();
  const store = await getStore();
  await assertKillSwitchClear(
    store,
    { workspaceId: input.workspaceId },
    "delivery",
  );
  const gate = await getOpsGate(store);
  let result: Awaited<ReturnType<typeof deliverArtifact>>;

  if (gate.readOnly) {
    result = {
      ok: false,
      channel: input.channel,
      skipped: true,
      detail: `skipped: ${gate.reason ?? "night mode"}`,
    };
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.runId,
      agentId: "ops",
      kind: "ops.side_effect.blocked",
      status: "blocked",
      summary: `delivery skipped: ${gate.reason ?? "night mode"}`,
      payload: { action: "delivery", channel: input.channel },
    });
  } else {
    // 20 §2.4: delivery is a real side effect. It only leaves the process
    // when the run mode permits it; otherwise the gateway records the refusal
    // and returns a stub so non-LIVE runs never deliver.
    const gateway = createSideEffectGateway({ store });
    const outcome = await gateway.run<
      Awaited<ReturnType<typeof deliverArtifact>>
    >(
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        runMode: input.runMode,
        action: `delivery.${input.channel}`,
        target: input.channel,
      },
      {
        execute: async () => {
          try {
            const artifact = await store.artifactStore.findById(
              input.artifactId,
            );
            if (!artifact) {
              throw new Error(`artifact not found: ${input.artifactId}`);
            }
            const manifest = await store.manifests.get(artifact.manifestId);
            const blob = await store.blobs.findById(artifact.blobId);
            if (!blob) {
              throw new Error(
                `blob not found for artifact ${input.artifactId}`,
              );
            }
            const bytes = await store.blobClient.get(blob.storageKey);
            const markdown = new TextDecoder().decode(bytes);

            return await deliverArtifact({
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
            return {
              ok: false,
              channel: input.channel,
              skipped: false,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        },
        stub: () => ({
          ok: true,
          channel: input.channel,
          skipped: true,
          detail: `stub: real ${input.channel} delivery refused in ${input.runMode} run`,
        }),
      },
    );
    result = outcome.value;

    if (!outcome.executed) {
      await safeActivity(store, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        agentId: "ops",
        kind: "ops.side_effect.blocked",
        status: "blocked",
        summary: `delivery refused: ${input.runMode} run`,
        payload: {
          action: "delivery",
          channel: input.channel,
          runMode: input.runMode,
        },
      });
    }
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
  turns: TranscriptTurn[];
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
  const coderEvents: CoderStreamEvent[] = [];
  let result: CoderResult;
  try {
    result = await withBudget(
      store,
      input,
      "coder",
      { cnyMicro: 0, tokens: coderTokenBound() },
      () =>
        runCoderTask({
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
            coderEvents.push(event);
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
                  ...(event.tokens !== undefined
                    ? { tokens: event.tokens }
                    : {}),
                },
              }),
            );
          },
        }),
      (value) => ({ cny: 0, tokens: value.tokens ?? 0 }),
    );
  } catch (error) {
    if (error instanceof BudgetPauseError) {
      throw error;
    }
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
    turns: buildCoderTurns(coderEvents, coder, goal, result),
  };
}

function buildCoderTurns(
  events: readonly CoderStreamEvent[],
  coder: string,
  goal: string,
  result: CoderResult,
): TranscriptTurn[] {
  const toolCalls: TranscriptToolCall[] = [];
  const byCallId = new Map<string, TranscriptToolCall>();
  let finalSummary = "";

  for (const event of events) {
    if (event.kind === "tool_call" && event.tool) {
      if (toolCalls.length >= 50) {
        continue;
      }
      const rawArgs = event.payload?.input;
      const args =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as Record<string, unknown>)
          : {};
      const call: TranscriptToolCall = {
        index: toolCalls.length + 1,
        tool: event.tool,
        argsSummary: summarizeToolArgs(args).text,
        resultSummary: "",
        isError: false,
      };
      toolCalls.push(call);
      if (event.callId) {
        byCallId.set(event.callId, call);
      }
      continue;
    }
    if (event.kind === "tool_result") {
      const call = event.callId ? byCallId.get(event.callId) : undefined;
      if (call) {
        call.resultSummary = summarizeToolResult(event.summary ?? "").text;
        call.isError = event.status === "failed";
      }
      continue;
    }
    if (event.kind === "final") {
      finalSummary = event.summary ?? "";
    }
  }

  const response = finalSummary || result.summary || result.error || "";
  return [
    {
      index: 1,
      kind: "coder",
      requestSummary: summarizeRequest(`${coder}: ${goal}`).text,
      responseSummary: summarizeResponse(response).text,
      toolCalls,
    },
  ];
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
}): Promise<{
  text: string;
  costCny: number;
  tokens: number;
  turns: TranscriptTurn[];
}> {
  const gateway = trackedGateway(
    input.store,
    {
      workspaceId: input.input.workspaceId,
      runId: input.input.runId,
      stageId: input.input.stageId,
      agentId: input.input.agentId,
    },
    createModelGateway(),
  );
  const repoRoot = resolveRepoRoot();
  const sandboxRoot = path.join(
    repoRoot,
    ".tmp",
    "workspaces",
    input.input.runId,
  );
  await mkdir(sandboxRoot, { recursive: true });
  const gate = await getOpsGate(
    input.store,
    new Date(),
    input.input.workspaceId,
  );
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
    readOnly: gate.readOnly,
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
  const turns: TranscriptTurn[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    heartbeat();
    assertWriteLeaseActive();
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
    const response = await withBudget(
      input.store,
      input.input,
      "model",
      estimateModelCall(
        input.modelAlias,
        messageChars(messages) + JSON.stringify(input.tools).length,
        4096,
      ),
      () =>
        callWithCircuitBreaker(
          input.store,
          circuitDimensions({
            workspaceId: input.input.workspaceId,
            agentId: input.input.agentId,
            modelAlias: input.modelAlias,
          }),
          () =>
            gateway.completeWithTools({
              model: input.modelAlias,
              messages,
              tools: input.tools,
              temperature: 0,
              maxTokens: 4096,
            }),
        ),
      (value) => ({
        cny: value.usage.costCny ?? 0,
        tokens: value.usage.inputTokens + value.usage.outputTokens,
      }),
    );
    costCny += response.usage.costCny ?? 0;
    tokens += response.usage.inputTokens + response.usage.outputTokens;
    if (response.text) {
      lastText = response.text;
    }
    const turn: TranscriptTurn = {
      index: step + 1,
      kind: "model",
      requestSummary: summarizeRequest(`step ${step + 1}: ${input.modelInput}`)
        .text,
      responseSummary: summarizeResponse(response.text).text,
      toolCalls: [],
    };
    turns.push(turn);
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
        turns,
      };
    }
    messages.push(response.message);

    for (const call of response.toolCalls) {
      toolCalls += 1;
      toolIndex += 1;
      if (toolCalls > maxToolCalls) {
        const clipped = summarizeToolResult(
          "ERROR: tool call budget exhausted",
        );
        turn.toolCalls.push({
          index: toolIndex,
          tool: call.name,
          argsSummary: summarizeToolArgs(call.arguments).text,
          resultSummary: clipped.text,
          isError: true,
        });
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
      let executedTool = false;
      try {
        const tool = getTool(call.name, input.extraTools);
        if (!tool) {
          throw new Error(`unknown tool: ${call.name}`);
        }
        executedTool = true;
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
      if (executedTool) {
        await recordToolCall(
          input.store,
          {
            workspaceId: input.input.workspaceId,
            runId: input.input.runId,
            stageId: input.input.stageId,
            agentId: input.input.agentId,
          },
          call.name,
        );
      }
      const durationMs = Date.now() - started;
      turn.toolCalls.push({
        index: toolIndex,
        tool: call.name,
        argsSummary: summarizeToolArgs(call.arguments).text,
        resultSummary: summarizeToolResult(content).text,
        isError,
        durationMs,
      });
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
  const final = await withBudget(
    input.store,
    input.input,
    "model",
    estimateModelCall(
      input.modelAlias,
      messageChars(messages) + JSON.stringify(input.tools).length,
      4096,
    ),
    () =>
      callWithCircuitBreaker(
        input.store,
        circuitDimensions({
          workspaceId: input.input.workspaceId,
          agentId: input.input.agentId,
          modelAlias: input.modelAlias,
        }),
        () =>
          gateway.completeWithTools({
            model: input.modelAlias,
            messages,
            tools: input.tools,
            temperature: 0,
            maxTokens: 4096,
          }),
      ),
    (value) => ({
      cny: value.usage.costCny ?? 0,
      tokens: value.usage.inputTokens + value.usage.outputTokens,
    }),
  );
  costCny += final.usage.costCny ?? 0;
  tokens += final.usage.inputTokens + final.usage.outputTokens;
  const finalText =
    final.text || lastText || "(tool budget reached; no final summary)";
  turns.push({
    index: turns.length + 1,
    kind: "model",
    requestSummary: summarizeRequest("tool budget reached: final summary").text,
    responseSummary: summarizeResponse(finalText).text,
    toolCalls: [],
  });
  return {
    text: finalText,
    costCny,
    tokens,
    turns,
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
  gateScore: number | null;
  approvalRequired?: boolean;
  approvalRequestId?: string;
  approvalExpiresAt?: string;
}> {
  let text = initialText;
  let artifactId = initialArtifactId;
  let summary = "";
  let gateScore: number | null = null;
  const gateRefs: Array<{ artifactId: string; version: number }> = [];

  for (let attempt = 0; attempt <= MAX_REVISIONS; attempt += 1) {
    const gate = await evaluateGate(store, input, text, artifactId, attempt);
    if (gate.artifactId) {
      gateRefs.push({ artifactId: gate.artifactId, version: 1 });
    }
    gateScore = gate.score;
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
        ...(gate.score !== null ? { score: gate.score } : {}),
      },
    });
    if (gate.pass) {
      return { text, artifactId, summary: gate.summary, gateScore };
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
  const gate = await getOpsGate(store, new Date(), input.workspaceId);
  if (
    approval?.mode === "auto" &&
    !gate.readOnly &&
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
    return { text, artifactId, summary, gateScore };
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
    gateScore,
    approvalRequired: true,
    approvalRequestId: request.requestId,
    approvalExpiresAt: request.expiresAt,
  };
}

export async function requestApproval(
  input: RequestApprovalInput,
): Promise<RequestApprovalResult> {
  assertWriteLeaseActive();
  const store = await getStore();
  const runCostCny = await calculateRunCost(store, input.runId);
  const gate = await getOpsGate(store, new Date(), input.workspaceId);

  if (input.approval.mode === "never") {
    return { required: false, runCostCny };
  }

  if (
    input.approval.mode === "auto" &&
    !gate.readOnly &&
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
        // Re-materialize the entity for runs queued before approvals were a
        // table; enqueue is idempotent, so this is a no-op after the first run.
        await store.approvals
          .enqueue({
            approvalId: parsed.requestId,
            workspaceId: input.workspaceId,
            runId: input.runId,
            stageId: input.stageId,
            kind: input.requestType,
            requester: "manager",
            payloadRef: existing.artifactId,
            slaDueAt: parsed.expiresAt ?? null,
            expiresAt: parsed.expiresAt ?? null,
          })
          .catch(logApprovalEnqueueError);
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
    requestType:
      | "stage_before"
      | "stage_after"
      | "gate_failure"
      | "budget_exceeded";
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

  const gate = await getOpsGate(store, new Date(), input.workspaceId);
  let notified = false;
  let notifyError: string | undefined;
  if (gate.readOnly) {
    notifyError = `skipped: ${gate.reason ?? "night mode"}`;
  } else if (input.notify?.webhook && !runModeAllowsOutbound(input.runMode)) {
    // 20 §2.4: non-LIVE runs deny outbound. Refuse the approval webhook and
    // leave an audit trail instead of sending it.
    notifyError = `refused: outbound blocked in ${input.runMode} run`;
    await safeOp(store, {
      workspaceId: input.workspaceId,
      entityKind: "approval",
      entityId: requestId,
      op: "approval.notify.blocked",
      actor: "engine",
      origin: "system",
      payload: {
        runId: input.runId,
        requestType: input.requestType,
        runMode: input.runMode,
        reason: "outbound_refused",
      },
    });
  } else if (input.notify?.webhook) {
    try {
      await notifyApprovalWebhook(input.notify, request);
      notified = true;
    } catch (error) {
      notifyError = error instanceof Error ? error.message : String(error);
    }
  }

  const published = await store.artifactService.publish({
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

  // The artifact stays the workflow's source of truth; the entity is the
  // inbox projection. A failed insert must not break a live run, so log and
  // let the backfill pick the request up later.
  await store.approvals
    .enqueue({
      approvalId: requestId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: input.stageId,
      kind: input.requestType,
      requester: request.requestedBy,
      payloadRef: published.artifact.artifactId,
      slaDueAt: expiresAt,
      expiresAt,
    })
    .catch(logApprovalEnqueueError);

  await safeAlert(store, {
    workspaceId: input.workspaceId,
    tier: input.riskClass === "high" ? "P1" : "P2",
    kind: "approval.requested",
    title:
      input.requestType === "gate_failure"
        ? `Gate failed: ${input.stageName}`
        : `Approval requested: ${input.stageName}`,
    body: input.summary,
    runId: input.runId,
    stageId: input.stageId,
    requestId,
    source: "engine",
    meta: {
      requestType: input.requestType,
      riskClass: input.riskClass,
      expiresAt,
    },
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
    requestType:
      | "stage_before"
      | "stage_after"
      | "gate_failure"
      | "budget_exceeded";
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
    writeLeaseOptions(),
  );
  const run = await store.runs.get(input.runId);
  await safeOp(store, {
    workspaceId: run?.workspaceId ?? "default",
    entityKind: "run",
    entityId: input.runId,
    op: "run.status",
    actor: "engine",
    origin: "system",
    payload: { status: input.status },
  });
}

async function evaluateGate(
  store: Store,
  input: PackStageExecutionInput,
  draftText: string,
  draftArtifactId: string | undefined,
  attempt: number,
): Promise<{
  pass: boolean;
  artifactId: string;
  summary: string;
  score: number | null;
}> {
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
        scores?: Record<string, number>;
      };
      return {
        pass: parsed.pass === true,
        artifactId: existing.artifactId,
        summary: parsed.rationale ?? "",
        score: computeGateScore(
          parsed.scores ?? {},
          gateDimensionWeights(input.gate.dimensions),
        ),
      };
    } catch {
      return {
        pass: false,
        artifactId: existing.artifactId,
        summary: "invalid gate artifact",
        score: null,
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
    const gateway = trackedGateway(
      store,
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        stageId: gateStageId,
        agentId: "evaluator",
        source: "judge",
      },
      createModelGateway(),
    );
    const dimensions = Object.entries(input.gate.dimensions)
      .map(([name, config]) => `${name} (weight ${config.weight})`)
      .join(", ");

    const instructions = `You are an independent quality evaluator. Score the draft on these dimensions from 0 to 1: ${dimensions}. Verify that every [S#] citation exists in the evidence set. Return JSON only: {"scores":{"dimension":0.0},"rationale":"short"}.`;
    const judgeInput = `Evidence set:\n${input.evidenceText ?? "(none)"}\n\nDraft:\n${draftText}`;
    const response = await withBudget(
      store,
      input,
      "judge",
      estimateModelCall(
        judgeModel,
        instructions.length + judgeInput.length,
        4096,
      ),
      () =>
        callWithCircuitBreaker(
          store,
          circuitDimensions({
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            modelAlias: judgeModel,
          }),
          () =>
            gateway.complete({
              model: judgeModel,
              instructions,
              input: judgeInput,
            }),
        ),
      (value) => ({
        cny: value.usage.costCny ?? 0,
        tokens: value.usage.inputTokens + value.usage.outputTokens,
      }),
    );

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
  await attachStageArtifact(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: gateStageId,
    artifactId: published.artifact.artifactId,
  });

  heartbeat();

  return {
    pass,
    artifactId: published.artifact.artifactId,
    summary: rationale,
    score: computeGateScore(
      scores,
      gateDimensionWeights(input.gate.dimensions),
    ),
  };
}

function gateDimensionWeights(
  dimensions: NonNullable<PackStageExecutionInput["gate"]>["dimensions"],
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(dimensions).map(([name, config]) => [name, config.weight]),
  );
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
  const revisionStageId = `${input.stageId}:revision-${revisionIndex}`;
  const gateway = trackedGateway(
    store,
    {
      workspaceId: input.workspaceId,
      runId: input.runId,
      stageId: revisionStageId,
      agentId: input.revision.agentId,
      source: "revision",
    },
    input.stub ? new StubModelGateway() : createModelGateway(),
  );
  const modelAlias = input.revision.modelAlias;
  const instructions = input.revision.instructions;
  const revisionInput = `Evidence set:\n${input.evidenceText ?? "(none)"}\n\nCurrent draft:\n${draftText}\n\nQuality gate feedback:\n${feedback}\n\nRevise the draft to fix these issues. Keep [S#] citations and the Recommendations section.`;
  const response = await withBudget(
    store,
    input,
    "revision",
    estimateModelCall(
      modelAlias,
      instructions.length + revisionInput.length,
      4096,
    ),
    () =>
      callWithCircuitBreaker(
        store,
        circuitDimensions({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          modelAlias,
        }),
        () =>
          gateway.complete({
            model: modelAlias,
            instructions,
            input: revisionInput,
          }),
      ),
    (value) => ({
      cny: value.usage.costCny ?? 0,
      tokens: value.usage.inputTokens + value.usage.outputTokens,
    }),
  );

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
    stageId: revisionStageId,
    runMode: input.runMode,
    cost: {
      currency: "CNY",
      amount: response.usage.costCny ?? 0,
      tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
  await attachStageArtifact(store, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    stageId: revisionStageId,
    artifactId: published.artifact.artifactId,
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
