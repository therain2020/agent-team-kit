import { createHash } from "node:crypto";
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
import {
  type CoderResult,
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
  applyPatchToRepo,
  newId,
  taskPlanSchema,
  writeApplyPatch,
} from "@kit/core";
import { createModelGateway } from "@kit/model";
import { loadPack } from "@kit/pack";
import { initStore } from "@kit/store";
import { securityScanCodeTool } from "@kit/tools";
import type {
  ApplyTaskActivityInput,
  ClassifyTaskActivityInput,
  CleanupInput,
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
import { Context } from "@temporalio/activity";

type Store = Awaited<ReturnType<typeof initStore>>;

let storePromise: Promise<Store> | undefined;

function getStore(): Promise<Store> {
  storePromise ??= initStore();
  return storePromise;
}

export async function planIteration(
  input: IterationInput,
): Promise<PlannedIteration> {
  const store = await getStore();
  const repoRoot = resolveRepoRoot();
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
    const gateway = createModelGateway();
    const context = await buildRepoContext(repoRoot);
    const domains = Object.entries(iteration.domains)
      .map(
        ([name, config]) =>
          `- ${name}: workflow=${config.workflow}, coder=${config.coder}, riskCeiling=${config.riskCeiling}`,
      )
      .join("\n");
    const response = await gateway.complete({
      model: iteration.planner.model,
      instructions: `You are the Planner for a task-centric agent team.
Decompose the goal into at most ${maxTasks} independent, verifiable tasks.
Use only the declared domains. Each task must include:
- id: lowercase kebab-case, unique
- domain: one of the declared domains
- goal: why the task exists and what to change
- acceptance: objective completion criteria
- filesHint: likely files/directories (may be empty)
- risk: low | medium | high
- dependsOn: array of task ids (may be empty)
Return JSON only: {"goal":"...","summary":"...","tasks":[...]}.
Do not invent files or facts. Prefer small, testable changes.`,
      input: `Goal: ${input.goal}
Acceptance: ${input.acceptance ?? "(none)"}
Max tasks: ${maxTasks}

Domains:
${domains}

Repository context:
${context}`,
    });
    plan = parseTaskPlan(response.text);
    tokens = response.usage.inputTokens + response.usage.outputTokens;
    costCny = response.usage.costCny ?? 0;
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

  const artifactId = await publishArtifact(store, {
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

  return { plan, artifactId, tokens, costCny };
}

export async function runIterationCoder(
  input: RunCoderActivityInput,
): Promise<IterationCoderResult> {
  const store = await getStore();
  const repoRoot = resolveRepoRoot();
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
  const instructions = await loadInstructions(loaded, domain.agent);
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

  const heartbeat = setInterval(() => {
    try {
      Context.current().heartbeat();
    } catch {
      // not inside an activity context
    }
  }, 30_000);

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
  } finally {
    clearInterval(heartbeat);
  }

  const resultArtifactId = await publishArtifact(store, {
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
  const transcriptArtifactId = await publishArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:attempt-${input.attempt}:coder:transcript`,
    content: result.transcript || "(empty transcript)",
    agentId: `coder:${result.coder}`,
    modelId: "none",
    runMode: input.runMode,
  });
  const diffArtifactId = await publishArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:attempt-${input.attempt}:coder:diff`,
    content: result.diff || "(no diff)",
    agentId: `coder:${result.coder}`,
    modelId: "none",
    runMode: input.runMode,
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
  if (!input.sandboxDir || !existsSync(input.sandboxDir)) {
    return await failVerification(
      store,
      input,
      "sandbox missing",
      "the coder sandbox no longer exists",
    );
  }
  if (input.changedFiles.length === 0) {
    return await failVerification(
      store,
      input,
      "no changes",
      "the coder produced no changed files",
    );
  }

  const checks: IterationVerificationResult["checks"] = [];
  const heartbeat = setInterval(() => {
    try {
      Context.current().heartbeat();
    } catch {
      // not inside an activity context
    }
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
      const bun = commandOnPath("bun") ?? "bun";
      const result = await runProcess(bun, ["run", script], {
        cwd: input.sandboxDir,
        timeoutMs: 20 * 60 * 1000,
        maxOutputBytes: 200_000,
      });
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
    clearInterval(heartbeat);
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

  const artifactId = await publishArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:verification`,
    content: JSON.stringify({ pass, checks, feedback }, null, 2),
    agentId: "verifier",
    modelId: "none",
    runMode: "LIVE",
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

  const artifactId = await publishArtifact(store, {
    iterationId: input.iterationId,
    workspaceId: input.workspaceId,
    stageId: `${input.iterationId}:${input.task.id}:risk`,
    content: JSON.stringify(classified, null, 2),
    agentId: "risk-classifier",
    modelId: "none",
    runMode: "LIVE",
  });
  return {
    taskId: input.task.id,
    risk: classified.risk,
    reasons: [...classified.reasons, `risk artifact: ${artifactId}`],
    forbidden: classified.forbidden,
  };
}

export async function applyIterationTask(
  input: ApplyTaskActivityInput,
): Promise<IterationApplyResult> {
  const store = await getStore();
  const repoRoot = resolveRepoRoot();
  const ticketId = newId("tkt");
  let headBefore = "";
  let baseDrifted = false;

  const heartbeat = setInterval(() => {
    try {
      Context.current().heartbeat({ ticketId, phase: "apply" });
    } catch {
      // not inside an activity context
    }
  }, 30_000);
  heartbeat.unref?.();

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
        ${input.diffArtifactId}, ${JSON.stringify(input.changedFiles)}::jsonb,
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
    const artifactId = await publishArtifact(store, {
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
    if (input.forbidden) {
      return await publishApply("blocked", "forbidden path detected");
    }
    if (!input.verificationPass) {
      return await publishApply("blocked", "verification did not pass");
    }
    if (!input.diffArtifactId) {
      return await publishApply("blocked", "missing diff artifact");
    }
    if (!allowedByApplyMode(input.risk, input.applyMode)) {
      return await publishApply(
        "skipped",
        `risk ${input.risk} is not auto-applied by mode ${input.applyMode}`,
      );
    }

    const diff = await readArtifactText(store, input.diffArtifactId);
    if (!diff || diff === "(no diff)" || diff.includes("[truncated at")) {
      return await publishApply("blocked", "diff is empty or truncated");
    }

    const { patchFile, backupDir } = await writeApplyPatch(
      repoRoot,
      safe(input.iterationId),
      safe(input.task.id),
      diff,
    );
    const applied = await applyPatchToRepo({
      repoRoot,
      patchFile,
      baseSha: input.baselineSha,
      changedFiles: input.changedFiles,
      ticketId,
      commitMessage: `autonomy: ${input.task.id} (${input.task.domain})`,
      format: (root) => formatAppliedFiles(root),
      postCheck: (root) => runPostApplyChecks(root, input.risk),
    });
    headBefore = applied.headBefore;
    baseDrifted = applied.baseDrifted;
    return await publishApply(applied.status, applied.reason, {
      ...(applied.commitSha ? { commit: applied.commitSha } : {}),
      details: { backupDir },
    });
  } finally {
    clearInterval(heartbeat);
  }
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

  const fitnessArtifactId = await publishArtifact(store, {
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
  const reportArtifactId = await publishArtifact(store, {
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

  return { reportArtifactId, fitnessArtifactId, status };
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
  return taskPlanSchema.parse(parsed);
}

export function classifyRisk(
  files: string[],
  plannedRisk: "low" | "medium" | "high",
  ceiling: "low" | "medium" | "high",
): {
  risk: "low" | "medium" | "high";
  reasons: string[];
  forbidden: boolean;
} {
  let computed: "low" | "medium" | "high" = "low";
  const reasons: string[] = [];
  let forbidden = false;

  for (const file of files) {
    const normalized = file.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      normalized.includes("..") ||
      /^(\.git|node_modules|\.env|\.tmp|variants|\.backup)(\/|$)/.test(
        normalized,
      )
    ) {
      forbidden = true;
      reasons.push(`forbidden path: ${normalized}`);
      continue;
    }
    if (
      /^(apps\/runtime\/|packages\/(core|workflow|store|queue|model|manager|evolution|telemetry|testing|source|autopilot)\/|deploy\/|\.github\/|bun\.lock$|package\.json$|packs\/[^/]+\/(team|autopilot|policies|iteration)\.yaml)/.test(
        normalized,
      )
    ) {
      computed = maxRisk(computed, "high");
      reasons.push(`core path: ${normalized}`);
      continue;
    }
    if (
      /^(apps\/cli\/|apps\/gateway\/|packages\/(pack|tools|coder)\/|apps\/web\/app\/api\/|apps\/web\/lib\/)/.test(
        normalized,
      )
    ) {
      computed = maxRisk(computed, "medium");
      reasons.push(`server code: ${normalized}`);
      continue;
    }
    if (
      /^(docs\/|.*README\.md$|.*CHANGELOG\.md$|apps\/web\/messages\/|.*\.test\.ts$|.*\/test\/)/.test(
        normalized,
      )
    ) {
      reasons.push(`low-risk path: ${normalized}`);
      continue;
    }
    computed = maxRisk(computed, "medium");
    reasons.push(`default medium: ${normalized}`);
  }

  let risk = maxRisk(plannedRisk, computed);
  if (riskRank(risk) > riskRank(ceiling)) {
    reasons.push(`exceeds domain risk ceiling ${ceiling}`);
    risk = "high";
  }
  return { risk, reasons, forbidden };
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
  const artifactId = await publishArtifact(store, {
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
  return {
    taskId: input.task.id,
    pass: false,
    feedback: `${reason}: ${detail}`,
    checks: [],
    artifactId,
  };
}

async function formatAppliedFiles(repoRoot: string): Promise<void> {
  const changed = await runGit(repoRoot, ["diff", "--name-only", "HEAD"]);
  if (changed.exitCode !== 0) {
    return;
  }
  const files = changed.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter((file) => /\.(ts|tsx|js|jsx|json|css|md|yaml|yml)$/.test(file));
  if (files.length === 0) {
    return;
  }
  const bun = commandOnPath("bun") ?? "bun";
  await runProcess(bun, ["x", "biome", "check", "--write", ...files], {
    cwd: repoRoot,
    timeoutMs: 120_000,
    maxOutputBytes: 200_000,
  });
}

async function runPostApplyChecks(
  repoRoot: string,
  risk: "low" | "medium" | "high",
): Promise<{
  ok: boolean;
  feedback: string;
}> {
  const bun = commandOnPath("bun") ?? "bun";
  const checks = ["typecheck", "lint", "test"];
  if (risk === "medium") {
    checks.push("web:build");
  }
  const failures: string[] = [];
  for (const check of checks) {
    const result = await runProcess(bun, ["run", check], {
      cwd: repoRoot,
      timeoutMs: 20 * 60 * 1000,
      maxOutputBytes: 200_000,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      failures.push(
        `[${check}] exit=${result.exitCode} timeout=${result.timedOut}\n${[result.stdout, result.stderr].join("\n").slice(-3000)}`,
      );
    }
  }
  return {
    ok: failures.length === 0,
    feedback: failures.join("\n\n"),
  };
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

function allowedByApplyMode(
  risk: "low" | "medium" | "high",
  mode: "none" | "low" | "low-medium",
): boolean {
  if (mode === "none" || risk === "high") {
    return false;
  }
  if (risk === "low") {
    return true;
  }
  return mode === "low-medium";
}

async function publishArtifact(
  store: Store,
  input: {
    iterationId: string;
    workspaceId: string;
    stageId: string;
    content: string;
    agentId: string;
    modelId: string;
    tokens?: number;
    costCny?: number;
    runMode: "DRY_RUN" | "LIVE";
  },
): Promise<string> {
  const published = await store.artifactService.publish({
    workspaceId: input.workspaceId,
    content: new TextEncoder().encode(input.content),
    producer: {
      agentId: input.agentId,
      agentVersion: "0.9.0",
      promptHash: hash(input.stageId),
      modelId: input.modelId,
    },
    inputs: [],
    runId: input.iterationId,
    stageId: input.stageId,
    runMode: input.runMode,
    cost: {
      currency: "CNY",
      amount: input.costCny ?? 0,
      tokens: input.tokens ?? 0,
    },
    sensitivity: "internal",
    retentionClass: "artifact_365d",
  });
  return published.artifact.artifactId;
}

async function readArtifactText(
  store: Store,
  artifactId: string,
): Promise<string> {
  const artifact = await store.artifactStore.findById(artifactId);
  if (!artifact) {
    return "";
  }
  const blob = await store.blobs.findById(artifact.blobId);
  if (!blob) {
    return "";
  }
  const bytes = await store.blobClient.get(blob.storageKey);
  return new TextDecoder().decode(bytes);
}

async function runGit(cwd: string, args: string[]) {
  return await runProcess("git", args, {
    cwd,
    timeoutMs: 60_000,
    maxOutputBytes: 200_000,
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

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function riskRank(risk: "low" | "medium" | "high"): number {
  return risk === "low" ? 0 : risk === "medium" ? 1 : 2;
}

function maxRisk(
  a: "low" | "medium" | "high",
  b: "low" | "medium" | "high",
): "low" | "medium" | "high" {
  return riskRank(a) >= riskRank(b) ? a : b;
}
