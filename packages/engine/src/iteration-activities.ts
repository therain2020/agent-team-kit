import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ActivityInput, appendActivity } from "@kit/activity";
import { recordShadowIterationProposals } from "@kit/change";
import {
  type CoderResult,
  type CoderStreamEvent,
  coderSandboxRoot,
  commandOnPath,
  isCoderSandboxPath,
  runCoderTask,
  runProcess,
} from "@kit/coder";
import {
  type CoderId,
  type IterationConfig,
  type IterationTask,
  type TaskPlan,
  classifyIterationRisk,
  cnyToMicro,
  evaluateIterationApply,
  newId,
  taskPlanSchema,
} from "@kit/core";
import {
  appendCoderEvent,
  appendEvent,
  applyDiffToRepo,
  failIteration,
  formatAppliedFiles,
  publishIterationArtifact,
  readArtifactText,
  runPostApplyChecks,
  safe,
  startIteration,
  toErrorMessage,
  touchHeartbeat,
  updateRun,
  updateTask,
} from "@kit/iteration";
import { calculateCostCny, createModelGateway } from "@kit/model";
import { getOpsGate } from "@kit/ops";
import { loadPack } from "@kit/pack";
import { type OpLogEntry, appendOp, initStore } from "@kit/store";
import { securityScanCodeTool } from "@kit/tools";
import type {
  ApplyTaskActivityInput,
  ClassifyTaskActivityInput,
  CleanupInput,
  FailIterationInput,
  IterationApplyResult,
  IterationCoderResult,
  IterationInput,
  IterationReportResult,
  IterationRiskResult,
  IterationTaskResult,
  IterationVerificationResult,
  PlannedIteration,
  ReportIterationInput,
  RunCoderActivityInput,
  VerifyTaskActivityInput,
} from "@kit/workflow";
import {
  attachStageArtifact,
  recordCoderCost,
  trackedGateway,
} from "./cost-attribution";
import { heartbeat } from "./heartbeat";
import { assertKillSwitchClear } from "./kill-switch";

type Store = Awaited<ReturnType<typeof initStore>>;

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

// The op log is audit; a failed audit write must not fail an iteration.
async function safeOp(store: Store, entry: OpLogEntry): Promise<void> {
  try {
    await appendOp(store, entry);
  } catch (error) {
    console.error(
      `[op-log] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface IterationActivityContext {
  workspaceId: string;
  iterationId: string;
  taskId: string;
  agentId: string;
  coder: string;
}

/**
 * Maps streaming coder events onto the team activity stream. Turn boundaries
 * and tool calls are mirrored; thinking/text/step events stay in 93's finer
 * turn timeline to avoid flooding activity_events.
 */
export function coderEventToActivity(
  event: CoderStreamEvent,
  context: IterationActivityContext,
  toolNames?: Map<string, string>,
): ActivityInput | null {
  const base = {
    workspaceId: context.workspaceId,
    runId: context.iterationId,
    stageId: `${context.iterationId}:${context.taskId}:coder`,
    agentId: context.agentId,
    createdAt: event.at,
  };
  const payload = {
    taskId: context.taskId,
    coder: context.coder,
    ...(event.turn !== undefined ? { turn: event.turn } : {}),
    ...(event.step !== undefined ? { step: event.step } : {}),
  };

  switch (event.kind) {
    case "turn_start":
      return {
        ...base,
        kind: "iteration.coder.turn",
        status: "running",
        summary: `turn ${event.turn ?? 1} started`,
        payload,
      };
    case "turn_end":
      return {
        ...base,
        kind: "iteration.coder.turn",
        status: event.status ?? "completed",
        summary:
          event.summary ??
          `turn ${event.turn ?? 1} ${event.status ?? "completed"}`,
        payload: { ...payload, tokens: event.tokens ?? 0 },
      };
    case "error":
      return {
        ...base,
        kind: "iteration.coder.turn",
        status: "failed",
        summary: event.summary ?? "coder error",
        payload: { ...payload, error: event.summary ?? null },
      };
    case "tool_call":
      if (event.callId && event.tool) {
        toolNames?.set(event.callId, event.tool);
      }
      return {
        ...base,
        kind: "iteration.coder.tool",
        status: "running",
        ...(event.tool ? { tool: event.tool } : {}),
        summary: event.summary ?? event.tool ?? "tool call",
        payload: {
          ...payload,
          callId: event.callId ?? null,
          input: event.payload?.input ?? null,
        },
      };
    case "tool_result": {
      const tool =
        event.tool ?? (event.callId ? toolNames?.get(event.callId) : undefined);
      return {
        ...base,
        kind: "iteration.coder.tool_result",
        status: event.status ?? "completed",
        ...(tool ? { tool } : {}),
        summary: event.summary ?? "",
        payload: {
          ...payload,
          callId: event.callId ?? null,
          result: event.payload?.result ?? null,
        },
      };
    }
    default:
      return null;
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

function coderTokenBound(): number {
  const parsed = Number(process.env.KIT_CODER_MAX_TOKENS ?? 200_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 200_000;
}

export async function planIteration(
  input: IterationInput,
): Promise<PlannedIteration> {
  const store = await getStore();
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:plan`,
    agentId: "planner",
    kind: "iteration.plan",
    status: "running",
    summary: input.goal,
    payload: {
      runMode: input.runMode,
      applyMode: input.applyMode,
      maxTasks: input.maxTasks,
      stub: input.stub === true,
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    agentId: "planner",
    kind: "iteration.run.started",
    status: "running",
    summary: input.goal,
    payload: { runMode: input.runMode, applyMode: input.applyMode },
  });
  await assertKillSwitchClear(
    store,
    {
      workspaceId: input.workspaceId,
      agentId: "planner",
      stageId: `${input.iterationId}:plan`,
      stageName: "plan",
    },
    "run",
  );
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const loaded = await loadPack(input.packDir);
  if (!loaded.ok) {
    throw new Error(`invalid iteration pack: ${loaded.errors.join("; ")}`);
  }
  const iteration = loaded.iteration;
  if (!iteration) {
    throw new Error(`iteration.yaml missing in ${input.packDir}`);
  }

  const maxTasks = Math.max(
    1,
    Math.min(input.maxTasks, iteration.planner.maxTasks),
  );
  let plan: TaskPlan;
  let tokens = 0;
  let costCny = 0;

  if (input.stub) {
    plan = stubPlan(input.goal, iteration.domains);
  } else {
    await assertKillSwitchClear(
      store,
      {
        workspaceId: input.workspaceId,
        agentId: "planner",
        stageId: `${input.iterationId}:plan`,
        stageName: "plan",
      },
      "model",
    );
    const gateway = trackedGateway(
      store,
      {
        workspaceId: input.workspaceId,
        runId: input.iterationId,
        stageId: `${input.iterationId}:plan`,
        agentId: "planner",
        source: "planning",
      },
      createModelGateway(),
    );
    const context = await buildRepoContext(repoRoot);
    const domains = Object.entries(iteration.domains)
      .map(
        ([name, config]) =>
          `- ${name}: workflow=${config.workflow}, coder=${config.coder}, riskCeiling=${config.riskCeiling}`,
      )
      .join("\n");
    const model = iteration.planner.model;
    const instructions = `You are the Planner for a task-centric agent team.
Decompose the goal into at most ${maxTasks} independent, verifiable tasks.
Use only the declared domains. Each task must include:
- id: lowercase kebab-case, unique
- domain: one of the declared domains
- goal: why the task exists and what to change
- acceptance: objective completion criteria
- filesHint: JSON array of likely files/directories (use [] when unknown)
- risk: low | medium | high
- dependsOn: JSON array of task ids (use [])
Return JSON only: {"goal":"...","summary":"...","tasks":[...]}.
Do not invent files or facts. Prefer small, testable changes.`;
    const modelInput = `Goal: ${input.goal}
Acceptance: ${input.acceptance ?? "(none)"}
Max tasks: ${maxTasks}

Domains:
${domains}

Repository context:
${context}`;
    const estimate = estimateModelCall(
      model,
      instructions.length + modelInput.length,
      4096,
    );
    const stageLimit = input.budget?.stage;
    const agentLimit = input.budget?.agents?.planner ?? input.budget?.agent;
    const reservation = await store.budgetService.reserve({
      workspaceId: input.workspaceId,
      runId: input.iterationId,
      stageId: "plan",
      agentId: "planner",
      purpose: "planning",
      amountCnyMicro: estimate.cnyMicro,
      amountTokens: estimate.tokens,
      ...(stageLimit ? { stageLimit } : {}),
      ...(agentLimit ? { agentLimit } : {}),
    });
    if (!reservation.ok) {
      throw new Error(`budget exceeded: ${reservation.message}`);
    }
    let response: Awaited<ReturnType<typeof gateway.complete>>;
    try {
      response = await gateway.complete({
        model,
        instructions,
        input: modelInput,
      });
    } catch (error) {
      await store.budgetService
        .release(reservation.reservationId)
        .catch(() => undefined);
      throw error;
    }
    const committed = await store.budgetService.commit(
      reservation.reservationId,
      {
        cnyMicro: cnyToMicro(response.usage.costCny ?? 0),
        tokens: response.usage.inputTokens + response.usage.outputTokens,
      },
    );
    if (!committed.ok) {
      throw new Error(committed.message ?? "budget commit failed");
    }
    tokens = response.usage.inputTokens + response.usage.outputTokens;
    costCny = response.usage.costCny ?? 0;
    try {
      plan = parseTaskPlan(response.text);
    } catch (error) {
      // Keep the raw model output for reproduction before failing the run.
      const rawArtifactId = await publishIterationArtifact(store, {
        iterationId: input.iterationId,
        workspaceId: input.workspaceId,
        stageId: `${input.iterationId}:plan:raw`,
        content: response.text,
        agentId: "planner",
        modelId: iteration.planner.model,
        tokens,
        costCny,
        runMode: input.runMode,
      }).catch(() => undefined);
      if (rawArtifactId) {
        await attachStageArtifact(store, {
          workspaceId: input.workspaceId,
          runId: input.iterationId,
          stageId: `${input.iterationId}:plan`,
          artifactId: rawArtifactId,
        });
      }
      throw new Error(
        `planner output rejected: ${toErrorMessage(error)}${
          rawArtifactId ? ` (raw artifact ${rawArtifactId})` : ""
        }`,
      );
    }
  }

  if (input.domain) {
    plan.tasks = plan.tasks.filter((task) => task.domain === input.domain);
    if (plan.tasks.length === 0) {
      throw new Error(`planner produced no tasks for domain: ${input.domain}`);
    }
  }
  plan.tasks = plan.tasks.slice(0, maxTasks);
  for (const task of plan.tasks) {
    if (!iteration.domains[task.domain]) {
      throw new Error(`planner selected unknown domain: ${task.domain}`);
    }
  }

  const artifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:plan`,
    content: JSON.stringify(plan, null, 2),
    agentId: "planner",
    modelId: iteration.planner.model,
    tokens,
    costCny,
    runMode: input.runMode,
  });
  await attachStageArtifact(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:plan`,
    artifactId,
  });

  await startIteration(store, input, plan, artifactId);
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "iteration_run",
    entityId: input.iterationId,
    op: "iteration.start",
    actor: "engine",
    origin: "system",
    idempotencyKey: `iteration.start:${input.iterationId}`,
    payload: {
      planArtifactId: artifactId,
      tasks: plan.tasks.map((task) => task.id),
      runMode: input.runMode,
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:plan`,
    agentId: "planner",
    kind: "iteration.plan",
    status: "completed",
    summary: `planned ${plan.tasks.length} task(s)`,
    payload: {
      artifactId,
      model: iteration.planner.model,
      tokens,
      costCny,
      tasks: plan.tasks.map((task) => ({
        id: task.id,
        domain: task.domain,
        risk: task.risk,
      })),
    },
  });
  return { plan, artifactId, tokens, costCny };
}

export async function runIterationCoder(
  input: RunCoderActivityInput,
): Promise<IterationCoderResult> {
  const store = await getStore();
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const loaded = await loadPack(input.packDir);
  if (!loaded.ok) {
    throw new Error(`invalid iteration pack: ${loaded.errors.join("; ")}`);
  }
  const iteration = loaded.iteration;
  const domain = iteration?.domains[input.task.domain];
  if (!iteration || !domain) {
    throw new Error(`unknown iteration domain: ${input.task.domain}`);
  }

  const coder = (input.coderOverride ?? domain.coder) as CoderId;
  await assertKillSwitchClear(
    store,
    {
      workspaceId: input.workspaceId,
      agentId: domain.agent,
      stageId: `${input.iterationId}:${input.task.id}:coder`,
      stageName: input.task.id,
    },
    "tool",
  );
  const instructions = await loadInstructions(loaded, domain.agent);
  await updateRun(store, input.iterationId, {
    status: "running",
    phase: "coder",
  });
  await updateTask(store, input.iterationId, input.task.id, {
    status: "running",
    phase: "coder",
    attempt: input.attempt,
    coder,
    startedAt: new Date().toISOString(),
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    taskId: input.task.id,
    kind: "coder.started",
    status: "running",
    summary: input.task.goal,
    payload: { coder, attempt: input.attempt },
  });

  const activityAgentId = domain.agent ?? coder;
  const activityContext: IterationActivityContext = {
    workspaceId: input.workspaceId,
    iterationId: input.iterationId,
    taskId: input.task.id,
    agentId: activityAgentId,
    coder,
  };
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:${input.task.id}:coder`,
    agentId: activityAgentId,
    kind: "iteration.coder.started",
    status: "running",
    summary: input.task.goal,
    payload: {
      taskId: input.task.id,
      domain: input.task.domain,
      coder,
      attempt: input.attempt,
    },
  });
  if (input.attempt > 0) {
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.iterationId,
      stageId: `${input.iterationId}:${input.task.id}:coder`,
      agentId: activityAgentId,
      kind: "iteration.repair",
      status: "running",
      summary:
        input.feedback.slice(0, 500) || `repair attempt ${input.attempt}`,
      payload: {
        taskId: input.task.id,
        coder,
        attempt: input.attempt,
        feedback: input.feedback || null,
      },
    });
  }

  const sandboxDir = coderSandboxRoot(
    "iterations",
    safe(input.iterationId),
    safe(input.task.id),
    `attempt-${input.attempt}`,
  );
  await mkdir(path.dirname(sandboxDir), { recursive: true });

  const context = [
    input.feedback
      ? `Verification feedback from the previous attempt:\n${input.feedback}`
      : "",
    input.task.filesHint.length > 0
      ? `Likely files:\n${input.task.filesHint.join("\n")}`
      : "",
    domain.instructions ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const heartbeatTimer = setInterval(() => {
    heartbeat();
    void touchHeartbeat(store, input.iterationId, input.task.id).catch(
      () => undefined,
    );
  }, 30_000);

  const stageLimit =
    input.budget?.stages?.[input.task.id] ?? input.budget?.stage;
  const agentLimit = input.budget?.agents?.[coder] ?? input.budget?.agent;
  const reservation = await store.budgetService.reserve({
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: input.task.id,
    agentId: `coder:${coder}`,
    purpose: "coder",
    amountCnyMicro: 0,
    amountTokens: coderTokenBound(),
    ...(stageLimit ? { stageLimit } : {}),
    ...(agentLimit ? { agentLimit } : {}),
  });
  if (!reservation.ok) {
    throw new Error(`budget exceeded: ${reservation.message}`);
  }

  let eventChain = Promise.resolve();
  const activityToolNames = new Map<string, string>();
  let result: CoderResult;
  try {
    result = await runCoderTask({
      coder,
      runId: input.iterationId,
      taskId: input.task.id,
      goal: input.task.goal,
      acceptance: input.task.acceptance,
      instructions,
      context,
      repoRoot,
      sandboxRoot: sandboxDir,
      timeoutMs: Number(process.env.KIT_CODER_TIMEOUT_MS ?? 25 * 60 * 1000),
      installDeps: process.env.KIT_CODER_INSTALL !== "0",
      keepSandbox: true,
      onEvent: (event) => {
        eventChain = eventChain.then(async () => {
          try {
            await appendCoderEvent(
              store,
              input.iterationId,
              input.task.id,
              event,
            );
          } catch (error) {
            console.error(
              `[iteration] failed to persist coder event: ${String(error)}`,
            );
          }
          const activity = coderEventToActivity(
            event,
            activityContext,
            activityToolNames,
          );
          if (activity) {
            await safeActivity(store, activity);
          }
        });
        return eventChain;
      },
    });
    await eventChain;
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
  } finally {
    clearInterval(heartbeatTimer);
  }

  const committed = await store.budgetService.commit(
    reservation.reservationId,
    { cnyMicro: 0, tokens: result.tokens ?? 0 },
  );
  if (!committed.ok) {
    console.error(
      `[iteration] budget commit failed: ${committed.message ?? "unknown"}`,
    );
  }
  if (committed.overshoot) {
    console.error("[iteration] coder token usage exceeded the reserved bound");
  }

  const coderResultStageId = `${input.iterationId}:${input.task.id}:attempt-${input.attempt}:coder:result`;
  await recordCoderCost(
    store,
    {
      workspaceId: input.workspaceId,
      runId: input.iterationId,
      stageId: coderResultStageId,
      agentId: `coder:${coder}`,
    },
    { coder: result.coder, tokens: result.tokens ?? 0 },
  );

  const resultArtifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:attempt-${input.attempt}:coder:result`,
    content: JSON.stringify(
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
    agentId: `coder:${result.coder}`,
    modelId: result.coder,
    tokens: result.tokens ?? 0,
    runMode: input.runMode,
  });
  await attachStageArtifact(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: coderResultStageId,
    artifactId: resultArtifactId,
  });
  const transcriptArtifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:attempt-${input.attempt}:coder:transcript`,
    content: result.transcript || "(empty transcript)",
    agentId: `coder:${result.coder}`,
    modelId: "none",
    runMode: input.runMode,
  });
  const diffArtifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:attempt-${input.attempt}:coder:diff`,
    content: result.diff || "(no diff)",
    agentId: `coder:${result.coder}`,
    modelId: "none",
    runMode: input.runMode,
  });

  await updateTask(store, input.iterationId, input.task.id, {
    phase: result.ok ? "coder_done" : "coder_failed",
    changedFiles: result.changedFiles,
    tokens: result.tokens ?? 0,
    coderSummary: result.summary,
    diffArtifactId,
    transcriptArtifactId,
    resultArtifactId,
    ...(result.error ? { error: result.error } : {}),
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    taskId: input.task.id,
    kind: "coder.finished",
    status: result.ok ? "completed" : "failed",
    summary: result.summary,
    payload: {
      tokens: result.tokens ?? 0,
      changedFiles: result.changedFiles,
      durationMs: result.durationMs,
      sandboxMode: result.sandbox.mode,
      error: result.error ?? null,
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:${input.task.id}:coder`,
    agentId: activityAgentId,
    kind: "iteration.coder.finished",
    status: result.ok ? "completed" : "failed",
    summary: result.summary,
    payload: {
      taskId: input.task.id,
      coder,
      tokens: result.tokens ?? 0,
      changedFiles: result.changedFiles,
      durationMs: result.durationMs,
      sandboxMode: result.sandbox.mode,
      error: result.error ?? null,
    },
  });

  return {
    taskId: input.task.id,
    coder,
    ok: result.ok,
    summary: result.summary,
    changedFiles: result.changedFiles,
    diffArtifactId,
    resultArtifactId,
    transcriptArtifactId,
    sandboxDir,
    baselineSha: result.sandbox.baselineSha,
    sandboxMode: result.sandbox.mode,
    tokens: result.tokens ?? 0,
    ...(result.error ? { error: result.error } : {}),
  };
}

export async function verifyIterationTask(
  input: VerifyTaskActivityInput,
): Promise<IterationVerificationResult> {
  const store = await getStore();
  const loaded = await loadPack(input.packDir);
  if (!loaded.ok) {
    throw new Error(`invalid iteration pack: ${loaded.errors.join("; ")}`);
  }
  const domain = loaded.iteration?.domains[input.task.domain];
  if (!domain) {
    throw new Error(`unknown iteration domain: ${input.task.domain}`);
  }

  if (!input.coderOk) {
    return await failVerification(
      store,
      input,
      "coder reported failure",
      input.coderSummary,
    );
  }
  await assertKillSwitchClear(
    store,
    {
      workspaceId: input.workspaceId,
      agentId: "verifier",
      stageId: `${input.iterationId}:${input.task.id}:verify`,
      stageName: input.task.id,
    },
    "tool",
  );
  if (!input.sandboxDir || !existsSync(input.sandboxDir)) {
    return await failVerification(
      store,
      input,
      "sandbox missing",
      "the coder sandbox no longer exists",
    );
  }

  await updateTask(store, input.iterationId, input.task.id, {
    status: "running",
    phase: "verifying",
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    taskId: input.task.id,
    kind: "verification.started",
    status: "running",
    summary: `checks: ${domain.verification.join(", ")}`,
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:${input.task.id}:verify`,
    agentId: "verifier",
    kind: "iteration.verify",
    status: "running",
    summary: `checks: ${domain.verification.join(", ")}`,
    payload: { taskId: input.task.id, checks: domain.verification },
  });
  if (input.changedFiles.length === 0) {
    return await failVerification(
      store,
      input,
      "no changes",
      "the coder produced no changed files",
    );
  }

  const checks: IterationVerificationResult["checks"] = [];
  const scripts = await readPackageScripts(input.sandboxDir);
  let executed = 0;
  const heartbeatTimer = setInterval(() => {
    heartbeat();
  }, 30_000);

  try {
    for (const name of domain.verification) {
      if (name === "security") {
        const scan = await securityScanCodeTool.execute(
          { maxFindings: 120 },
          {
            repoRoot: input.sandboxDir,
            sandboxRoot: input.sandboxDir,
            runId: input.iterationId,
            workspaceId: input.workspaceId,
            runMode: "LIVE",
            allowNetwork: false,
            allowLocalhost: false,
          },
        );
        const high = /"severity"\s*:\s*"high"/i.test(scan.content);
        executed += 1;
        checks.push({
          name,
          exitCode: scan.isError || high ? 1 : 0,
          timedOut: false,
          output: scan.content.slice(0, 8000),
        });
        continue;
      }

      const script = scriptFor(name);
      if (!script) {
        checks.push({
          name,
          exitCode: 1,
          timedOut: false,
          output: `unknown verification check: ${name}`,
        });
        continue;
      }
      if (!scripts) {
        checks.push({
          name,
          exitCode: 0,
          timedOut: false,
          output: "skipped: target project has no package.json",
        });
        continue;
      }
      if (!scripts.has(script)) {
        checks.push({
          name,
          exitCode: 0,
          timedOut: false,
          output: `skipped: package.json has no "${script}" script`,
        });
        continue;
      }
      const bun = commandOnPath("bun") ?? "bun";
      const result = await runProcess(bun, ["run", script], {
        cwd: input.sandboxDir,
        timeoutMs: 20 * 60 * 1000,
        maxOutputBytes: 200_000,
      });
      executed += 1;
      checks.push({
        name,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n")
          .slice(-8000),
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (executed === 0) {
    return await failVerification(
      store,
      input,
      "no verification commands",
      `the target project cannot run any of: ${domain.verification.join(", ")}`,
    );
  }

  const failed = checks.filter(
    (check) => check.exitCode !== 0 || check.timedOut,
  );
  const pass = failed.length === 0;
  const feedback = pass
    ? "all checks passed"
    : failed
        .map(
          (check) =>
            `[${check.name}] exit=${check.exitCode} timeout=${check.timedOut}\n${check.output.slice(-3000)}`,
        )
        .join("\n\n")
        .slice(0, 8000);

  const artifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:verification`,
    content: JSON.stringify({ pass, checks, feedback }, null, 2),
    agentId: "verifier",
    modelId: "none",
    runMode: "LIVE",
  });
  await updateTask(store, input.iterationId, input.task.id, {
    status: pass ? "passed" : "failed",
    phase: pass ? "verified" : "verification_failed",
    verificationArtifactId: artifactId,
    ...(pass ? {} : { error: feedback.slice(0, 2000) }),
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    taskId: input.task.id,
    kind: "verification.finished",
    status: pass ? "completed" : "failed",
    summary: pass ? "all checks passed" : feedback.slice(0, 500),
    payload: {
      pass,
      checks: checks.map((check) => ({
        name: check.name,
        exitCode: check.exitCode,
        timedOut: check.timedOut,
      })),
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:${input.task.id}:verify`,
    agentId: "verifier",
    kind: "iteration.verify",
    status: pass ? "completed" : "failed",
    summary: pass ? "all checks passed" : feedback.slice(0, 500),
    payload: {
      taskId: input.task.id,
      pass,
      artifactId,
      checks: checks.map((check) => ({
        name: check.name,
        exitCode: check.exitCode,
        timedOut: check.timedOut,
      })),
    },
  });
  return { taskId: input.task.id, pass, feedback, checks, artifactId };
}

export async function classifyIterationTask(
  input: ClassifyTaskActivityInput,
): Promise<IterationRiskResult> {
  const store = await getStore();
  const loaded = await loadPack(input.packDir);
  if (!loaded.ok) {
    throw new Error(`invalid iteration pack: ${loaded.errors.join("; ")}`);
  }
  const ceiling =
    loaded.iteration?.domains[input.task.domain]?.riskCeiling ?? "medium";
  const classified = classifyRisk(
    input.changedFiles,
    input.plannedRisk,
    ceiling,
  );

  const artifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:risk`,
    content: JSON.stringify(classified, null, 2),
    agentId: "risk-classifier",
    modelId: "none",
    runMode: "LIVE",
  });
  await updateTask(store, input.iterationId, input.task.id, {
    risk: classified.risk,
    phase: "risk",
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    taskId: input.task.id,
    kind: "risk.classified",
    status: classified.forbidden ? "blocked" : "completed",
    summary: `risk ${classified.risk}`,
    payload: {
      reasons: classified.reasons,
      forbidden: classified.forbidden,
      requiresApproval: classified.requiresApproval,
      protectedPaths: classified.protectedPaths,
    },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:${input.task.id}:risk`,
    agentId: "risk-classifier",
    kind: "iteration.risk",
    status: classified.forbidden ? "blocked" : "completed",
    summary: `risk ${classified.risk}`,
    payload: {
      taskId: input.task.id,
      risk: classified.risk,
      reasons: classified.reasons,
      forbidden: classified.forbidden,
      requiresApproval: classified.requiresApproval,
      protectedPaths: classified.protectedPaths,
      artifactId,
    },
  });
  return {
    taskId: input.task.id,
    risk: classified.risk,
    reasons: [...classified.reasons, `risk artifact: ${artifactId}`],
    forbidden: classified.forbidden,
    requiresApproval: classified.requiresApproval,
    protectedPaths: classified.protectedPaths,
  };
}

export async function applyIterationTask(
  input: ApplyTaskActivityInput,
): Promise<IterationApplyResult> {
  const store = await getStore();
  await assertKillSwitchClear(
    store,
    {
      workspaceId: input.workspaceId,
      agentId: "policy:autonomy",
      stageId: `${input.iterationId}:${input.task.id}:apply`,
      stageName: input.task.id,
    },
    "tool",
  );
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const ticketId = newId("tkt");
  let headBefore = "";
  let baseDrifted = false;

  const heartbeatTimer = setInterval(() => {
    heartbeat();
  }, 30_000);
  heartbeatTimer.unref?.();

  const publishApply = async (
    status: IterationApplyResult["status"],
    reason: string,
    extra: { commit?: string; details?: Record<string, unknown> } = {},
  ): Promise<IterationApplyResult> => {
    const now = new Date().toISOString();
    await store.sql`
      INSERT INTO merge_tickets (
        ticket_id, iteration_id, task_id, base_sha, patch_artifact_id,
        changed_files, risk, status, head_before, commit_sha, error,
        created_at, updated_at
      ) VALUES (
        ${ticketId}, ${input.iterationId}, ${input.task.id}, ${input.baselineSha},
        ${input.diffArtifactId}, ${store.sql.json(input.changedFiles)},
        ${input.risk}, ${status}, ${headBefore || null},
        ${extra.commit ?? null},
        ${status === "blocked" || status === "reverted" ? reason : null},
        ${now}, ${now}
      )
      ON CONFLICT (ticket_id) DO UPDATE SET
        status = EXCLUDED.status,
        head_before = EXCLUDED.head_before,
        commit_sha = EXCLUDED.commit_sha,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at
    `;
    const artifactId = await publishIterationArtifact(store, {
      iterationId: input.iterationId,
      workspaceId: input.workspaceId,
      stageId: `${input.iterationId}:${input.task.id}:apply`,
      content: JSON.stringify(
        {
          ticketId,
          status,
          reason,
          baseSha: input.baselineSha,
          headBefore,
          baseDrifted,
          commit: extra.commit,
          changedFiles: input.changedFiles,
          ...extra.details,
        },
        null,
        2,
      ),
      agentId: "policy:autonomy",
      modelId: "none",
      runMode: input.runMode,
    });
    await updateTask(store, input.iterationId, input.task.id, {
      applyStatus: status,
      applyArtifactId: artifactId,
      phase: status,
      status,
      ...(extra.commit ? { commit: extra.commit } : {}),
      ...(status === "blocked" || status === "reverted"
        ? { error: reason.slice(0, 2000) }
        : {}),
    });
    await updateRun(store, input.iterationId, {
      phase: status,
      ...(status === "blocked" || status === "reverted"
        ? { error: reason.slice(0, 2000) }
        : {}),
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: input.task.id,
      kind: "apply.finished",
      status,
      summary: reason,
      payload: {
        risk: input.risk,
        applyMode: input.applyMode,
        commit: extra.commit ?? null,
        artifactId,
        ...extra.details,
      },
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.iterationId,
      stageId: `${input.iterationId}:${input.task.id}:apply`,
      agentId: "policy:autonomy",
      kind: "iteration.apply",
      status,
      summary: reason,
      payload: {
        taskId: input.task.id,
        risk: input.risk,
        applyMode: input.applyMode,
        ticketId,
        commit: extra.commit ?? null,
        artifactId,
        ...extra.details,
      },
    });
    return {
      taskId: input.task.id,
      applied: status === "applied",
      status,
      reason,
      ticketId,
      baseSha: input.baselineSha,
      ...(extra.commit ? { commit: extra.commit } : {}),
      artifactId,
    };
  };

  try {
    if (input.runMode !== "LIVE") {
      return await publishApply("skipped", "dry run: apply disabled");
    }
    // Re-evaluate the substrate policy here, not only in classification: the
    // apply entry must enforce the boundary even when a caller (CLI, autopilot
    // preset, direct activity invocation) hands us a pre-classified task.
    const applyPolicy = evaluateIterationApply({
      runMode: input.runMode,
      applyMode: input.applyMode,
      risk: input.risk,
      changedFiles: input.changedFiles,
    });
    if (input.forbidden || applyPolicy.action === "block") {
      const reason =
        applyPolicy.action === "block"
          ? applyPolicy.reason
          : "forbidden path detected";
      return await publishApply("blocked", reason, {
        ...(applyPolicy.substrate.protectedPaths.length > 0
          ? {
              details: {
                changeProposal: {
                  kind: "change_proposal",
                  handoff: "evolve",
                  status: "blocked",
                  iterationId: input.iterationId,
                  taskId: input.task.id,
                  domain: input.task.domain,
                  ticketId,
                  risk: applyPolicy.effectiveRisk,
                  applyMode: input.applyMode,
                  changedFiles: input.changedFiles,
                  diffArtifactId: input.diffArtifactId,
                  verificationArtifactId: input.verificationArtifactId ?? null,
                  verificationPass: input.verificationPass,
                  blockedReason: reason,
                  protection: applyPolicy.substrate.protection,
                  protectedPaths: applyPolicy.substrate.protectedPaths,
                },
              },
            }
          : {}),
      });
    }
    if (!input.verificationPass) {
      return await publishApply("blocked", "verification did not pass");
    }
    if (!input.diffArtifactId) {
      return await publishApply("blocked", "missing diff artifact");
    }
    if (applyPolicy.action === "skip") {
      return await publishApply("skipped", applyPolicy.reason);
    }

    await updateRun(store, input.iterationId, { phase: "applying" });
    await updateTask(store, input.iterationId, input.task.id, {
      status: "running",
      phase: "applying",
    });
    await appendEvent(store, {
      iterationId: input.iterationId,
      taskId: input.task.id,
      kind: "apply.started",
      status: "running",
      summary: `risk ${input.risk}, mode ${input.applyMode}`,
      payload: {
        baselineSha: input.baselineSha,
        changedFiles: input.changedFiles,
      },
    });
    await safeActivity(store, {
      workspaceId: input.workspaceId,
      runId: input.iterationId,
      stageId: `${input.iterationId}:${input.task.id}:apply`,
      agentId: "policy:autonomy",
      kind: "iteration.apply",
      status: "running",
      summary: `risk ${input.risk}, mode ${input.applyMode}`,
      payload: {
        taskId: input.task.id,
        risk: input.risk,
        applyMode: input.applyMode,
        baselineSha: input.baselineSha,
        changedFiles: input.changedFiles,
      },
    });

    const diff = await readArtifactText(store, input.diffArtifactId);
    if (!diff || diff === "(no diff)" || diff.includes("[truncated at")) {
      return await publishApply("blocked", "diff is empty or truncated");
    }

    const gate = await getOpsGate(store);
    if (gate.readOnly) {
      return await publishApply(
        "blocked",
        `night mode: ${gate.reason ?? "side effects paused"}`,
      );
    }

    const applied = await applyDiffToRepo({
      repoRoot,
      iterationId: input.iterationId,
      taskId: input.task.id,
      ticketId,
      diff,
      baseSha: input.baselineSha,
      changedFiles: input.changedFiles,
      risk: input.risk,
      commitMessage: `autonomy: ${input.task.id} (${input.task.domain})`,
    });
    headBefore = applied.headBefore;
    baseDrifted = applied.baseDrifted;
    return await publishApply(applied.status, applied.reason, {
      ...(applied.commitSha ? { commit: applied.commitSha } : {}),
      details: { backupDir: applied.backupDir },
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function failIterationActivity(
  input: FailIterationInput,
): Promise<void> {
  const store = await getStore();
  const message = toErrorMessage(input.error);
  await failIteration(store, input.iterationId, message);
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "iteration_run",
    entityId: input.iterationId,
    op: "iteration.status",
    actor: "engine",
    origin: "system",
    idempotencyKey: `iteration.status:${input.iterationId}:failed`,
    payload: { status: "failed", error: message },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    kind: "iteration.run.failed",
    status: "failed",
    summary: message.slice(0, 500),
    payload: { error: message },
  });
}

/**
 * Cooperative cancellation probe. The operator marks a run `cancelling`; the
 * pipeline stops at the next checkpoint and finalizes it as `cancelled`.
 */
export async function isIterationCancelled(
  iterationId: string,
): Promise<boolean> {
  const store = await getStore();
  const rows = await store.sql<Array<{ status: string }>>`
    SELECT status FROM iteration_runs
    WHERE iteration_id = ${iterationId} LIMIT 1
  `;
  return rows[0]?.status === "cancelling";
}

export async function cancelIteration(input: {
  iterationId: string;
  workspaceId: string;
  reason: string;
}): Promise<void> {
  const store = await getStore();
  await appendEvent(store, {
    iterationId: input.iterationId,
    kind: "run.cancelled",
    status: "cancelled",
    summary: input.reason,
    payload: { reason: input.reason },
  });
  await updateRun(store, input.iterationId, {
    status: "cancelled",
    phase: "cancelled",
    error: input.reason,
    finishedAt: new Date().toISOString(),
  });
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "iteration_run",
    entityId: input.iterationId,
    op: "iteration.status",
    actor: "engine",
    origin: "system",
    idempotencyKey: `iteration.status:${input.iterationId}:cancelled`,
    payload: { status: "cancelled", reason: input.reason },
  });
}

export async function closeIterationStore(): Promise<void> {
  const current = storePromise;
  storePromise = undefined;
  await current?.then((store) => store.close()).catch(() => undefined);
}

export async function cleanupIterationTask(input: CleanupInput): Promise<void> {
  if (!input.sandboxDir) {
    return;
  }
  const resolved = path.resolve(input.sandboxDir);
  if (!isCoderSandboxPath(resolved)) {
    return;
  }
  if (process.env.KIT_CODER_KEEP === "1") {
    return;
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function reportIteration(
  input: ReportIterationInput,
): Promise<IterationReportResult> {
  const store = await getStore();
  const passed = input.tasks.filter((task) => task.verificationPass).length;
  const applied = input.tasks.filter((task) => task.applied).length;
  const totalTokens = input.tasks.reduce(
    (sum, task) => sum + (task.tokens ?? 0),
    0,
  );
  const status =
    passed === input.tasks.length
      ? "succeeded"
      : passed > 0
        ? "partial"
        : "failed";

  const domains: Record<
    string,
    {
      total: number;
      verified: number;
      applied: number;
      passRate: number;
      tokens: number;
    }
  > = {};
  for (const task of input.tasks) {
    const entry = domains[task.domain] ?? {
      total: 0,
      verified: 0,
      applied: 0,
      passRate: 0,
      tokens: 0,
    };
    entry.total += 1;
    if (task.verificationPass) {
      entry.verified += 1;
    }
    if (task.applied) {
      entry.applied += 1;
    }
    entry.tokens += task.tokens ?? 0;
    domains[task.domain] = entry;
  }
  for (const entry of Object.values(domains)) {
    entry.passRate = entry.total > 0 ? entry.verified / entry.total : 0;
  }

  const fitness: {
    iterationId: string;
    goal: string;
    status: string;
    tasks: number;
    verified: number;
    applied: number;
    passRate: number;
    applyRate: number;
    tokens: number;
    domains: typeof domains;
    createdAt: string;
    signalError?: string;
  } = {
    iterationId: input.iterationId,
    goal: input.goal,
    status,
    tasks: input.tasks.length,
    verified: passed,
    applied,
    passRate: input.tasks.length > 0 ? passed / input.tasks.length : 0,
    applyRate: passed > 0 ? applied / passed : 0,
    tokens: totalTokens,
    domains,
    createdAt: new Date().toISOString(),
  };

  const signalRoot =
    process.env.KIT_SIGNALS_ROOT ??
    path.join(os.homedir(), ".agent-team-kit", "signals");
  try {
    await mkdir(signalRoot, { recursive: true });
    const at = new Date().toISOString();
    const lines = input.tasks.map((task) =>
      JSON.stringify({
        at,
        iterationId: input.iterationId,
        taskId: task.taskId,
        domain: task.domain,
        coder: task.coder,
        verified: task.verificationPass,
        applied: task.applied,
        risk: task.risk,
        tokens: task.tokens ?? 0,
        ...(task.error ? { error: task.error } : {}),
      }),
    );
    await appendFile(
      path.join(signalRoot, "iterations.jsonl"),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  } catch (error) {
    fitness.signalError =
      error instanceof Error ? error.message : String(error);
  }

  const fitnessArtifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:fitness`,
    content: JSON.stringify(fitness, null, 2),
    agentId: "fitness",
    modelId: "none",
    runMode: "LIVE",
  });

  const lines = [
    `# Iteration ${input.iterationId}`,
    "",
    `**Goal:** ${input.goal}`,
    "",
    `**Status:** ${status} (${passed}/${input.tasks.length} tasks verified)`,
    "",
    `Plan artifact: ${input.planArtifactId}`,
    "",
    ...(input.plan.summary
      ? [`**Plan summary:** ${input.plan.summary}`, ""]
      : []),
    "## Fitness",
    "",
    `- verified: ${passed}/${input.tasks.length}`,
    `- applied: ${applied}`,
    `- tokens: ${totalTokens}`,
    ...Object.entries(domains).map(
      ([domain, entry]) =>
        `- ${domain}: ${entry.verified}/${entry.total} verified, ${entry.applied} applied, ${entry.tokens} tokens`,
    ),
    ...(fitness.signalError
      ? [`- signal write error: ${fitness.signalError}`]
      : []),
    "",
    "## Tasks",
    "",
  ];

  for (const task of input.tasks) {
    lines.push(
      `### ${task.taskId} · ${task.domain}`,
      "",
      `- coder: ${task.coder} (${task.coderOk ? "ok" : "failed"})`,
      `- verification: ${task.verificationPass ? "pass" : "fail"}`,
      `- risk: ${task.risk}`,
      `- applied: ${task.applied ? "yes" : "no"}`,
      ...(task.commit ? [`- commit: ${task.commit}`] : []),
      ...(task.applyReason ? [`- apply: ${task.applyReason}`] : []),
      ...(task.reasons.length > 0
        ? [`- risk notes: ${task.reasons.join("; ")}`]
        : []),
      ...(task.error ? [`- error: ${task.error}`] : []),
      `- changed files: ${task.changedFiles.length > 0 ? task.changedFiles.join(", ") : "(none)"}`,
      "",
      ...(task.coderSummary
        ? ["**Coder summary:**", "", task.coderSummary, ""]
        : []),
    );
  }

  lines.push(
    "## Human touchpoints",
    "",
    "- Goal and budget supplied by the operator.",
    "- High-risk changes remain pending approval.",
    "- Release confirmation is still manual.",
    "",
  );

  const report = lines.join("\n");
  const reportArtifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:report`,
    content: report,
    agentId: "seller",
    modelId: "none",
    runMode: "LIVE",
  });

  const reportPath = path.join(
    resolveRepoRoot(),
    ".tmp",
    "iterations",
    safe(input.iterationId),
    "report.md",
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, "utf8");

  await updateRun(store, input.iterationId, {
    status,
    phase: status === "failed" ? "failed" : "done",
    reportArtifactId,
    finishedAt: new Date().toISOString(),
    ...(status === "failed" ? { error: "iteration failed" } : {}),
  });
  await safeOp(store, {
    workspaceId: input.workspaceId,
    entityKind: "iteration_run",
    entityId: input.iterationId,
    op: "iteration.status",
    actor: "engine",
    origin: "system",
    idempotencyKey: `iteration.status:${input.iterationId}:${status}`,
    payload: {
      status,
      reportArtifactId,
      tokens: totalTokens,
      passed,
      applied,
    },
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    kind: "run.finished",
    status,
    summary: `iteration ${status}`,
    payload: { reportArtifactId, fitnessArtifactId },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    kind: "iteration.run.finished",
    status,
    summary: `iteration ${status}`,
    payload: {
      tasks: input.tasks.length,
      verified: passed,
      applied,
      tokens: totalTokens,
      reportArtifactId,
      fitnessArtifactId,
    },
  });

  // Shadow-only mirror onto the unified change pipeline (85 §3.5). Disabled by
  // default (`KIT_CHANGE_PIPELINE`); it never changes the report or CLI output.
  try {
    await recordShadowIterationProposals(store, {
      workspaceId: input.workspaceId,
      iterationId: input.iterationId,
      goal: input.goal,
      plan: input.plan,
      results: input.tasks,
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      `[change] shadow iteration proposal recording failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { reportArtifactId, fitnessArtifactId, status };
}

function trimField(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function toStringArrayField(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return [];
  }
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : [];
  return parts
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function normalizeTask(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const task = { ...(raw as Record<string, unknown>) };
  for (const key of ["id", "domain", "goal", "acceptance"]) {
    task[key] = trimField(task[key]);
  }
  if (typeof task.risk === "string") {
    task.risk = task.risk.trim().toLowerCase();
  }
  task.filesHint = toStringArrayField(task.filesHint);
  task.dependsOn = toStringArrayField(task.dependsOn);
  return task;
}

export function normalizeTaskPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const plan = { ...(raw as Record<string, unknown>) };
  plan.goal = trimField(plan.goal);
  plan.summary = trimField(plan.summary);
  if (Array.isArray(plan.tasks)) {
    plan.tasks = plan.tasks.map(normalizeTask);
  }
  return plan;
}

export function parseTaskPlan(text: string): TaskPlan {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`planner returned invalid JSON: ${message}`);
  }
  return taskPlanSchema.parse(normalizeTaskPlan(parsed));
}

export function classifyRisk(
  files: string[],
  plannedRisk: "low" | "medium" | "high",
  ceiling: "low" | "medium" | "high",
): {
  risk: "low" | "medium" | "high";
  reasons: string[];
  forbidden: boolean;
  requiresApproval: boolean;
  protectedPaths: string[];
} {
  return classifyIterationRisk(files, plannedRisk, ceiling);
}

export async function buildRepoContext(repoRoot: string): Promise<string> {
  const entries = await readdir(repoRoot, { withFileTypes: true });
  const top = entries
    .filter(
      (entry) =>
        ![
          ".git",
          "node_modules",
          ".tmp",
          ".next",
          ".gstack",
          ".backup",
          "variants",
        ].includes(entry.name),
    )
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`)
    .join("\n");

  let packageInfo = "";
  try {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    packageInfo = JSON.stringify({ scripts: pkg.scripts ?? {} }, null, 2).slice(
      0,
      2000,
    );
  } catch {
    packageInfo = "(package.json unavailable)";
  }

  let readme = "";
  try {
    readme = (await readFile(path.join(repoRoot, "README.md"), "utf8")).slice(
      0,
      3000,
    );
  } catch {
    readme = "(README unavailable)";
  }

  const gitLog = await runProcess(
    "git",
    ["-C", repoRoot, "log", "--oneline", "-8"],
    {
      cwd: repoRoot,
      timeoutMs: 10_000,
    },
  );
  const gitStatus = await runProcess(
    "git",
    ["-C", repoRoot, "status", "--short"],
    { cwd: repoRoot, timeoutMs: 10_000 },
  );

  return [
    "Top level:",
    top,
    "",
    "package.json:",
    packageInfo,
    "",
    "Recent commits:",
    gitLog.stdout.trim() || "(none)",
    "",
    "Working tree:",
    gitStatus.stdout.trim() || "(clean)",
    "",
    "README excerpt:",
    readme,
  ]
    .join("\n")
    .slice(0, 12_000);
}

function stubPlan(goal: string, domains: IterationConfig["domains"]): TaskPlan {
  const tasks: IterationTask[] = [];
  if (domains.cyber) {
    tasks.push({
      id: "security-audit",
      domain: "cyber",
      goal: "Audit the Pack loader for unsafe path resolution (path traversal / escaping the pack directory), fix one concrete case, and add a focused test.",
      acceptance:
        "The fix is minimal, introduces no secrets, and typecheck/lint/tests pass.",
      filesHint: [],
      risk: "medium",
      dependsOn: [],
    });
  }
  if (domains.ux) {
    tasks.push({
      id: "ux-improvement",
      domain: "ux",
      goal: "Audit one Manager Console page (Office or Inbox) for a concrete clarity or hierarchy problem and implement the smallest copy/layout improvement.",
      acceptance:
        "The change is small and understandable, and typecheck/lint/tests pass.",
      filesHint: [],
      risk: "medium",
      dependsOn: [],
    });
  }
  if (domains.docs) {
    tasks.push({
      id: "docs-update",
      domain: "docs",
      goal: "Update the README or CHANGELOG so the documented behavior matches the current 0.9.0 autonomy preview.",
      acceptance:
        "The documentation is accurate, concise, and lint passes; no code changes.",
      filesHint: ["README.md", "CHANGELOG.md"],
      risk: "low",
      dependsOn: [],
    });
  }
  if (tasks.length === 0) {
    const [domain] = Object.keys(domains);
    if (!domain) {
      throw new Error("iteration pack has no domains");
    }
    tasks.push({
      id: "improvement",
      domain,
      goal,
      acceptance: "The change is minimal and all configured checks pass.",
      filesHint: [],
      risk: "medium",
      dependsOn: [],
    });
  }
  return taskPlanSchema.parse({
    goal,
    summary: "Deterministic stub plan (KIT_MODEL_MODE=stub or --stub).",
    tasks,
  });
}

async function loadInstructions(
  loaded: Awaited<ReturnType<typeof loadPack>>,
  agentId: string | undefined,
): Promise<string> {
  if (!loaded.ok) {
    return "";
  }
  if (!agentId) {
    return "You are a careful builder. Make the smallest correct change.";
  }
  const agent = loaded.agents.get(agentId);
  if (!agent) {
    return "You are a careful builder. Make the smallest correct change.";
  }
  const text = await readFile(path.join(loaded.dir, agent.spec.file), "utf8");
  return stripFrontmatter(text);
}

async function failVerification(
  store: Store,
  input: VerifyTaskActivityInput,
  reason: string,
  detail: string,
): Promise<IterationVerificationResult> {
  const artifactId = await publishIterationArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:verification`,
    content: JSON.stringify(
      { pass: false, reason, detail, checks: [] },
      null,
      2,
    ),
    agentId: "verifier",
    modelId: "none",
    runMode: "LIVE",
  });
  await updateTask(store, input.iterationId, input.task.id, {
    status: "failed",
    phase: "verification_failed",
    verificationArtifactId: artifactId,
    error: `${reason}: ${detail}`.slice(0, 2000),
  });
  await appendEvent(store, {
    iterationId: input.iterationId,
    taskId: input.task.id,
    kind: "verification.finished",
    status: "failed",
    summary: `${reason}: ${detail}`.slice(0, 500),
    payload: { pass: false, reason, detail: detail.slice(0, 2000) },
  });
  await safeActivity(store, {
    workspaceId: input.workspaceId,
    runId: input.iterationId,
    stageId: `${input.iterationId}:${input.task.id}:verify`,
    agentId: "verifier",
    kind: "iteration.verify",
    status: "failed",
    summary: `${reason}: ${detail}`.slice(0, 500),
    payload: { taskId: input.task.id, pass: false, reason, artifactId },
  });
  return {
    taskId: input.task.id,
    pass: false,
    feedback: `${reason}: ${detail}`,
    checks: [],
    artifactId,
  };
}

async function readPackageScripts(dir: string): Promise<Set<string> | null> {
  try {
    const raw = await readFile(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return null;
  }
}

function scriptFor(check: string): string | null {
  switch (check) {
    case "typecheck":
      return "typecheck";
    case "test":
      return "test";
    case "lint":
      return "lint";
    case "build":
      return "web:build";
    case "bench":
      return "bench:web";
    default:
      return null;
  }
}

async function runGit(cwd: string, args: string[]) {
  return await runProcess("git", args, {
    cwd,
    timeoutMs: 60_000,
    maxOutputBytes: 200_000,
  });
}

function resolveRepoRoot(override?: string): string {
  if (override) {
    return path.resolve(override);
  }
  const cwd = process.cwd();
  if (
    path.basename(cwd) === "runtime" &&
    path.basename(path.dirname(cwd)) === "apps"
  ) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
