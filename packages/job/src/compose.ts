import path from "node:path";
import type { AgentRole } from "@kit/core";
import { createModelGateway, loadModelConfig } from "@kit/model";
import { loadPack, rolePlanForAgents, validateRolePlan } from "@kit/pack";
import { JobError } from "./types";

export type ComposeKind = "mission" | "packRun" | "approvalPolicy";

export interface ComposeInput {
  kind: ComposeKind;
  intent: string;
  packDir: string;
  repoRoot: string;
  env?: Record<string, string | undefined>;
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

export interface ComposeResult {
  kind: ComposeKind;
  values: MissionValues | PackRunValues | ApprovalPolicyValues;
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
