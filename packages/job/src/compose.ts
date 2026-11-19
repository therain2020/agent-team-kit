import path from "node:path";
import {
  type AgentRole,
  type AutopilotConfig,
  agentRoleSchema,
  isCronExpression,
} from "@kit/core";
import { createModelGateway, loadModelConfig } from "@kit/model";
import {
  inferAgentRole,
  loadPack,
  packCatalog,
  rolePlanForAgents,
  validateRolePlan,
} from "@kit/pack";
import { JobError } from "./types";

export type ComposeKind =
  | "mission"
  | "packRun"
  | "approvalPolicy"
  | "autopilot"
  | "evolutionCycle"
  | "agent";

export interface ComposeInput {
  kind: ComposeKind;
  intent: string;
  packDir: string;
  repoRoot: string;
  env?: Record<string, string | undefined>;
  /** Agent being edited; empty when drafting a brand-new member. */
  agentId?: string;
  /** Current form values so drafts preserve unsaved edits. */
  current?: Partial<AgentDraftValues>;
}

export interface MissionValues {
  workflow: string;
  manager: string;
  sellers: string[];
  builders: string[];
  specialists: string[];
  acceptance: string;
}

export interface PackRunValues {
  workflow: string;
  stub: boolean;
}

export interface ApprovalValue {
  mode: "required" | "auto" | "never";
  position: "before" | "after";
  riskClass: "low" | "medium" | "high";
  ttl: string;
  autoApproveWhen?: { maxRunCostCny: number };
}

export interface PolicyRow {
  file: string;
  stageId: string;
  stageType: string;
  agent?: string;
  approval: ApprovalValue | null;
  reason: string;
}

export interface ApprovalPolicyValues {
  policies: PolicyRow[];
}

export type AutopilotValues = AutopilotConfig;

export interface EvolutionCycleValues {
  packDir: string;
  agentId: string;
  hypothesis: string;
  stub: boolean;
  autoApply: boolean;
  force: boolean;
}

export interface AgentDraftValues {
  description: string;
  model: string;
  role: AgentRole;
  instructions: string;
  tools: string[];
  skills: string[];
}

export interface ComposeResult {
  kind: ComposeKind;
  values:
    | MissionValues
    | PackRunValues
    | ApprovalPolicyValues
    | AutopilotValues
    | EvolutionCycleValues
    | AgentDraftValues;
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

const DEFAULT_ACCEPTANCE =
  "Small verified changes; high-risk changes stay pending approval.";

export async function composeJob(input: ComposeInput): Promise<ComposeResult> {
  const intent = input.intent.trim();
  if (!intent) {
    throw new JobError("intent_required", "a one-line intent is required", 400);
  }
  const packDir = resolvePackDir(input.repoRoot, input.packDir);
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new JobError(
      "invalid_pack",
      `invalid pack: ${loaded.errors.join("; ")}`,
    );
  }
  if (loaded.workflows.length === 0) {
    throw new JobError("invalid_pack", "pack has no workflows");
  }

  const agents = [...loaded.agents.entries()].map(([id, agent]) => ({
    id,
    role: agent.role,
  }));
  const workflows = loaded.workflows.map((workflow) => ({
    id: workflow.id,
    stages: workflow.stages.length,
  }));
  const facts = {
    pack: loaded.pack.metadata.name,
    workflows,
    agents,
    roleRules: loaded.roleRules,
  };

  if (input.kind === "autopilot") {
    return composeAutopilot(
      intent,
      {
        pack: loaded.pack.metadata.name,
        workflows: loaded.workflows.map((workflow) => ({
          id: workflow.id,
          stages: workflow.stages.map((stage) => stage.id),
        })),
        current: loaded.autopilot ?? null,
      },
      input.env ?? process.env,
    );
  }
  if (input.kind === "evolutionCycle") {
    return composeEvolutionCycle(
      intent,
      {
        pack: loaded.pack.metadata.name,
        packDir: path.basename(loaded.dir),
        agents: [...loaded.agents.entries()].map(([id, agent]) => ({
          id,
          role: agent.role,
          model: agent.frontmatter.model,
        })),
      },
      input.env ?? process.env,
    );
  }
  if (input.kind === "agent") {
    const env = input.env ?? process.env;
    const agentId = input.agentId?.trim() || null;
    const current = sanitizeAgentCurrent(input.current);
    const catalog = await packCatalog(loaded.dir);
    const packAgents = [...loaded.agents.entries()].map(([id, agent]) => ({
      id,
      role: agent.role,
      model: agent.spec.model,
      tools: agent.spec.tools,
      skills: agent.spec.skills,
    }));
    const isManager =
      agentId === "manager" ||
      current?.role === "manager" ||
      (agentId !== null && loaded.agents.get(agentId)?.role === "manager");
    return composeAgent(
      intent,
      {
        pack: loaded.pack.metadata.name,
        workflows: loaded.workflows.map((workflow) => ({
          id: workflow.id,
          stages: workflow.stages.map((stage) => stage.id),
        })),
        agents: packAgents,
        tools: catalog.tools.map((tool) => tool.name),
        skills: catalog.skills,
        models: agentModelWhitelist(
          env,
          packAgents.map((agent) => agent.model),
        ),
        agentId,
        current,
        isManager,
      },
      env,
    );
  }
  if (input.kind === "packRun") {
    return composePackRun(intent, facts, input.env ?? process.env);
  }
  if (input.kind === "approvalPolicy") {
    const policyWorkflows = loaded.workflows.map((workflow, index) => ({
      id: workflow.id,
      file: loaded.pack.workflows[index] ?? workflow.id,
      stages: workflow.stages.map((stage) => ({
        id: stage.id,
        type: stage.type,
        ...(stage.agent ? { agent: stage.agent } : {}),
        approval: stage.approval ?? null,
      })),
    }));
    return composeApprovalPolicy(
      intent,
      { pack: loaded.pack.metadata.name, workflows: policyWorkflows },
      input.env ?? process.env,
    );
  }
  return composeMission(intent, facts, input.env ?? process.env);
}

interface PackFacts {
  pack: string;
  workflows: Array<{ id: string; stages: number }>;
  agents: Array<{ id: string; role: AgentRole }>;
  roleRules: {
    requireSeller: boolean;
    requireBuilder: boolean;
    allowCombined: boolean;
  };
}

async function composeMission(
  intent: string,
  facts: PackFacts,
  env: Record<string, string | undefined>,
): Promise<ComposeResult> {
  const allowCombined = facts.roleRules.allowCombined;
  const fallback = defaultMission(facts);
  const warnings: string[] = [];
  if (facts.roleRules.requireSeller && fallback.sellers.length === 0) {
    warnings.push("这个 Pack 要求 Seller，但没有角色为 seller 的 agent。");
  }
  if (facts.roleRules.requireBuilder && fallback.builders.length === 0) {
    warnings.push("这个 Pack 要求 Builder，但没有可用 Builder。");
  }

  let values = fallback;
  let rationale = "使用第一个工作流，并按 Pack 的默认角色分配。";
  let model: ComposeResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You assign a mission to a private agent team.
Return JSON only:
{"workflow":"<id>","manager":"<id>","sellers":["<id>"],"builders":["<id>"],"specialists":["<id>"],"acceptance":"<one sentence>","rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- workflow must be one of the provided workflow ids.
- only use agent ids listed below; manager cannot be assigned as seller/builder/specialist.
- if requireSeller is true, choose at least one seller-role agent.
- if requireBuilder is true, choose at least one builder-role agent.
- if allowCombined is false, the same agent cannot be both seller and builder.
- keep the team as small as possible; acceptance must be objectively checkable.
- do not invent facts.`,
      input: JSON.stringify({ intent, ...facts }),
    });
    const parsed = parseJson(response.text);
    if (parsed) {
      const validated = validateMission(parsed, facts);
      if (validated) {
        values = validated.values;
        rationale = validated.rationale ?? rationale;
        warnings.push(...validated.warnings);
        model = "live";
      }
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用 Pack 默认配置。");
  }

  return {
    kind: "mission",
    values,
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

async function composePackRun(
  intent: string,
  facts: PackFacts,
  env: Record<string, string | undefined>,
): Promise<ComposeResult> {
  const fallback: PackRunValues = {
    workflow: facts.workflows[0]?.id ?? "",
    stub: true,
  };
  let values = fallback;
  let rationale = "使用第一个工作流，并以 stub 模式试运行。";
  let model: ComposeResult["model"] = "heuristic";
  const warnings: string[] = [];

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `Choose a workflow for a pack trial run.
Return JSON only:
{"workflow":"<id>","stub":true,"rationale":"<one sentence>","warnings":["<optional>"]}
Rules: workflow must be one of the provided ids; prefer a stub run unless the intent explicitly requires live models; do not invent facts.`,
      input: JSON.stringify({ intent, ...facts }),
    });
    const parsed = parseJson(response.text);
    if (parsed) {
      const workflow =
        typeof parsed.workflow === "string" &&
        facts.workflows.some((item) => item.id === parsed.workflow)
          ? parsed.workflow
          : fallback.workflow;
      values = {
        workflow,
        stub: parsed.stub !== false,
      };
      rationale =
        typeof parsed.rationale === "string" && parsed.rationale.trim()
          ? parsed.rationale.trim().slice(0, 500)
          : rationale;
      if (Array.isArray(parsed.warnings)) {
        warnings.push(
          ...parsed.warnings
            .filter((item): item is string => typeof item === "string")
            .slice(0, 5),
        );
      }
      model = "live";
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用默认工作流。");
  }

  return {
    kind: "packRun",
    values,
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

interface AutopilotFacts {
  pack: string;
  workflows: Array<{ id: string; stages: string[] }>;
  current: AutopilotConfig | null;
}

function defaultAutopilot(facts: AutopilotFacts): AutopilotConfig {
  const current = facts.current;
  const first = facts.workflows[0]?.id ?? "";
  const schedules =
    current && current.schedules.length > 0
      ? current.schedules
      : first
        ? [
            {
              id: "daily-run",
              workflow: first,
              cron: "0 9 * * *",
              mode: "DRY_RUN" as const,
            },
          ]
        : [];
  return {
    version: 1,
    enabled: current?.enabled ?? false,
    timezone: current?.timezone ?? "UTC",
    schedules,
    iterations: current?.iterations ?? [],
    approval: {
      autoApprove: current?.approval?.autoApprove ?? {
        enabled: false,
        maxRisk: "low",
        onTimeout: "wait",
      },
    },
    ...(current?.evolution ? { evolution: current.evolution } : {}),
  };
}

async function composeAutopilot(
  intent: string,
  facts: AutopilotFacts,
  env: Record<string, string | undefined>,
): Promise<ComposeResult> {
  const fallback = defaultAutopilot(facts);
  const warnings: string[] = [];
  if (facts.workflows.length === 0) {
    warnings.push("这个 Pack 没有工作流，无法生成自动运行计划。");
  }
  let values = fallback;
  let rationale =
    fallback.schedules.length > 0
      ? "保留现有计划，默认以 dry-run 运行。"
      : "默认每天 09:00 以 dry-run 试运行一次。";
  let model: ComposeResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You schedule an autonomous agent team.
Return JSON only:
{"schedules":[{"workflow":"<id>","cron":"<5-field cron>","mode":"DRY_RUN|LIVE","dailyRuns":1,"dailyCostCny":1}],"timezone":"<IANA timezone>","rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- workflow must be one of the provided workflow ids.
- cron is a 5-field expression interpreted in the timezone; prefer off-peak hours.
- default to mode DRY_RUN; use LIVE only when the intent explicitly asks to run for real.
- dailyRuns must be 1-24 and dailyCostCny 0-20; omit them when unsure.
- never enable the daemon or auto-approval; those stay human decisions.
- do not invent workflows, budgets or facts.`,
      input: JSON.stringify({
        intent,
        pack: facts.pack,
        workflows: facts.workflows,
        currentSchedules: fallback.schedules,
        timezone: fallback.timezone,
      }),
    });
    const parsed = parseJson(response.text);
    if (parsed) {
      const validated = validateAutopilotSchedules(
        parsed.schedules,
        facts,
        fallback.schedules,
        warnings,
      );
      const timezone = validateTimezone(parsed.timezone);
      values = {
        ...fallback,
        schedules: validated.schedules,
        ...(timezone ? { timezone } : {}),
      };
      if (validated.accepted) {
        rationale =
          typeof parsed.rationale === "string" && parsed.rationale.trim()
            ? parsed.rationale.trim().slice(0, 500)
            : rationale;
        if (Array.isArray(parsed.warnings)) {
          warnings.push(
            ...parsed.warnings
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.slice(0, 300))
              .slice(0, 5),
          );
        }
        model = "live";
      } else {
        warnings.push("AI 计划未通过校验，已使用默认计划。");
      }
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用默认计划。");
  }

  return {
    kind: "autopilot",
    values,
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

function validateAutopilotSchedules(
  raw: unknown,
  facts: AutopilotFacts,
  fallback: AutopilotConfig["schedules"],
  warnings: string[],
): { schedules: AutopilotConfig["schedules"]; accepted: boolean } {
  if (!Array.isArray(raw)) {
    return { schedules: fallback, accepted: false };
  }
  const workflowIds = new Set(facts.workflows.map((workflow) => workflow.id));
  const schedules: AutopilotConfig["schedules"] = [];
  const usedIds = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const workflow =
      typeof record.workflow === "string" && workflowIds.has(record.workflow)
        ? record.workflow
        : null;
    if (!workflow) {
      warnings.push("AI 选的工作流不存在，已忽略该计划。");
      continue;
    }
    const cron =
      typeof record.cron === "string" && isCronExpression(record.cron.trim())
        ? record.cron.trim().replace(/\s+/g, " ")
        : null;
    if (!cron) {
      warnings.push(`计划 ${workflow} 的 cron 表达式无效，已忽略。`);
      continue;
    }
    const baseId = slug(
      typeof record.id === "string" && record.id.trim()
        ? record.id
        : `${workflow}-schedule`,
    );
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    const dailyRuns = clampNumber(record.dailyRuns, 1, 24);
    const dailyCostCny = clampNumber(record.dailyCostCny, 0, 20);
    schedules.push({
      id,
      workflow,
      cron,
      mode: record.mode === "LIVE" ? "LIVE" : "DRY_RUN",
      ...(dailyRuns !== undefined || dailyCostCny !== undefined
        ? {
            budget: {
              ...(dailyRuns !== undefined ? { dailyRuns } : {}),
              ...(dailyCostCny !== undefined ? { dailyCostCny } : {}),
            },
          }
        : {}),
    });
  }
  return schedules.length > 0
    ? { schedules, accepted: true }
    : { schedules: fallback, accepted: false };
}

function validateTimezone(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "UTC" || /^[A-Za-z]+\/[A-Za-z0-9_+-]+$/.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

interface EvolutionFacts {
  pack: string;
  packDir: string;
  agents: Array<{ id: string; role: AgentRole; model?: string }>;
}

async function composeEvolutionCycle(
  intent: string,
  facts: EvolutionFacts,
  env: Record<string, string | undefined>,
): Promise<ComposeResult> {
  const employees = facts.agents.filter((agent) => agent.role !== "manager");
  const pool = employees.length > 0 ? employees : facts.agents;
  const fallbackAgent =
    pool.find((agent) => intent.toLowerCase().includes(agent.id)) ?? pool[0];
  const warnings: string[] = [];
  if (!fallbackAgent) {
    throw new JobError("invalid_pack", "pack has no evolvable agent", 400);
  }
  let agentId = fallbackAgent.id;
  let hypothesis = `Improve ${agentId} so the next cycle addresses: ${intent}`;
  let rationale =
    "选择 Pack 的第一个非 Manager agent，用一句话假设驱动本轮演化。";
  let model: ComposeResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You propose one evolution cycle for a private agent team.
Return JSON only:
{"agentId":"<id>","hypothesis":"<one sentence>","rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- agentId must be one of the provided agent ids; prefer a non-manager agent.
- the hypothesis must be checkable and limited to role instructions; never change tools, permissions, models or files.
- do not invent failure signals, evidence or scores.
- keep hypothesis and rationale under 300 characters.`,
      input: JSON.stringify({
        intent,
        pack: facts.pack,
        agents: facts.agents,
      }),
    });
    const parsed = parseJson(response.text);
    if (parsed) {
      const byId = new Map(facts.agents.map((agent) => [agent.id, agent]));
      const chosen =
        typeof parsed.agentId === "string" && byId.has(parsed.agentId)
          ? parsed.agentId
          : null;
      const text =
        typeof parsed.hypothesis === "string" && parsed.hypothesis.trim()
          ? parsed.hypothesis.trim().slice(0, 500)
          : null;
      if (chosen && text) {
        agentId = chosen;
        hypothesis = text;
        rationale =
          typeof parsed.rationale === "string" && parsed.rationale.trim()
            ? parsed.rationale.trim().slice(0, 500)
            : rationale;
        if (Array.isArray(parsed.warnings)) {
          warnings.push(
            ...parsed.warnings
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.slice(0, 300))
              .slice(0, 5),
          );
        }
        model = "live";
      }
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用启发式假设。");
  }

  return {
    kind: "evolutionCycle",
    values: {
      packDir: facts.packDir,
      agentId,
      hypothesis: hypothesis.slice(0, 500),
      stub: true,
      autoApply: false,
      force: true,
    },
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

export interface AgentDraftFacts {
  pack: string;
  workflows: Array<{ id: string; stages: string[] }>;
  agents: Array<{
    id: string;
    role: AgentRole;
    model: string;
    tools: string[];
    skills: string[];
  }>;
  tools: string[];
  skills: string[];
  models: string[];
  agentId: string | null;
  current: Partial<AgentDraftValues> | null;
  isManager: boolean;
}

async function composeAgent(
  intent: string,
  facts: AgentDraftFacts,
  env: Record<string, string | undefined>,
): Promise<ComposeResult> {
  const warnings: string[] = [];
  const fallback = defaultAgentDraft(intent, facts, warnings);
  let values = fallback;
  let rationale = facts.current
    ? "在现有成员字段的基础上补全草稿。"
    : "按成员 id 与意图推断职责，生成可编辑的成员草稿。";
  let model: ComposeResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You draft ONE teammate for a private agent team.
Return JSON only:
{"description":"<one sentence>","model":"<model id>","role":"builder|seller|specialist|manager","instructions":"<role prompt in Markdown>","tools":["<tool name>"],"skills":["<skill name>"],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- role must be one of the allowed roles; only the manager may use "manager".
- model must be one of the allowed models.
- tools and skills must come from the provided catalogs; never invent them.
- preserve the existing values unless the intent asks to change them.
- keep the description under 200 characters; do not invent facts.`,
      input: JSON.stringify({
        intent,
        pack: facts.pack,
        agentId: facts.agentId,
        isManager: facts.isManager,
        current: facts.current,
        roles: [
          "builder",
          "seller",
          "specialist",
          ...(facts.isManager ? ["manager"] : []),
        ],
        models: facts.models,
        tools: facts.tools,
        skills: facts.skills,
        agents: facts.agents,
        workflows: facts.workflows,
      }),
    });
    const parsed = parseJson(response.text);
    if (parsed) {
      const validated = validateAgentDraft(parsed, fallback, facts);
      if (validated.accepted) {
        values = validated.values;
        rationale = validated.rationale ?? rationale;
        warnings.push(...validated.warnings);
        if (Array.isArray(parsed.warnings)) {
          warnings.push(
            ...parsed.warnings
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.slice(0, 300))
              .slice(0, 5),
          );
        }
        model = "live";
      } else {
        warnings.push("AI 草稿未通过校验，已使用启发式草稿。");
      }
    } else {
      warnings.push("AI 草稿无法解析，已使用启发式草稿。");
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用启发式草稿。");
  }

  return {
    kind: "agent",
    values,
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

function agentModelWhitelist(
  env: Record<string, string | undefined>,
  packModels: string[],
): string[] {
  const config = loadModelConfig(env);
  return [
    ...new Set([
      ...Object.keys(config.aliases),
      ...Object.values(config.aliases),
      ...packModels.filter((model) => model.trim().length > 0),
    ]),
  ].sort();
}

function sanitizeAgentCurrent(
  value: Partial<AgentDraftValues> | undefined,
): Partial<AgentDraftValues> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const current: Partial<AgentDraftValues> = {};
  if (typeof record.description === "string") {
    current.description = record.description;
  }
  if (typeof record.model === "string") {
    current.model = record.model;
  }
  if (typeof record.role === "string") {
    current.role = record.role as AgentRole;
  }
  if (typeof record.instructions === "string") {
    current.instructions = record.instructions;
  }
  if (Array.isArray(record.tools)) {
    current.tools = record.tools.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(record.skills)) {
    current.skills = record.skills.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return Object.keys(current).length > 0 ? current : null;
}

function defaultAgentDraft(
  intent: string,
  facts: AgentDraftFacts,
  warnings: string[],
): AgentDraftValues {
  const current = facts.current ?? {};
  const id = (facts.agentId ?? "").trim();
  const description =
    current.description?.trim() ||
    `${id || "Teammate"}: ${intent}`.slice(0, 300);

  let role: AgentRole = facts.isManager
    ? "manager"
    : inferAgentRole(id, description, false);
  if (current.role) {
    const parsed = agentRoleSchema.safeParse(current.role);
    if (facts.isManager) {
      if (parsed.success && parsed.data !== "manager") {
        warnings.push("经理职责保持 manager。");
      }
    } else if (!parsed.success) {
      warnings.push(`未知职责 ${String(current.role)}，已按 id 推断。`);
    } else if (parsed.data === "manager") {
      warnings.push("非经理成员不能使用 manager 职责，已按 id 推断。");
    } else {
      role = parsed.data;
    }
  }

  let model = defaultAgentModel(facts.models);
  const currentModel = current.model?.trim();
  if (currentModel) {
    if (facts.models.includes(currentModel)) {
      model = currentModel;
    } else {
      warnings.push(`现有模型 ${currentModel} 不在白名单内，已改用 ${model}。`);
    }
  }

  const instructions = (
    current.instructions?.trim() ||
    `You are ${id || "a team member"}. ${intent.trim()} Complete the assigned stage and return a concise, verifiable result.`
  ).slice(0, 8000);

  return {
    description,
    model,
    role,
    instructions,
    tools: filterCatalog(current.tools, facts.tools, "工具", warnings),
    skills: filterCatalog(current.skills, facts.skills, "技能", warnings),
  };
}

function defaultAgentModel(models: string[]): string {
  return models.includes("deepseek-flash")
    ? "deepseek-flash"
    : (models[0] ?? "deepseek-flash");
}

function filterCatalog(
  values: string[] | undefined,
  catalog: string[],
  label: string,
  warnings: string[],
): string[] {
  if (!values) {
    return [];
  }
  const allowed = new Set(catalog);
  const requested = [
    ...new Set(values.map((item) => item.trim()).filter(Boolean)),
  ];
  const dropped = requested.filter((item) => !allowed.has(item));
  if (dropped.length > 0) {
    warnings.push(
      `${label}不存在于 Pack 目录，已剔除：${dropped.slice(0, 5).join(", ")}`,
    );
  }
  return requested.filter((item) => allowed.has(item));
}

export function validateAgentDraft(
  parsed: Record<string, unknown>,
  fallback: AgentDraftValues,
  facts: AgentDraftFacts,
): {
  values: AgentDraftValues;
  rationale?: string;
  warnings: string[];
  accepted: boolean;
} {
  const warnings: string[] = [];
  let accepted = false;
  const values: AgentDraftValues = {
    ...fallback,
    tools: [...fallback.tools],
    skills: [...fallback.skills],
  };
  const models = new Set(facts.models);
  const tools = new Set(facts.tools);
  const skills = new Set(facts.skills);

  if (typeof parsed.description === "string" && parsed.description.trim()) {
    values.description = parsed.description.trim().slice(0, 300);
    accepted = true;
  }
  if (typeof parsed.instructions === "string" && parsed.instructions.trim()) {
    values.instructions = parsed.instructions.trim().slice(0, 8000);
    accepted = true;
  }
  if (typeof parsed.model === "string" && parsed.model.trim()) {
    const candidate = parsed.model.trim();
    if (models.has(candidate)) {
      values.model = candidate;
      accepted = true;
    } else {
      warnings.push(`模型 ${candidate} 不在白名单内，已保留默认模型。`);
    }
  }
  if (typeof parsed.role === "string") {
    const parsedRole = agentRoleSchema.safeParse(parsed.role);
    if (!parsedRole.success) {
      warnings.push(`未知职责 ${parsed.role}，已保留默认角色。`);
    } else if (facts.isManager && parsedRole.data !== "manager") {
      warnings.push("经理职责不能被改为其他角色，已保留 manager。");
    } else if (!facts.isManager && parsedRole.data === "manager") {
      warnings.push("非经理成员不能使用 manager 职责，已保留默认角色。");
    } else {
      values.role = parsedRole.data;
      accepted = true;
    }
  }
  const parseList = (
    raw: unknown,
    catalog: Set<string>,
    label: string,
  ): string[] | null => {
    if (!Array.isArray(raw)) {
      return null;
    }
    const requested = [
      ...new Set(
        raw
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    const dropped = requested.filter((item) => !catalog.has(item));
    if (dropped.length > 0) {
      warnings.push(
        `${label}不存在于 Pack 目录，已剔除：${dropped.slice(0, 5).join(", ")}`,
      );
    }
    return requested.filter((item) => catalog.has(item));
  };
  const parsedTools = parseList(parsed.tools, tools, "工具");
  if (parsedTools) {
    values.tools = parsedTools;
    accepted = true;
  }
  const parsedSkills = parseList(parsed.skills, skills, "技能");
  if (parsedSkills) {
    values.skills = parsedSkills;
    accepted = true;
  }

  return {
    values,
    rationale:
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 500)
        : undefined,
    warnings,
    accepted,
  };
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.round(parsed * 100) / 100));
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "schedule";
}

interface PolicyFacts {
  pack: string;
  workflows: Array<{
    id: string;
    file: string;
    stages: Array<{
      id: string;
      type: string;
      agent?: string;
      approval: unknown;
    }>;
  }>;
}

async function composeApprovalPolicy(
  intent: string,
  facts: PolicyFacts,
  env: Record<string, string | undefined>,
): Promise<ComposeResult> {
  const fallback = defaultPolicy(facts);
  const warnings: string[] = [];
  let policies = fallback;
  let rationale =
    "发布/交付阶段保留人工确认；构建阶段按成本自动放行；只读阶段无需审批。";
  let model: ComposeResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You design human approval gates for a private agent team.
Return JSON only:
{"policies":[{"file":"<workflow file>","stageId":"<stage id>","approval":null|{"mode":"required|auto|never","position":"before|after","riskClass":"low|medium|high","ttl":"72h","autoApproveWhen":{"maxRunCostCny":0.5}},"reason":"<one sentence>"}],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- publication/delivery/deploy stages MUST keep a human gate: mode required, position before, riskClass high.
- builder/coder stages may use auto with a cost cap; never auto-approve high risk.
- research/read-only stages should not pause.
- ttl must look like 1h, 24h, 72h.
- cover every stage exactly once; do not invent stages.`,
      input: JSON.stringify({ intent, ...facts }),
    });
    const parsed = parseJson(response.text);
    if (parsed) {
      const validated = validatePolicy(parsed, facts, fallback);
      if (validated) {
        policies = validated.policies;
        rationale = validated.rationale ?? rationale;
        warnings.push(...validated.warnings);
        model = "live";
      }
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用安全默认策略。");
  }

  return {
    kind: "approvalPolicy",
    values: { policies },
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

function defaultPolicy(facts: PolicyFacts): PolicyRow[] {
  const rows: PolicyRow[] = [];
  for (const workflow of facts.workflows) {
    for (const stage of workflow.stages) {
      const text =
        `${stage.id} ${stage.type} ${stage.agent ?? ""}`.toLowerCase();
      const base = {
        file: workflow.file,
        stageId: stage.id,
        stageType: stage.type,
        ...(stage.agent ? { agent: stage.agent } : {}),
      };
      if (isDeliveryStage(stage)) {
        rows.push({
          ...base,
          approval: {
            mode: "required",
            position: "before",
            riskClass: "high",
            ttl: "72h",
          },
          reason: "发布/交付阶段必须人工确认",
        });
      } else if (
        stage.type === "coder" ||
        /builder|patcher|frontend-builder|开发|构建/.test(text)
      ) {
        rows.push({
          ...base,
          approval: {
            mode: "auto",
            position: "after",
            riskClass: "medium",
            ttl: "72h",
            autoApproveWhen: { maxRunCostCny: 0.5 },
          },
          reason: "构建阶段按成本自动放行",
        });
      } else {
        rows.push({
          ...base,
          approval: null,
          reason: "只读/研究阶段无需暂停",
        });
      }
    }
  }
  return rows;
}

function validatePolicy(
  parsed: Record<string, unknown>,
  facts: PolicyFacts,
  fallback: PolicyRow[],
): { policies: PolicyRow[]; rationale?: string; warnings: string[] } | null {
  if (!Array.isArray(parsed.policies)) {
    return null;
  }
  const byKey = new Map(fallback.map((row) => [policyKey(row), row]));
  for (const item of parsed.policies) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.file !== "string" || typeof record.stageId !== "string") {
      continue;
    }
    const key = `${record.file}:${record.stageId}`;
    const current = byKey.get(key);
    if (!current) {
      continue;
    }
    const stage = findStage(facts, record.file, record.stageId);
    const approval = parseApproval(
      record.approval,
      stage
        ? {
            id: stage.id,
            type: stage.type,
            ...(stage.agent ? { agent: stage.agent } : {}),
          }
        : null,
    );
    if (approval === undefined) {
      continue;
    }
    byKey.set(key, {
      ...current,
      approval,
      reason:
        typeof record.reason === "string" && record.reason.trim()
          ? record.reason.trim().slice(0, 300)
          : current.reason,
    });
  }
  return {
    policies: fallback.map((row) => byKey.get(policyKey(row)) ?? row),
    rationale:
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 500)
        : undefined,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.slice(0, 300))
          .slice(0, 5)
      : [],
  };
}

function parseApproval(
  value: unknown,
  stage: { id: string; type: string; agent?: string } | null,
): ApprovalValue | null | undefined {
  if (value === null) {
    return isDeliveryStage(stage ?? { id: "", type: "" })
      ? {
          mode: "required",
          position: "before",
          riskClass: "high",
          ttl: "72h",
        }
      : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode =
    record.mode === "required" ||
    record.mode === "auto" ||
    record.mode === "never"
      ? record.mode
      : "required";
  const position =
    record.position === "before" || record.position === "after"
      ? record.position
      : "after";
  const riskClass =
    record.riskClass === "low" ||
    record.riskClass === "medium" ||
    record.riskClass === "high"
      ? record.riskClass
      : "medium";
  const ttl =
    typeof record.ttl === "string" && /^\d+(h|m|d)$/.test(record.ttl)
      ? record.ttl
      : "72h";
  const maxCost =
    record.autoApproveWhen &&
    typeof record.autoApproveWhen === "object" &&
    !Array.isArray(record.autoApproveWhen) &&
    typeof (record.autoApproveWhen as Record<string, unknown>).maxRunCostCny ===
      "number"
      ? Number(
          (record.autoApproveWhen as Record<string, unknown>).maxRunCostCny,
        )
      : undefined;

  if (stage && isDeliveryStage(stage)) {
    return {
      mode: "required",
      position: "before",
      riskClass: "high",
      ttl,
    };
  }
  return {
    mode,
    position,
    riskClass,
    ttl,
    ...(mode === "auto" && maxCost !== undefined && maxCost >= 0
      ? { autoApproveWhen: { maxRunCostCny: maxCost } }
      : {}),
  };
}

function findStage(
  facts: PolicyFacts,
  file: string,
  stageId: string,
): { id: string; type: string; agent?: string } | null {
  const workflow = facts.workflows.find((item) => item.file === file);
  return workflow?.stages.find((stage) => stage.id === stageId) ?? null;
}

function isDeliveryStage(stage: {
  id: string;
  type: string;
  agent?: string;
}): boolean {
  return /(deliver|publish|deploy|release|发布|交付)/i.test(
    `${stage.id} ${stage.type} ${stage.agent ?? ""}`,
  );
}

function policyKey(row: PolicyRow): string {
  return `${row.file}:${row.stageId}`;
}

function defaultMission(facts: PackFacts): MissionValues {
  const plan = rolePlanForAgents(
    new Map(facts.agents.map((agent) => [agent.id, { role: agent.role }])),
    facts.roleRules.allowCombined,
  );
  return {
    workflow: facts.workflows[0]?.id ?? "",
    manager: "manager",
    sellers: plan.sellers,
    builders: plan.builders,
    specialists: plan.specialists,
    acceptance: DEFAULT_ACCEPTANCE,
  };
}

function validateMission(
  parsed: Record<string, unknown>,
  facts: PackFacts,
): { values: MissionValues; rationale?: string; warnings: string[] } | null {
  const workflow =
    typeof parsed.workflow === "string" &&
    facts.workflows.some((item) => item.id === parsed.workflow)
      ? parsed.workflow
      : null;
  if (!workflow) {
    return null;
  }
  const allowCombined = facts.roleRules.allowCombined;
  const byId = new Map(facts.agents.map((agent) => [agent.id, agent]));
  const managerId =
    typeof parsed.manager === "string" &&
    (parsed.manager === "manager" ||
      byId.get(parsed.manager)?.role === "manager")
      ? parsed.manager
      : "manager";
  const sellers = filterIds(parsed.sellers, byId, allowCombined, "seller");
  const builders = filterIds(parsed.builders, byId, allowCombined, "builder");
  const specialists = filterIds(parsed.specialists, byId, false, "specialist");
  const errors = validateRolePlan({
    agents: new Map(
      facts.agents.map((agent) => [agent.id, { role: agent.role }]),
    ),
    rules: facts.roleRules,
    sellers,
    builders,
    specialists,
    allowCombined,
  });
  if (errors.length > 0) {
    return null;
  }
  return {
    values: {
      workflow,
      manager: managerId,
      sellers,
      builders,
      specialists,
      acceptance:
        typeof parsed.acceptance === "string" && parsed.acceptance.trim()
          ? parsed.acceptance.trim().slice(0, 2000)
          : DEFAULT_ACCEPTANCE,
    },
    rationale:
      typeof parsed.rationale === "string" && parsed.rationale.trim()
        ? parsed.rationale.trim().slice(0, 500)
        : undefined,
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.slice(0, 300))
          .slice(0, 5)
      : [],
  };
}

function filterIds(
  value: unknown,
  byId: Map<string, { id: string; role: AgentRole }>,
  allowCombined: boolean,
  role: "seller" | "builder" | "specialist",
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.filter((item): item is string => typeof item === "string");
  return [
    ...new Set(
      ids.filter((id) => {
        const agent = byId.get(id);
        if (!agent || agent.role === "manager") {
          return false;
        }
        if (agent.role === role) {
          return true;
        }
        return allowCombined && role !== "specialist";
      }),
    ),
  ];
}

function parseJson(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolvePackDir(repoRoot: string, packId: string): string {
  const trimmed = packId.trim();
  if (!trimmed) {
    throw new JobError("pack_required", "packDir is required");
  }
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : trimmed.replace(/\\/g, "/").startsWith("packs/")
      ? path.resolve(repoRoot, trimmed)
      : path.resolve(repoRoot, "packs", trimmed);
  const packsRoot = path.resolve(repoRoot, "packs");
  const prefix = packsRoot.endsWith(path.sep)
    ? packsRoot
    : `${packsRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new JobError("pack_outside_root", "packDir must be inside packs/");
  }
  return resolved;
}
