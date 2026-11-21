import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentRole,
  type ComponentKind,
  type PipelineSpec,
  type WorkflowDefinition,
  agentRoleSchema,
  pipelineSpecSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import { createModelGateway, loadModelConfig } from "@kit/model";
import {
  type ComponentLibrary,
  type DraftStage,
  type LoadResult,
  type LoadedPack,
  assembleComponents,
  inferAgentRole,
  loadPack,
  packCatalog,
  simulatePack,
  splitFrontmatter,
  validateStageGraph,
} from "@kit/pack";
import { parse, stringify } from "yaml";
import { JobError } from "./types";

/**
 * Asset self-manufacture (issue #132, plan 98 §3.4 / §6 I-6, 88 M3b, 94 C-6c).
 *
 * Flow: draft → schema/permission validation → dry-run (validate / simulate /
 * preview) → accept or roll back.
 *
 * Guardrails:
 *   - The model only proposes. Every draft is re-validated against the real
 *     pack (agents, catalogs, graphs, component library) before it is shown.
 *   - Dry-run executes in a throwaway copy of the pack, so it can never write
 *     to the live pack.
 *   - Accept stages writes and validates the whole pack; any failure restores
 *     every touched file, so no half-written asset survives.
 *   - Accepted assets are pinned in `manufacture.lock.json` (version plus
 *     content-addressed provenance) and appended to the audit log.
 *   - Expanding permissions or changing tools/network requires explicit
 *     operator approval; missing components and overreach are rejected and
 *     labelled with structured issues.
 */

export const MANUFACTURE_LOCK_FILE = "manufacture.lock.json";
const MANUFACTURE_DIR = ".manufacture";
const PROPOSALS_DIR = path.join(MANUFACTURE_DIR, "proposals");
const BACKUPS_DIR = path.join(MANUFACTURE_DIR, "backups");
const AUDIT_FILE = path.join(MANUFACTURE_DIR, "audit.jsonl");

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;
const DEFAULT_AGENT_MODEL = "deepseek-flash";
const DEFAULT_MANAGER_MODEL = "deepseek-pro";

type LoadedPackOk = Extract<LoadResult, { ok: true }>;
type WorkflowStage = WorkflowDefinition["stages"][number];

export type ManufactureAssetKind =
  | "agent"
  | "manager"
  | "workflow"
  | "pipeline"
  | "component";

export const MANUFACTURE_KINDS: readonly ManufactureAssetKind[] = [
  "agent",
  "manager",
  "workflow",
  "pipeline",
  "component",
];

export type ManufactureStatus =
  | "draft"
  | "validated"
  | "dry-run"
  | "accepted"
  | "rolled-back"
  | "rejected";

export type ManufactureRiskLevel = "low" | "medium" | "high";

export interface ManufactureIssue {
  code: string;
  /** Pack-relative path or logical field (e.g. `agents/reviewer.md`). */
  path: string;
  message: string;
}

export interface ManufactureAgentDraft {
  type: "agent" | "manager";
  id: string;
  create: boolean;
  description: string;
  model: string;
  role: AgentRole;
  instructions: string;
  tools: string[];
  skills: string[];
  permissions: { filesystem: string; network: string };
}

export interface ManufactureWorkflowDraft {
  type: "workflow";
  id: string;
  version: string;
  stages: DraftStage[];
}

export interface ManufacturePipelineDraft {
  type: "pipeline";
  id: string;
  spec: PipelineSpec;
}

export interface ManufactureComponentRequest {
  kind: ComponentKind;
  id: string;
}

export interface ManufactureComponentDraft {
  type: "component";
  components: ManufactureComponentRequest[];
  allowCommand: boolean;
}

export type ManufactureDraft =
  | ManufactureAgentDraft
  | ManufactureWorkflowDraft
  | ManufacturePipelineDraft
  | ManufactureComponentDraft;

export interface ManufactureRisk {
  level: ManufactureRiskLevel;
  /** True when accept must carry explicit operator approval. */
  requiresApproval: boolean;
  reasons: string[];
}

export interface ManufacturePreviewFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManufactureDryRunStep {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ManufactureDryRun {
  ok: boolean;
  ranAt: string;
  steps: ManufactureDryRunStep[];
  preview: ManufacturePreviewFile[];
  warnings: string[];
  simulation: {
    workflows: Array<{
      id: string;
      stages: number;
      totalCostCny: number;
      budgetWarning?: string;
    }>;
    warnings: string[];
  } | null;
}

export interface ManufactureProvenance {
  version: string;
  source: {
    repo: string;
    commit: string;
    ref?: string;
    sha256: string;
  };
}

export interface ManufactureAcceptance {
  at: string;
  actor: string;
  files: string[];
  provenance: ManufactureProvenance;
}

export interface ManufactureProposal {
  id: string;
  kind: ManufactureAssetKind;
  intent: string;
  assetId: string;
  status: ManufactureStatus;
  createdAt: string;
  updatedAt: string;
  model: "live" | "heuristic";
  draft: ManufactureDraft;
  rationale: string;
  warnings: string[];
  issues: ManufactureIssue[];
  risk: ManufactureRisk;
  dryRun: ManufactureDryRun | null;
  acceptance: ManufactureAcceptance | null;
  rolledBackAt?: string;
}

export interface ManufactureLockEntry {
  kind: ManufactureAssetKind;
  id: string;
  version: string;
  proposalId: string;
  acceptedAt: string;
  source: ManufactureProvenance["source"];
}

export interface ManufactureLock {
  apiVersion: "agentteam/v1";
  kind: "ManufactureLock";
  lockVersion: 1;
  pack?: { id?: string };
  assets: ManufactureLockEntry[];
  generatedAt: string;
}

export interface ManufactureDraftInput {
  kind: ManufactureAssetKind;
  intent: string;
  packDir: string;
  env?: Record<string, string | undefined>;
  /** Operator-chosen object id (D-64 first screen: object + one sentence). */
  assetId?: string;
  /** Existing agent being edited; empty for a brand-new asset. */
  agentId?: string;
  /** Components the operator picked for a `component` proposal. */
  componentIds?: ManufactureComponentRequest[];
  /** Library inventory, so drafts and validation can reject missing items. */
  availableComponents?: ManufactureComponentRequest[];
  allowCommand?: boolean;
  /**
   * Operator edits applied before validation (D-64 edit step). Only the
   * agent/manager scalar and list fields are honoured; validation still runs
   * against the real catalog afterwards.
   */
  agentFields?: Partial<
    Pick<
      ManufactureAgentDraft,
      | "description"
      | "model"
      | "role"
      | "instructions"
      | "tools"
      | "skills"
      | "permissions"
    >
  >;
}

export interface ManufactureDeps {
  /** Production adapter: `workshopComponentLibrary(root)` from @kit/workshop. */
  library?: ComponentLibrary;
}

/**
 * `ManufactureAgentDraft.type` is a union ("agent" | "manager"), so a plain
 * `draft.type === "agent" || ...` check leaves the member in the residual
 * union (TypeScript only removes a member for unit-typed discriminants). A
 * user-defined guard keeps the later branches correctly narrowed.
 */
function isAgentDraft(draft: ManufactureDraft): draft is ManufactureAgentDraft {
  return draft.type === "agent" || draft.type === "manager";
}

function isComponentDraft(
  draft: ManufactureDraft,
): draft is ManufactureComponentDraft {
  return draft.type === "component";
}

export class ManufactureError extends JobError {
  readonly issues: ManufactureIssue[];

  constructor(
    code: string,
    message: string,
    status = 400,
    issues: ManufactureIssue[] = [],
  ) {
    super(code, message, status);
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ */
/* Drafting                                                            */
/* ------------------------------------------------------------------ */

export async function draftManufacture(
  input: ManufactureDraftInput,
): Promise<ManufactureProposal> {
  const intent = input.intent.trim();
  if (!intent) {
    throw new ManufactureError(
      "intent_required",
      "a one-line intent is required",
    );
  }
  if (!MANUFACTURE_KINDS.includes(input.kind)) {
    throw new ManufactureError(
      "unknown_kind",
      `unknown manufacture kind: ${String(input.kind)}`,
    );
  }
  const packDir = path.resolve(input.packDir);
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new ManufactureError(
      "invalid_pack",
      `invalid pack: ${loaded.errors.join("; ")}`,
    );
  }

  const env = input.env ?? process.env;
  const result =
    input.kind === "agent" || input.kind === "manager"
      ? await draftAgent(input, loaded, env)
      : input.kind === "workflow"
        ? await draftWorkflow(input, loaded, env)
        : input.kind === "pipeline"
          ? await draftPipeline(input, loaded, env)
          : await draftComponent(input, loaded, env);

  applyAgentFields(result.draft, input.agentFields);
  const issues = await validateDraft(packDir, loaded, result.draft);
  if (isComponentDraft(result.draft) && input.availableComponents) {
    issues.push(...missingComponents(result.draft, input.availableComponents));
  }
  const risk = assessRisk(result.draft, loaded);
  const now = new Date().toISOString();
  const proposal: ManufactureProposal = {
    id: randomUUID(),
    kind: input.kind,
    intent,
    assetId: assetIdOf(result.draft),
    status: issues.length === 0 ? "validated" : "rejected",
    createdAt: now,
    updatedAt: now,
    model: result.model,
    draft: result.draft,
    rationale: result.rationale,
    warnings: [...new Set([...result.warnings, ...risk.reasons])],
    issues,
    risk,
    dryRun: null,
    acceptance: null,
  };
  await saveProposal(packDir, proposal);
  await appendAudit(packDir, {
    at: now,
    proposalId: proposal.id,
    kind: proposal.kind,
    assetId: proposal.assetId,
    action: issues.length === 0 ? "validated" : "rejected",
    status: proposal.status,
    model: proposal.model,
    risk: proposal.risk,
    issues,
  });
  return proposal;
}

interface DraftResult<T extends ManufactureDraft = ManufactureDraft> {
  draft: T;
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

async function draftAgent(
  input: ManufactureDraftInput,
  loaded: LoadedPackOk,
  env: Record<string, string | undefined>,
): Promise<DraftResult<ManufactureAgentDraft>> {
  const catalog = await packCatalog(loaded.dir);
  const isManager = input.kind === "manager";
  const requestedId = (input.assetId ?? input.agentId ?? "").trim();
  const existingManagerFile = loaded.pack.manager?.agent;
  const managerAgent = existingManagerFile
    ? [...loaded.agents.entries()].find(
        ([, entry]) => entry.spec.file === existingManagerFile,
      )
    : undefined;
  const existingId = isManager
    ? (managerAgent?.[0] ?? "manager")
    : input.agentId && loaded.agents.has(input.agentId)
      ? input.agentId
      : null;
  const existing = existingId ? loaded.agents.get(existingId) : undefined;
  const id =
    existingId ?? (isManager ? "manager" : requestedId || slugId(input.intent));
  const create = existing === undefined;
  const existingText = existing
    ? await readFile(path.join(loaded.dir, existing.spec.file), "utf8").catch(
        () => "",
      )
    : "";
  const existingBody = existingText ? splitFrontmatter(existingText).body : "";

  const fallback: ManufactureAgentDraft = {
    type: isManager ? "manager" : "agent",
    id,
    create,
    description:
      existing?.frontmatter.description ||
      firstSentence(input.intent, 200) ||
      `${id} agent`,
    model:
      existing?.frontmatter.model ||
      (isManager ? DEFAULT_MANAGER_MODEL : DEFAULT_AGENT_MODEL),
    role: isManager
      ? "manager"
      : (existing?.role ?? inferAgentRole(id, input.intent, false)),
    instructions:
      existingBody ||
      `You are ${id}. ${firstSentence(input.intent, 400)} Return a concise, verifiable result.`,
    tools: [...(existing?.frontmatter.tools ?? [])].filter((tool) =>
      catalog.tools.some((entry) => entry.name === tool),
    ),
    skills: [...(existing?.frontmatter.skills ?? [])].filter((skill) =>
      catalog.skills.includes(skill),
    ),
    permissions: {
      filesystem: existing?.frontmatter.permissions?.filesystem ?? "readonly",
      network: existing?.frontmatter.permissions?.network ?? "none",
    },
  };

  const warnings: string[] = [
    create
      ? "新成员将由这次提案创建；采纳前不会写入任何文件。"
      : "将更新现有成员的字段；采纳前不会写入任何文件。",
  ];
  let draft = fallback;
  let rationale = create
    ? "按 id 与意图推断职责，生成可编辑的成员草稿。"
    : "在现有成员字段的基础上补全草稿，工具与技能只保留 Pack 目录中存在的项。";
  let model: DraftResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You draft ONE teammate for a private agent team.
Return JSON only:
{"description":"<one sentence>","model":"<model id>","role":"builder|seller|specialist${isManager ? "|manager" : ""}","instructions":"<role prompt in Markdown>","tools":["<tool name>"],"skills":["<skill name>"],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- tools and skills MUST come from the provided catalogs; never invent them.
- only use role "manager" when isManager is true.
- prefer the smallest tool set that satisfies the intent.
- keep the description under 200 characters; do not invent facts.`,
      input: JSON.stringify({
        intent: input.intent,
        pack: loaded.pack.metadata.name,
        isManager,
        current: fallback,
        roles: [
          "builder",
          "seller",
          "specialist",
          ...(isManager ? ["manager"] : []),
        ],
        models: Object.keys(loadModelConfig(env).aliases),
        tools: catalog.tools.map((tool) => tool.name),
        skills: catalog.skills,
      }),
    });
    const parsed = parseJsonObject(response.text);
    if (parsed) {
      const accepted: ManufactureAgentDraft = {
        ...fallback,
        tools: [...fallback.tools],
        skills: [...fallback.skills],
      };
      let changed = false;
      if (typeof parsed.description === "string" && parsed.description.trim()) {
        accepted.description = parsed.description.trim().slice(0, 300);
        changed = true;
      }
      if (
        typeof parsed.instructions === "string" &&
        parsed.instructions.trim()
      ) {
        accepted.instructions = parsed.instructions.trim().slice(0, 8000);
        changed = true;
      }
      if (typeof parsed.model === "string" && parsed.model.trim()) {
        accepted.model = parsed.model.trim().slice(0, 120);
        changed = true;
      }
      if (typeof parsed.role === "string") {
        const role = agentRoleSchema.safeParse(parsed.role);
        if (role.success) {
          if (isManager && role.data !== "manager") {
            warnings.push("经理职责不能被改为其他角色，已保持 manager。");
          } else if (!isManager && role.data === "manager") {
            warnings.push("非经理成员不能使用 manager 职责，已保持默认角色。");
          } else {
            accepted.role = role.data;
            changed = true;
          }
        }
      }
      const toolsProvided = Array.isArray(parsed.tools);
      const skillsProvided = Array.isArray(parsed.skills);
      accepted.tools = parseCatalogList(
        parsed.tools,
        catalog.tools.map((tool) => tool.name),
        "工具",
        warnings,
        accepted.tools,
      );
      accepted.skills = parseCatalogList(
        parsed.skills,
        catalog.skills,
        "技能",
        warnings,
        accepted.skills,
      );
      if (changed || toolsProvided || skillsProvided) {
        draft = accepted;
        rationale =
          typeof parsed.rationale === "string" && parsed.rationale.trim()
            ? parsed.rationale.trim().slice(0, 500)
            : rationale;
        model = "live";
      }
    } else {
      warnings.push("AI 草稿无法解析，已使用启发式草稿。");
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用启发式草稿。");
  }

  return { draft, rationale, warnings, model };
}

async function draftWorkflow(
  input: ManufactureDraftInput,
  loaded: LoadedPackOk,
  env: Record<string, string | undefined>,
): Promise<DraftResult<ManufactureWorkflowDraft>> {
  const catalog = await packCatalog(loaded.dir);
  const agents = [...loaded.agents.entries()].map(([id, agent]) => ({
    id,
    role: agent.role,
    model: agent.frontmatter.model,
    tools: agent.frontmatter.tools,
  }));
  const usedIds = new Set(loaded.workflows.map((workflow) => workflow.id));
  const id = uniqueId(input.assetId || slugId(input.intent), usedIds);
  const first =
    agents.find((agent) => agent.role !== "manager") ?? agents[0] ?? null;

  const fallbackStages: DraftStage[] = first
    ? [
        {
          id: slugId(first.id),
          type: "agent",
          agent: first.id,
          goal: firstSentence(input.intent, 300),
          inputs: ["task"],
          outputs: [`${slugId(first.id)}_output`],
          timeout: "15m",
          retry: { max: 1, backoff: "fixed" },
          depends: [],
        },
      ]
    : [];
  const warnings: string[] = [];
  if (!first) {
    warnings.push("Pack 里没有可用成员，无法生成工作流草稿。");
  }
  let stages = fallbackStages;
  let rationale = "按 Pack 的首个非经理成员生成线性单阶段草稿。";
  let model: DraftResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You draft a NEW workflow for a private agent team.
Return JSON only:
{"stages":[{"id":"<slug>","type":"agent|coder","agent":"<agent id>","goal":"<one sentence>","acceptance":"<checkable criterion>","inputs":["<artifact>"],"outputs":["<artifact>"],"timeout":"15m","depends":["<earlier stage id>"],"gate":"<optional eval file>"}],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- ids are slugs matching ^[a-z][a-z0-9-]*$ and unique.
- exactly one entry stage has an empty depends list; every depends entry must be an earlier stage id; keep the graph acyclic.
- agent stages must bind a provided agent id; never invent agents, gates or tools.
- keep 1 to 4 stages; inputs/outputs name the artifacts passed between stages.
- do not invent facts.`,
      input: JSON.stringify({
        intent: input.intent,
        pack: loaded.pack.metadata.name,
        agents,
        tools: catalog.tools.map((tool) => tool.name),
      }),
    });
    const parsed = parseJsonObject(response.text);
    if (parsed) {
      const candidate = parseDraftStages(parsed.stages);
      if (candidate) {
        const graph = validateStageGraph(
          candidate,
          agents.map((agent) => agent.id),
        );
        if (graph.ok) {
          stages = candidate;
          rationale =
            typeof parsed.rationale === "string" && parsed.rationale.trim()
              ? parsed.rationale.trim().slice(0, 500)
              : rationale;
          if (Array.isArray(parsed.warnings)) {
            warnings.push(...stringList(parsed.warnings, 5));
          }
          model = "live";
        } else {
          warnings.push(...graph.errors.slice(0, 5));
          warnings.push("AI 阶段图未通过校验，已使用默认阶段图。");
        }
      } else {
        warnings.push("AI 阶段图缺少有效的 stages 数组，已使用默认阶段图。");
      }
    } else {
      warnings.push("AI 草稿无法解析，已使用默认阶段图。");
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用默认阶段图。");
  }

  // Gate references must point at an eval file that actually exists.
  for (const stage of stages) {
    if (stage.gate && !evalFileExists(loaded.dir, stage.gate)) {
      Reflect.deleteProperty(stage, "gate");
      warnings.push(`阶段 ${stage.id} 的 gate 不在 Pack 评测中，已移除。`);
    }
  }

  return {
    draft: { type: "workflow", id, version: "1.0", stages },
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

async function draftPipeline(
  input: ManufactureDraftInput,
  loaded: LoadedPackOk,
  env: Record<string, string | undefined>,
): Promise<DraftResult<ManufacturePipelineDraft>> {
  const agents = [...loaded.agents.entries()].map(([id, agent]) => ({
    id,
    role: agent.role,
  }));
  const pool = agents.filter((agent) => agent.role !== "manager");
  const usedIds = new Set(loaded.workflows.map((workflow) => workflow.id));
  const id = uniqueId(input.assetId || slugId(input.intent), usedIds);
  const warnings: string[] = [];
  if (pool.length === 0) {
    warnings.push("Pack 里没有可用成员，无法生成流水线草稿。");
  }
  const chosen = pool.slice(0, Math.min(3, pool.length));
  let graph = chainPipeline(
    chosen.map((agent, index) => ({
      id: slugId(agent.id),
      goal: index === 0 ? firstSentence(input.intent, 200) : "",
    })),
  );
  let rationale =
    "按 Pack 成员的声明顺序装配一条线性流水线；组件绑定留给后续编辑。";
  let model: DraftResult["model"] = "heuristic";

  try {
    const gateway = createModelGateway(loadModelConfig(env));
    const response = await gateway.complete({
      model: "deepseek-flash",
      instructions: `You design a NEW pipeline for a private agent team.
Return JSON only:
{"nodes":[{"id":"<slug>","agent":"<agent id>","goal":"<one sentence>"}],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- 1 to 4 nodes; ids are slugs matching ^[a-z][a-z0-9-]*$ and unique.
- agent MUST be one of the provided non-manager agent ids; never invent agents.
- nodes run in the given order; do not invent tools, components or facts.`,
      input: JSON.stringify({
        intent: input.intent,
        agents: pool,
      }),
    });
    const parsed = parseJsonObject(response.text);
    if (parsed && Array.isArray(parsed.nodes)) {
      const picked: Array<{ id: string; agent: string; goal: string }> = [];
      const seen = new Set<string>();
      for (const raw of parsed.nodes.slice(0, 4)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          continue;
        }
        const record = raw as Record<string, unknown>;
        const agentId =
          typeof record.agent === "string" &&
          pool.some((agent) => agent.id === record.agent)
            ? record.agent
            : null;
        if (!agentId) {
          continue;
        }
        let nodeId =
          typeof record.id === "string" && ID_PATTERN.test(record.id)
            ? record.id
            : slugId(agentId);
        if (seen.has(nodeId)) {
          nodeId = `${nodeId}-${picked.length + 1}`;
        }
        seen.add(nodeId);
        picked.push({
          id: nodeId,
          agent: agentId,
          goal:
            typeof record.goal === "string" && record.goal.trim()
              ? record.goal.trim().slice(0, 300)
              : "",
        });
      }
      if (picked.length > 0) {
        graph = chainPipeline(
          picked.map((node) => ({ id: node.id, goal: node.goal })),
        );
        rationale =
          typeof parsed.rationale === "string" && parsed.rationale.trim()
            ? parsed.rationale.trim().slice(0, 500)
            : rationale;
        if (Array.isArray(parsed.warnings)) {
          warnings.push(...stringList(parsed.warnings, 5));
        }
        model = "live";
      }
    } else {
      warnings.push("AI 流水线无法解析，已使用线性草稿。");
    }
  } catch {
    warnings.push("AI 草稿不可用，已使用线性草稿。");
  }

  const spec = {
    apiVersion: "agentteam/v1" as const,
    kind: "Pipeline" as const,
    id,
    name: id,
    version: "1.0",
    description: firstSentence(input.intent, 300),
    graph,
    bindings: [],
    policies: [],
  };
  return {
    draft: { type: "pipeline", id, spec },
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

async function draftComponent(
  input: ManufactureDraftInput,
  loaded: LoadedPackOk,
  env: Record<string, string | undefined>,
): Promise<DraftResult<ManufactureComponentDraft>> {
  const available = input.availableComponents ?? [];
  const warnings: string[] = [];
  let picked: ManufactureComponentRequest[] = (input.componentIds ?? [])
    .filter(
      (component) =>
        typeof component.kind === "string" &&
        typeof component.id === "string" &&
        component.id.trim().length > 0,
    )
    .map((component) => ({ kind: component.kind, id: component.id.trim() }));
  let rationale =
    "从本地组件库中选择已校验的组件，交由装配器原子绑定；AI 不会改动组件内容。";
  let model: DraftResult["model"] = "heuristic";

  if (available.length === 0) {
    warnings.push("本地组件库为空；请先安装组件，或在工坊中发布组件。");
  } else if (picked.length === 0) {
    const heuristic = heuristicComponentPick(input.intent, available);
    if (heuristic) {
      picked = [heuristic];
      rationale = `关键词匹配「${heuristic.kind}/${heuristic.id}」，交由装配器绑定。`;
    }
    try {
      const gateway = createModelGateway(loadModelConfig(env));
      const response = await gateway.complete({
        model: "deepseek-flash",
        instructions: `You pick components for a private agent team's pipeline.
Return JSON only:
{"components":[{"kind":"agent|workflow|toolpack|skillpack","id":"<component id>"}],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- every component MUST exist in the provided catalog; never invent components.
- pick at most 3; prefer the smallest set that satisfies the intent.`,
        input: JSON.stringify({
          intent: input.intent,
          pack: loaded.pack.metadata.name,
          available,
        }),
      });
      const parsed = parseJsonObject(response.text);
      if (parsed && Array.isArray(parsed.components)) {
        const catalog = new Set(
          available.map((component) => `${component.kind}/${component.id}`),
        );
        const chosen = parsed.components
          .filter(
            (item): item is { kind: ComponentKind; id: string } =>
              Boolean(item) &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).kind === "string" &&
              typeof (item as Record<string, unknown>).id === "string",
          )
          .slice(0, 3)
          .filter((item) => catalog.has(`${item.kind}/${item.id}`));
        if (chosen.length > 0) {
          picked = chosen.map((item) => ({ kind: item.kind, id: item.id }));
          rationale =
            typeof parsed.rationale === "string" && parsed.rationale.trim()
              ? parsed.rationale.trim().slice(0, 500)
              : rationale;
          if (Array.isArray(parsed.warnings)) {
            warnings.push(...stringList(parsed.warnings, 5));
          }
          model = "live";
        }
      }
    } catch {
      // Deterministic pick below still stands.
    }
  }

  return {
    draft: {
      type: "component",
      components: picked,
      allowCommand: input.allowCommand === true,
    },
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export async function validateDraft(
  packDir: string,
  loaded: LoadedPack,
  draft: ManufactureDraft,
): Promise<ManufactureIssue[]> {
  const issues: ManufactureIssue[] = [];
  if (isAgentDraft(draft)) {
    const catalog = await packCatalog(loaded.dir);
    validateAgentDraft(
      loaded,
      draft,
      issues,
      catalog.tools.map((tool) => tool.name),
      catalog.skills,
    );
  } else if (draft.type === "workflow") {
    await validateWorkflowDraft(packDir, loaded, draft, issues);
  } else if (draft.type === "pipeline") {
    validatePipelineDraft(packDir, draft, issues);
  } else {
    validateComponentDraft(draft, issues);
  }
  return issues;
}

function validateAgentDraft(
  loaded: LoadedPack,
  draft: ManufactureAgentDraft,
  issues: ManufactureIssue[],
  knownTools: string[],
  knownSkills: string[],
): void {
  if (!ID_PATTERN.test(draft.id)) {
    issues.push({
      code: "invalid_id",
      path: "id",
      message: "agent id must match ^[a-z][a-z0-9-]*$",
    });
  }
  if (draft.type === "manager") {
    if (draft.role !== "manager") {
      issues.push({
        code: "manager_role",
        path: "role",
        message: "manager proposals must use the manager role",
      });
    }
  } else if (draft.role === "manager") {
    issues.push({
      code: "manager_role",
      path: "role",
      message: "only a manager proposal can use the manager role",
    });
  }
  if (!agentRoleSchema.safeParse(draft.role).success) {
    issues.push({
      code: "invalid_role",
      path: "role",
      message: `unknown role: ${String(draft.role)}`,
    });
  }
  if (draft.id === "manager" && draft.type !== "manager") {
    issues.push({
      code: "manager_reserved",
      path: "id",
      message: "the id manager is reserved for the manager proposal",
    });
  }
  if (draft.create && loaded.agents.has(draft.id)) {
    issues.push({
      code: "agent_exists",
      path: `agents/${draft.id}.md`,
      message: `agent ${draft.id} already exists`,
    });
  }
  if (!draft.create && !loaded.agents.has(draft.id)) {
    issues.push({
      code: "unknown_agent",
      path: `agents/${draft.id}.md`,
      message: `agent ${draft.id} does not exist`,
    });
  }
  if (!draft.model.trim()) {
    issues.push({
      code: "model_required",
      path: "model",
      message: "a model id is required",
    });
  }
  const permissions = draft.permissions ?? {
    filesystem: "readonly",
    network: "none",
  };
  if (!["none", "readonly", "workspace"].includes(permissions.filesystem)) {
    issues.push({
      code: "invalid_permissions",
      path: "permissions.filesystem",
      message: "filesystem must be none, readonly or workspace",
    });
  }
  if (!["none", "allow"].includes(permissions.network)) {
    issues.push({
      code: "invalid_permissions",
      path: "permissions.network",
      message: "network must be none or allow",
    });
  }
  const tools = new Set(knownTools);
  for (const tool of draft.tools) {
    if (!tools.has(tool)) {
      issues.push({
        code: "unknown_tool",
        path: "tools",
        message: `tool ${tool} is not available in this pack`,
      });
    }
  }
  const skills = new Set(knownSkills);
  for (const skill of draft.skills) {
    if (!skills.has(skill)) {
      issues.push({
        code: "unknown_skill",
        path: "skills",
        message: `skill ${skill} is not available in this pack`,
      });
    }
  }
}

async function validateWorkflowDraft(
  packDir: string,
  loaded: LoadedPack,
  draft: ManufactureWorkflowDraft,
  issues: ManufactureIssue[],
): Promise<void> {
  if (!ID_PATTERN.test(draft.id)) {
    issues.push({
      code: "invalid_id",
      path: "id",
      message: "workflow id must match ^[a-z][a-z0-9-]*$",
    });
  }
  if (loaded.workflows.some((workflow) => workflow.id === draft.id)) {
    issues.push({
      code: "workflow_exists",
      path: `workflows/${draft.id}.yaml`,
      message: `workflow ${draft.id} already exists`,
    });
  }
  if (
    loaded.pack.workflows.includes(`workflows/${draft.id}.yaml`) ||
    existsSync(path.join(packDir, "workflows", `${draft.id}.yaml`))
  ) {
    issues.push({
      code: "workflow_exists",
      path: `workflows/${draft.id}.yaml`,
      message: `workflow file already exists: workflows/${draft.id}.yaml`,
    });
  }
  if (!SEMVER_PATTERN.test(draft.version)) {
    issues.push({
      code: "invalid_version",
      path: "version",
      message: "version must look like 1.0 or 1.0.0",
    });
  }
  const graph = validateStageGraph(draft.stages, [...loaded.agents.keys()]);
  for (const error of graph.errors) {
    issues.push({ code: "invalid_graph", path: "stages", message: error });
  }
  for (const stage of draft.stages) {
    if (stage.gate && !evalFileExists(packDir, stage.gate)) {
      issues.push({
        code: "missing_gate",
        path: `stages/${stage.id}/gate`,
        message: `gate ${stage.gate} is not an eval file in this pack`,
      });
    }
  }
  const workflowDoc = workflowDocFromStages(draft);
  const parsed = workflowDefinitionSchema.safeParse(
    parse(stringify(workflowDoc)),
  );
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "schema_invalid",
        path: `workflows/${draft.id}.yaml:${issue.path.join(".") || "<root>"}`,
        message: issue.message,
      });
    }
  }
}

function validatePipelineDraft(
  packDir: string,
  draft: ManufacturePipelineDraft,
  issues: ManufactureIssue[],
): void {
  if (!ID_PATTERN.test(draft.id)) {
    issues.push({
      code: "invalid_id",
      path: "id",
      message: "pipeline id must match ^[a-z][a-z0-9-]*$",
    });
  }
  if (existsSync(path.join(packDir, "pipelines", `${draft.id}.yaml`))) {
    issues.push({
      code: "pipeline_exists",
      path: `pipelines/${draft.id}.yaml`,
      message: `pipeline file already exists: pipelines/${draft.id}.yaml`,
    });
  }
  const parsed = pipelineSpecSchema.safeParse(draft.spec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        code: "schema_invalid",
        path: `pipelines/${draft.id}.yaml:${issue.path.join(".") || "<root>"}`,
        message: issue.message,
      });
    }
    return;
  }
  if (parsed.data.id !== draft.id) {
    issues.push({
      code: "id_mismatch",
      path: "pipeline.yaml:id",
      message: `pipeline id "${parsed.data.id}" does not match "${draft.id}"`,
    });
  }
  const graph = parsed.data.graph;
  if (graph.nodes.length === 0) {
    issues.push({
      code: "empty_pipeline",
      path: "graph.nodes",
      message: "a pipeline needs at least one node",
    });
    return;
  }
  const incoming = new Set(graph.edges.map((edge) => edge.to));
  const entries = graph.nodes.filter((node) => !incoming.has(node.id));
  if (entries.length !== 1) {
    issues.push({
      code: "multi_entry",
      path: "graph.edges",
      message: `a pipeline must have exactly one entry node (found ${entries.length})`,
    });
  }
}

function validateComponentDraft(
  draft: ManufactureComponentDraft,
  issues: ManufactureIssue[],
): void {
  if (draft.components.length === 0) {
    issues.push({
      code: "no_components",
      path: "components",
      message: "no components were selected or found in the library",
    });
  }
  const seen = new Set<string>();
  for (const component of draft.components) {
    if (!ID_PATTERN.test(component.id)) {
      issues.push({
        code: "invalid_id",
        path: `${component.kind}/${component.id}`,
        message: "component id must be kebab-case",
      });
    }
    const key = `${component.kind}/${component.id}`;
    if (seen.has(key)) {
      issues.push({
        code: "duplicate_component",
        path: key,
        message: `component requested twice: ${key}`,
      });
    }
    seen.add(key);
  }
}

/**
 * Component existence is verified against the supplied inventory and, during
 * dry-run, against the real library. Missing items are labelled rather than
 * silently dropped.
 */
export function missingComponents(
  draft: ManufactureComponentDraft,
  available: ManufactureComponentRequest[],
): ManufactureIssue[] {
  const catalog = new Set(
    available.map((component) => `${component.kind}/${component.id}`),
  );
  return draft.components
    .filter((component) => !catalog.has(`${component.kind}/${component.id}`))
    .map((component) => ({
      code: "missing_component",
      path: `${component.kind}/${component.id}`,
      message: `component ${component.kind}/${component.id} is not in the local library`,
    }));
}

/* ------------------------------------------------------------------ */
/* Risk                                                                */
/* ------------------------------------------------------------------ */

export function assessRisk(
  draft: ManufactureDraft,
  loaded: LoadedPack,
): ManufactureRisk {
  const reasons: string[] = [];
  if (isAgentDraft(draft)) {
    const existing =
      draft.type === "manager"
        ? [...loaded.agents.entries()].find(
            ([, entry]) => entry.spec.file === loaded.pack.manager?.agent,
          )?.[1]
        : loaded.agents.get(draft.id);
    if (draft.type === "manager") {
      reasons.push("经理变更影响全队协调");
    }
    const beforeTools = new Set(existing?.frontmatter.tools ?? []);
    const addedTools = draft.tools.filter((tool) => !beforeTools.has(tool));
    const beforeNetwork = existing?.frontmatter.permissions?.network ?? "none";
    const networkExpanded =
      beforeNetwork === "none" && draft.permissions.network !== "none";
    const beforeFs =
      existing?.frontmatter.permissions?.filesystem ?? "readonly";
    const fsExpanded =
      beforeFs === "readonly" && draft.permissions.filesystem === "workspace";
    if (addedTools.length > 0) {
      reasons.push(`新增工具需要审批：${addedTools.join(", ")}`);
    }
    if (networkExpanded) {
      reasons.push("网络权限从 none 扩大，需要审批");
    }
    if (fsExpanded) {
      reasons.push("文件系统权限扩大到 workspace，需要审批");
    }
    const requiresApproval =
      addedTools.length > 0 || networkExpanded || fsExpanded;
    return {
      level: requiresApproval ? "medium" : "low",
      requiresApproval,
      reasons:
        reasons.length > 0 ? reasons : ["只调整指令或元数据，不扩大权限"],
    };
  }
  if (draft.type === "workflow") {
    reasons.push("新工作流在 dry-run 通过后可采纳；不改变成员权限");
    return { level: "low", requiresApproval: false, reasons };
  }
  if (draft.type === "pipeline") {
    reasons.push("流水线是声明式装配计划；节点需绑定已有组件才能运行");
    return { level: "low", requiresApproval: false, reasons };
  }
  if (draft.allowCommand) {
    reasons.push("装配包含 command 适配器工具，需要显式授权");
    return { level: "high", requiresApproval: true, reasons };
  }
  reasons.push("只装配本地已校验组件；不执行组件代码");
  return { level: "medium", requiresApproval: false, reasons };
}

/* ------------------------------------------------------------------ */
/* Dry-run                                                             */
/* ------------------------------------------------------------------ */

export async function dryRunManufacture(
  packDir: string,
  proposalId: string,
  deps: ManufactureDeps = {},
): Promise<ManufactureProposal> {
  const root = path.resolve(packDir);
  const proposal = await requireProposal(root, proposalId);
  if (proposal.status === "accepted") {
    throw new ManufactureError(
      "already_accepted",
      "this proposal is already accepted; roll it back before re-running",
      409,
    );
  }
  if (proposal.issues.length > 0) {
    throw new ManufactureError(
      "proposal_invalid",
      "the proposal has validation issues; fix the draft first",
      409,
      proposal.issues,
    );
  }
  const dryRun = await runDryRun(root, proposal, deps);
  proposal.dryRun = dryRun;
  proposal.status = dryRun.ok ? "dry-run" : proposal.status;
  proposal.updatedAt = new Date().toISOString();
  await saveProposal(root, proposal);
  await appendAudit(root, {
    at: proposal.updatedAt,
    proposalId: proposal.id,
    kind: proposal.kind,
    assetId: proposal.assetId,
    action: "dry-run",
    status: dryRun.ok ? "dry-run" : "rejected",
    model: proposal.model,
    risk: proposal.risk,
    steps: dryRun.steps,
  });
  return proposal;
}

async function runDryRun(
  root: string,
  proposal: ManufactureProposal,
  deps: ManufactureDeps,
): Promise<ManufactureDryRun> {
  const steps: ManufactureDryRunStep[] = [];
  const warnings: string[] = [];
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "kit-manufacture-"));
  const staging = path.join(stagingRoot, "pack");
  try {
    await cp(root, staging, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(root, source);
        return relative.split(path.sep)[0] !== MANUFACTURE_DIR;
      },
    });

    const loaded = await loadPack(staging);
    if (!loaded.ok) {
      steps.push({
        id: "pack",
        ok: false,
        detail: `staged pack is invalid: ${loaded.errors.join("; ")}`,
      });
      return finishDryRun(steps, warnings, null, []);
    }
    steps.push({ id: "pack", ok: true, detail: "pack loads before apply" });

    let preview: ManufacturePreviewFile[] = [];
    try {
      const applied = await applyDraftToPack(staging, proposal.draft, deps);
      preview = applied.preview;
      steps.push({
        id: "apply",
        ok: true,
        detail: `staged ${applied.files.length} file(s)`,
      });
    } catch (error) {
      steps.push({
        id: "apply",
        ok: false,
        detail: errorMessage(error),
      });
      return finishDryRun(steps, warnings, null, preview);
    }

    const after = await loadPack(staging);
    if (!after.ok) {
      steps.push({
        id: "validate",
        ok: false,
        detail: after.errors.join("; "),
      });
      return finishDryRun(steps, warnings, null, preview);
    }
    warnings.push(...after.warnings);
    steps.push({
      id: "validate",
      ok: true,
      detail: "pack validates after apply",
    });

    const simulation = simulatePack(after);
    warnings.push(...simulation.warnings);
    steps.push({
      id: "simulate",
      ok: true,
      detail: `${simulation.workflows.length} workflow(s) simulated`,
    });
    if (
      proposal.draft.type === "workflow" ||
      proposal.draft.type === "pipeline"
    ) {
      steps.push({
        id: "preview",
        ok: true,
        detail: `${preview.length} file(s) would be written`,
      });
    }
    return finishDryRun(steps, warnings, simulation, preview);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function finishDryRun(
  steps: ManufactureDryRunStep[],
  warnings: string[],
  simulation: ReturnType<typeof simulatePack> | null,
  preview: ManufacturePreviewFile[],
): ManufactureDryRun {
  return {
    ok: steps.length > 0 && steps.every((step) => step.ok),
    ranAt: new Date().toISOString(),
    steps,
    preview,
    warnings: [...new Set(warnings)],
    simulation: simulation
      ? {
          workflows: simulation.workflows.map((workflow) => ({
            id: workflow.id,
            stages: workflow.stages.length,
            totalCostCny: workflow.totalCostCny,
            ...(workflow.budgetWarning
              ? { budgetWarning: workflow.budgetWarning }
              : {}),
          })),
          warnings: simulation.warnings,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* Accept / rollback                                                   */
/* ------------------------------------------------------------------ */

export interface AcceptManufactureInput {
  proposalId: string;
  /** Explicit approval for permission expansion / command tools. */
  approved?: boolean;
  actor?: string;
  note?: string;
}

export async function acceptManufacture(
  packDir: string,
  input: AcceptManufactureInput,
  deps: ManufactureDeps = {},
): Promise<ManufactureProposal> {
  const root = path.resolve(packDir);
  const proposal = await requireProposal(root, input.proposalId);
  if (proposal.status === "accepted") {
    throw new ManufactureError(
      "already_accepted",
      "this proposal is already accepted",
      409,
    );
  }
  if (proposal.issues.length > 0) {
    throw new ManufactureError(
      "proposal_invalid",
      "the proposal has validation issues; it cannot be accepted",
      409,
      proposal.issues,
    );
  }
  if (!proposal.dryRun?.ok) {
    throw new ManufactureError(
      "dry_run_required",
      "run a successful dry-run before accepting",
      409,
    );
  }
  if (proposal.risk.requiresApproval && input.approved !== true) {
    throw new ManufactureError(
      "approval_required",
      "permission expansion or command tools require explicit approval",
      409,
      proposal.risk.reasons.map((message) => ({
        code: "approval_required",
        path: "risk",
        message,
      })),
    );
  }

  const actor = (input.actor ?? "operator").trim() || "operator";
  const note = input.note?.trim() ?? "";
  let backup: BackupRecord | null = null;
  try {
    backup = await snapshotPack(root, proposal, deps);
    const applied = await applyDraftToPack(root, proposal.draft, deps);
    const loaded = await loadPack(root);
    if (!loaded.ok) {
      throw new ManufactureError(
        "pack_invalid",
        `pack failed validation after acceptance: ${loaded.errors.join("; ")}`,
      );
    }

    const provenance = await buildProvenance(root, proposal, applied);
    await upsertLock(root, {
      kind: proposal.kind,
      id: proposal.assetId,
      version: provenance.version,
      proposalId: proposal.id,
      acceptedAt: new Date().toISOString(),
      source: provenance.source,
    });

    proposal.status = "accepted";
    proposal.updatedAt = new Date().toISOString();
    proposal.acceptance = {
      at: proposal.updatedAt,
      actor,
      files: applied.files,
      provenance,
    };
    await saveProposal(root, proposal);
    await writeBackup(root, proposal.id, backup);
    await appendAudit(root, {
      at: proposal.updatedAt,
      proposalId: proposal.id,
      kind: proposal.kind,
      assetId: proposal.assetId,
      action: "accepted",
      status: "accepted",
      model: proposal.model,
      risk: proposal.risk,
      actor,
      note,
      files: applied.files,
      provenance,
    });
    return proposal;
  } catch (error) {
    if (backup) {
      await restoreBackup(root, backup).catch(() => undefined);
    }
    proposal.status = "rolled-back";
    proposal.updatedAt = new Date().toISOString();
    await saveProposal(root, proposal).catch(() => undefined);
    await appendAudit(root, {
      at: proposal.updatedAt,
      proposalId: proposal.id,
      kind: proposal.kind,
      assetId: proposal.assetId,
      action: "rolled-back",
      status: "rolled-back",
      model: proposal.model,
      risk: proposal.risk,
      actor,
      note,
      error: errorMessage(error),
    }).catch(() => undefined);
    if (error instanceof ManufactureError) {
      throw error;
    }
    throw new ManufactureError(
      "accept_failed",
      `acceptance failed and was rolled back: ${errorMessage(error)}`,
    );
  }
}

export async function rollbackManufacture(
  packDir: string,
  proposalId: string,
  options: { actor?: string; note?: string } = {},
): Promise<ManufactureProposal> {
  const root = path.resolve(packDir);
  const proposal = await requireProposal(root, proposalId);
  if (proposal.status !== "accepted") {
    throw new ManufactureError(
      "not_accepted",
      "only an accepted proposal can be rolled back",
      409,
    );
  }
  const backup = await readBackup(root, proposalId);
  if (!backup) {
    throw new ManufactureError(
      "no_backup",
      "no backup was recorded for this acceptance; roll it back from git instead",
      409,
    );
  }
  await restoreBackup(root, backup);
  await removeLockEntry(root, proposalId);
  proposal.status = "rolled-back";
  proposal.rolledBackAt = new Date().toISOString();
  proposal.updatedAt = proposal.rolledBackAt;
  await saveProposal(root, proposal);
  await appendAudit(root, {
    at: proposal.rolledBackAt,
    proposalId: proposal.id,
    kind: proposal.kind,
    assetId: proposal.assetId,
    action: "rolled-back",
    status: "rolled-back",
    model: proposal.model,
    risk: proposal.risk,
    actor: (options.actor ?? "operator").trim() || "operator",
    note: options.note?.trim() ?? "",
  });
  return proposal;
}

interface AppliedDraft {
  files: string[];
  preview: ManufacturePreviewFile[];
  /** Content used for provenance; the first written asset entry. */
  primary: { relative: string; content: string };
}

async function applyDraftToPack(
  packDir: string,
  draft: ManufactureDraft,
  deps: ManufactureDeps,
): Promise<AppliedDraft> {
  if (draft.type === "component") {
    return applyComponentDraft(packDir, draft, deps);
  }

  const teamPath = path.join(packDir, "team.yaml");
  const teamRaw = existsSync(teamPath)
    ? await readFile(teamPath, "utf8")
    : null;
  const writes: Array<{ relative: string; content: string }> = [];
  let nextTeam = teamRaw;

  if (isAgentDraft(draft)) {
    const relative =
      draft.type === "manager"
        ? (loadedManagerFile(teamRaw) ?? `agents/${draft.id}.md`)
        : `agents/${draft.id}.md`;
    writes.push({ relative, content: agentMarkdown(draft) });
    if (teamRaw) {
      nextTeam = upsertAgentInTeam(teamRaw, draft, relative);
    }
  } else if (draft.type === "workflow") {
    const relative = `workflows/${draft.id}.yaml`;
    writes.push({
      relative,
      content: stringify(workflowDocFromStages(draft)),
    });
    if (teamRaw) {
      nextTeam = appendWorkflowToTeam(teamRaw, relative);
    }
  } else {
    writes.push({
      relative: `pipelines/${draft.id}.yaml`,
      content: stringify({ ...draft.spec, id: draft.id }),
    });
  }

  if (nextTeam !== null && nextTeam !== teamRaw) {
    writes.push({ relative: "team.yaml", content: nextTeam });
  }

  const snapshots = await Promise.all(
    writes.map((write) => snapshotFile(packDir, write.relative)),
  );
  try {
    for (const write of writes) {
      await writeFileAtomic(path.join(packDir, write.relative), write.content);
    }
    const loaded = await loadPack(packDir);
    if (!loaded.ok) {
      throw new ManufactureError(
        "pack_invalid",
        `pack failed validation: ${loaded.errors.join("; ")}`,
      );
    }
  } catch (error) {
    await restoreSnapshots(packDir, snapshots);
    throw error;
  }

  const primary = writes[0] ?? {
    relative: "team.yaml",
    content: nextTeam ?? "",
  };
  return {
    files: writes.map((write) => write.relative),
    preview: writes.map((write) => ({
      path: write.relative,
      bytes: Buffer.byteLength(write.content, "utf8"),
      sha256: sha256(write.content),
    })),
    primary,
  };
}

async function applyComponentDraft(
  packDir: string,
  draft: ManufactureComponentDraft,
  deps: ManufactureDeps,
): Promise<AppliedDraft> {
  if (!deps.library) {
    throw new ManufactureError(
      "component_library_unavailable",
      "the component library adapter is not available",
      409,
      draft.components.map((component) => ({
        code: "missing_component",
        path: `${component.kind}/${component.id}`,
        message: "cannot resolve components without the local library",
      })),
    );
  }

  const planned: string[] = ["team.yaml", "components.lock.json"];
  for (const request of draft.components) {
    const resolved = await deps.library.resolve(request.kind, request.id);
    if (!resolved.ok) {
      throw new ManufactureError(
        "missing_component",
        `component ${request.kind}/${request.id} cannot be resolved`,
        409,
        resolved.issues.map((issue) => ({
          code: "missing_component",
          path: `${request.kind}/${request.id}/${issue.path}`,
          message: issue.message,
        })),
      );
    }
    const component = resolved.component;
    if (component.kind === "agent") {
      planned.push(`agents/${component.id}.md`);
    } else if (component.kind === "workflow") {
      planned.push(`workflows/${component.id}.yaml`);
    } else if (component.kind === "toolpack") {
      planned.push(`toolpacks/${component.id}.yaml`);
    } else {
      planned.push(`skillpacks/${component.id}/skillpack.yaml`);
      for (const file of component.files) {
        planned.push(`skillpacks/${component.id}/${file.path}`);
      }
    }
  }

  const snapshots = await Promise.all(
    [...new Set(planned)].map((relative) => snapshotFile(packDir, relative)),
  );
  try {
    const result = await assembleComponents(
      {
        packDir,
        components: draft.components.map((component) => ({
          kind: component.kind,
          id: component.id,
        })),
        allowCommand: draft.allowCommand,
      },
      deps.library,
    );
    const loaded = await loadPack(packDir);
    if (!loaded.ok) {
      throw new ManufactureError(
        "pack_invalid",
        `pack failed validation after assembly: ${loaded.errors.join("; ")}`,
      );
    }
    const primaryRelative =
      planned.find(
        (relative) =>
          /^(agents|workflows|toolpacks|skillpacks)\//.test(relative) &&
          existsSync(path.join(packDir, relative)),
      ) ?? "components.lock.json";
    const primaryContent = await readFile(
      path.join(packDir, primaryRelative),
      "utf8",
    ).catch(() => "");
    const preview = await Promise.all(
      [...new Set([...planned, ...result.written])].map(async (relative) => {
        const content = await readFile(
          path.join(packDir, relative),
          "utf8",
        ).catch(() => "");
        return {
          path: relative,
          bytes: Buffer.byteLength(content, "utf8"),
          sha256: sha256(content),
        };
      }),
    );
    return {
      files: [
        ...new Set([...result.written, "team.yaml", "components.lock.json"]),
      ],
      preview,
      primary: { relative: primaryRelative, content: primaryContent },
    };
  } catch (error) {
    await restoreSnapshots(packDir, snapshots);
    if (error instanceof ManufactureError) {
      throw error;
    }
    throw new ManufactureError(
      "assembly_failed",
      `assembly failed and was rolled back: ${errorMessage(error)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Proposals, lockfile and audit                                       */
/* ------------------------------------------------------------------ */

export async function listManufactureProposals(
  packDir: string,
): Promise<ManufactureProposal[]> {
  const dir = path.join(path.resolve(packDir), PROPOSALS_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const proposals: ManufactureProposal[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        await readFile(path.join(dir, entry.name), "utf8"),
      ) as ManufactureProposal;
      if (typeof parsed.id === "string") {
        proposals.push(parsed);
      }
    } catch {
      // A corrupt proposal stays on disk but is skipped by the console.
    }
  }
  return proposals.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function loadManufactureProposal(
  packDir: string,
  proposalId: string,
): Promise<ManufactureProposal | null> {
  const file = proposalPath(packDir, proposalId);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as ManufactureProposal;
  } catch {
    return null;
  }
}

export async function readManufactureLock(
  packDir: string,
): Promise<ManufactureLock> {
  const file = path.join(path.resolve(packDir), MANUFACTURE_LOCK_FILE);
  if (!existsSync(file)) {
    return emptyLock();
  }
  try {
    const parsed = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<ManufactureLock>;
    return {
      apiVersion: "agentteam/v1",
      kind: "ManufactureLock",
      lockVersion: 1,
      ...(parsed.pack ? { pack: parsed.pack } : {}),
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
      generatedAt:
        typeof parsed.generatedAt === "string"
          ? parsed.generatedAt
          : new Date().toISOString(),
    };
  } catch {
    return emptyLock();
  }
}

async function requireProposal(
  packDir: string,
  proposalId: string,
): Promise<ManufactureProposal> {
  const proposal = await loadManufactureProposal(packDir, proposalId);
  if (!proposal) {
    throw new ManufactureError(
      "not_found",
      `manufacture proposal not found: ${proposalId}`,
      404,
    );
  }
  return proposal;
}

async function saveProposal(
  packDir: string,
  proposal: ManufactureProposal,
): Promise<void> {
  const file = proposalPath(packDir, proposal.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(proposal, null, 2)}\n`);
}

function proposalPath(packDir: string, proposalId: string): string {
  if (!/^[0-9a-z-]+$/i.test(proposalId)) {
    throw new ManufactureError("invalid_proposal_id", "invalid proposal id");
  }
  return path.join(path.resolve(packDir), PROPOSALS_DIR, `${proposalId}.json`);
}

async function appendAudit(
  packDir: string,
  record: Record<string, unknown>,
): Promise<void> {
  const file = path.join(path.resolve(packDir), AUDIT_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

async function upsertLock(
  packDir: string,
  entry: ManufactureLockEntry,
): Promise<void> {
  const lock = await readManufactureLock(packDir);
  const assets = lock.assets.filter(
    (asset) => !(asset.kind === entry.kind && asset.id === entry.id),
  );
  assets.push(entry);
  assets.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
  const next: ManufactureLock = {
    ...lock,
    ...(lock.pack
      ? { pack: lock.pack }
      : { pack: { id: path.basename(path.resolve(packDir)) } }),
    assets,
    generatedAt: new Date().toISOString(),
  };
  await writeFileAtomic(
    path.join(path.resolve(packDir), MANUFACTURE_LOCK_FILE),
    `${JSON.stringify(next, null, 2)}\n`,
  );
}

async function removeLockEntry(
  packDir: string,
  proposalId: string,
): Promise<void> {
  const lock = await readManufactureLock(packDir);
  const assets = lock.assets.filter((asset) => asset.proposalId !== proposalId);
  if (assets.length === lock.assets.length) {
    return;
  }
  await writeFileAtomic(
    path.join(path.resolve(packDir), MANUFACTURE_LOCK_FILE),
    `${JSON.stringify(
      { ...lock, assets, generatedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  );
}

function emptyLock(): ManufactureLock {
  return {
    apiVersion: "agentteam/v1",
    kind: "ManufactureLock",
    lockVersion: 1,
    assets: [],
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

interface BackupSnapshot {
  relative: string;
  existed: boolean;
  content: string;
}

interface BackupRecord {
  proposalId: string;
  packDir: string;
  at: string;
  snapshots: BackupSnapshot[];
}

async function snapshotPack(
  packDir: string,
  proposal: ManufactureProposal,
  deps: ManufactureDeps,
): Promise<BackupRecord> {
  let relatives: string[];
  if (proposal.draft.type === "component") {
    relatives = ["team.yaml", "components.lock.json"];
    for (const component of proposal.draft.components) {
      relatives.push(...(await predictComponentPaths(component, deps)));
    }
  } else if (proposal.draft.type === "pipeline") {
    relatives = [`pipelines/${proposal.draft.id}.yaml`];
  } else if (proposal.draft.type === "workflow") {
    relatives = ["team.yaml", `workflows/${proposal.draft.id}.yaml`];
  } else {
    relatives = [
      "team.yaml",
      loadedManagerFile(
        existsSync(path.join(packDir, "team.yaml"))
          ? await readFile(path.join(packDir, "team.yaml"), "utf8")
          : null,
      ) ?? `agents/${proposal.draft.id}.md`,
      `agents/${proposal.draft.id}.md`,
    ];
  }
  const snapshots = await Promise.all(
    [...new Set(relatives)].map((relative) => snapshotFile(packDir, relative)),
  );
  snapshots.push(await snapshotFile(packDir, MANUFACTURE_LOCK_FILE));
  return {
    proposalId: proposal.id,
    packDir,
    at: new Date().toISOString(),
    snapshots,
  };
}

async function predictComponentPaths(
  component: ManufactureComponentRequest,
  deps: ManufactureDeps,
): Promise<string[]> {
  if (!deps.library) {
    return [];
  }
  const resolved = await deps.library.resolve(component.kind, component.id);
  if (!resolved.ok) {
    return [];
  }
  const value = resolved.component;
  if (value.kind === "agent") {
    return [`agents/${value.id}.md`];
  }
  if (value.kind === "workflow") {
    return [`workflows/${value.id}.yaml`];
  }
  if (value.kind === "toolpack") {
    return [`toolpacks/${value.id}.yaml`];
  }
  return [
    `skillpacks/${value.id}/skillpack.yaml`,
    ...value.files.map((file) => `skillpacks/${value.id}/${file.path}`),
  ];
}

async function snapshotFile(
  packDir: string,
  relative: string,
): Promise<BackupSnapshot> {
  const absolute = path.join(path.resolve(packDir), relative);
  const existed = existsSync(absolute);
  return {
    relative,
    existed,
    content: existed ? await readFile(absolute, "utf8") : "",
  };
}

async function restoreSnapshots(
  packDir: string,
  snapshots: BackupSnapshot[],
): Promise<void> {
  const root = path.resolve(packDir);
  for (const snapshot of [...snapshots].reverse()) {
    const absolute = path.join(root, snapshot.relative);
    if (snapshot.existed) {
      await writeFileAtomic(absolute, snapshot.content).catch(() => undefined);
    } else {
      await rm(absolute, { force: true }).catch(() => undefined);
    }
  }
}

async function writeBackup(
  packDir: string,
  proposalId: string,
  backup: BackupRecord,
): Promise<void> {
  const file = path.join(
    path.resolve(packDir),
    BACKUPS_DIR,
    `${proposalId}.json`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(backup, null, 2)}\n`);
}

async function readBackup(
  packDir: string,
  proposalId: string,
): Promise<BackupRecord | null> {
  const file = path.join(
    path.resolve(packDir),
    BACKUPS_DIR,
    `${proposalId}.json`,
  );
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as BackupRecord;
  } catch {
    return null;
  }
}

async function restoreBackup(
  packDir: string,
  backup: BackupRecord,
): Promise<void> {
  const root = path.resolve(packDir);
  for (const snapshot of [...backup.snapshots].reverse()) {
    const absolute = path.join(root, snapshot.relative);
    if (snapshot.existed) {
      await writeFileAtomic(absolute, snapshot.content);
    } else {
      await rm(absolute, { force: true });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Provenance helpers                                                  */
/* ------------------------------------------------------------------ */

async function buildProvenance(
  packDir: string,
  proposal: ManufactureProposal,
  applied: AppliedDraft,
): Promise<ManufactureProvenance> {
  const lock = await readManufactureLock(packDir);
  const prior = lock.assets.find(
    (asset) => asset.kind === proposal.kind && asset.id === proposal.assetId,
  );
  const version =
    proposal.draft.type === "workflow"
      ? proposal.draft.version
      : proposal.draft.type === "pipeline"
        ? proposal.draft.spec.version
        : prior
          ? bumpPatch(prior.version)
          : "0.1.0";
  return {
    version,
    source: {
      repo: `local/${proposal.assetId}`,
      commit: sha256(applied.primary.content).slice(0, 40),
      ref: "local",
      sha256: sha256(applied.primary.content),
    },
  };
}

function bumpPatch(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return "0.1.0";
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/* ------------------------------------------------------------------ */
/* Pack document helpers                                               */
/* ------------------------------------------------------------------ */

function agentMarkdown(draft: ManufactureAgentDraft): string {
  const frontmatter = {
    name: draft.id,
    description: draft.description,
    model: draft.model,
    role: draft.type === "manager" ? "manager" : draft.role,
    tools: draft.tools,
    skills: draft.skills,
    permissions: draft.permissions,
  };
  return `---\n${stringify(frontmatter)}---\n\n${draft.instructions.trim()}\n`;
}

function workflowDocFromStages(draft: ManufactureWorkflowDraft): {
  id: string;
  version: string;
  trigger: { event: string };
  stages: WorkflowStage[];
  delivery: { channel: "local_file" };
} {
  return {
    id: draft.id,
    version: draft.version,
    trigger: { event: "task.received" },
    stages: draft.stages.map(draftStageToWorkflowStage),
    delivery: { channel: "local_file" },
  };
}

function draftStageToWorkflowStage(stage: DraftStage): WorkflowStage {
  const out: Record<string, unknown> = {
    id: stage.id,
    type: stage.type,
    inputs: stage.inputs,
    outputs: stage.outputs,
  };
  if (stage.agent) {
    out.agent = stage.agent;
  }
  if (stage.coder) {
    out.coder = stage.coder;
  }
  if (stage.goal) {
    out.goal = stage.goal;
  }
  if (stage.acceptance) {
    out.acceptance = stage.acceptance;
  }
  if (stage.timeout) {
    out.timeout = stage.timeout;
  }
  if (stage.retry) {
    out.retry = stage.retry;
  }
  if (stage.gate) {
    out.gate = stage.gate;
  }
  if (stage.depends.length === 1) {
    out.inputFrom = stage.depends[0];
  } else if (stage.depends.length > 1) {
    out.inputsFrom = stage.depends;
  }
  if (stage.includeInitialInput) {
    out.includeInitialInput = true;
  }
  if (stage.revisionAgent) {
    out.revisionAgent = stage.revisionAgent;
  }
  if (stage.approval) {
    out.approval = stage.approval;
  }
  return out as WorkflowStage;
}

interface TeamDocLike {
  manager?: { agent: string; model?: string; [key: string]: unknown };
  workflows?: string[];
  agents: Array<{
    id: string;
    file: string;
    model?: string;
    role?: string;
    tools?: string[];
    skills?: string[];
    [key: string]: unknown;
  }>;
  workspaces?: Record<string, { agents?: string[] }>;
  [key: string]: unknown;
}

function parseTeamDoc(text: string): TeamDocLike {
  const parsed = parse(text) as Partial<TeamDocLike> | null;
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new ManufactureError(
      "team_invalid",
      "team.yaml agents must be an array",
    );
  }
  return parsed as TeamDocLike;
}

function upsertAgentInTeam(
  teamRaw: string,
  draft: ManufactureAgentDraft,
  relative: string,
): string {
  const doc = parseTeamDoc(teamRaw);
  const role = draft.type === "manager" ? "manager" : draft.role;
  const entry = doc.agents.find((agent) => agent.id === draft.id);
  if (entry) {
    entry.file = relative;
    entry.model = draft.model;
    entry.role = role;
    entry.tools = [...draft.tools];
    entry.skills = [...draft.skills];
  } else {
    doc.agents.push({
      id: draft.id,
      file: relative,
      model: draft.model,
      role,
      tools: [...draft.tools],
      skills: [...draft.skills],
    });
    addToDefaultWorkspace(doc, draft.id);
  }
  if (draft.type === "manager") {
    doc.manager = {
      ...(doc.manager ?? { agent: relative }),
      agent: relative,
      model: draft.model,
    };
  }
  return stringify(doc);
}

function appendWorkflowToTeam(teamRaw: string, relative: string): string {
  const doc = parseTeamDoc(teamRaw);
  doc.workflows ??= [];
  if (!doc.workflows.includes(relative)) {
    doc.workflows.push(relative);
  }
  return stringify(doc);
}

function addToDefaultWorkspace(doc: TeamDocLike, id: string): void {
  const workspaces = doc.workspaces;
  if (!workspaces) {
    return;
  }
  const name = workspaces.default ? "default" : Object.keys(workspaces)[0];
  const workspace = name ? workspaces[name] : undefined;
  if (!workspace) {
    return;
  }
  workspace.agents ??= [];
  if (!workspace.agents.includes(id)) {
    workspace.agents.push(id);
  }
}

function loadedManagerFile(teamRaw: string | null): string | null {
  if (!teamRaw) {
    return null;
  }
  try {
    const parsed = parse(teamRaw) as { manager?: { agent?: unknown } } | null;
    return typeof parsed?.manager?.agent === "string"
      ? parsed.manager.agent
      : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function applyAgentFields(
  draft: ManufactureDraft,
  fields: ManufactureDraftInput["agentFields"],
): void {
  if (!fields || (draft.type !== "agent" && draft.type !== "manager")) {
    return;
  }
  if (typeof fields.description === "string") {
    draft.description = fields.description.slice(0, 300);
  }
  if (typeof fields.model === "string" && fields.model.trim()) {
    draft.model = fields.model.trim().slice(0, 120);
  }
  if (typeof fields.role === "string") {
    draft.role = fields.role;
  }
  if (typeof fields.instructions === "string") {
    draft.instructions = fields.instructions.slice(0, 8000);
  }
  if (Array.isArray(fields.tools)) {
    draft.tools = fields.tools.filter(
      (tool): tool is string => typeof tool === "string",
    );
  }
  if (Array.isArray(fields.skills)) {
    draft.skills = fields.skills.filter(
      (skill): skill is string => typeof skill === "string",
    );
  }
  if (fields.permissions) {
    draft.permissions = {
      filesystem:
        typeof fields.permissions.filesystem === "string"
          ? fields.permissions.filesystem
          : draft.permissions.filesystem,
      network:
        typeof fields.permissions.network === "string"
          ? fields.permissions.network
          : draft.permissions.network,
    };
  }
}

function assetIdOf(draft: ManufactureDraft): string {
  if (draft.type === "component") {
    return (
      draft.components
        .map((component) => `${component.kind}-${component.id}`)
        .join("-") || "components"
    );
  }
  return draft.id;
}

function parseCatalogList(
  value: unknown,
  catalog: string[],
  label: string,
  warnings: string[],
  fallback: string[],
): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const allowed = new Set(catalog);
  const requested = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const dropped = requested.filter((item) => !allowed.has(item));
  if (dropped.length > 0) {
    warnings.push(
      `${label}不存在于 Pack 目录，已剔除：${dropped.slice(0, 5).join(", ")}`,
    );
  }
  return requested.filter((item) => allowed.has(item));
}

function parseDraftStages(value: unknown): DraftStage[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const stages: DraftStage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      return null;
    }
    const type =
      record.type === "coder"
        ? "coder"
        : record.type === "agent" || record.type === undefined
          ? "agent"
          : null;
    if (!type) {
      return null;
    }
    const inputs = stringArray(record.inputs);
    const outputs = stringArray(record.outputs);
    if (inputs.length === 0 || outputs.length === 0) {
      return null;
    }
    const stage: DraftStage = {
      id,
      type,
      inputs,
      outputs,
      depends: stringArray(
        record.depends ??
          record.inputsFrom ??
          (typeof record.inputFrom === "string" ? [record.inputFrom] : []),
      ),
    };
    const agent = text(record.agent, 64);
    if (agent) {
      stage.agent = agent;
    }
    const coder = text(record.coder, 20);
    if (
      coder === "dsh" ||
      coder === "codex" ||
      coder === "opencode" ||
      coder === "command"
    ) {
      stage.coder = coder;
    }
    const goal = text(record.goal, 300);
    if (goal) {
      stage.goal = goal;
    }
    const acceptance = text(record.acceptance, 500);
    if (acceptance) {
      stage.acceptance = acceptance;
    }
    const timeout = text(record.timeout, 40);
    if (timeout) {
      stage.timeout = timeout;
    }
    const gate = text(record.gate, 200);
    if (gate) {
      stage.gate = gate;
    }
    stages.push(stage);
  }
  return stages;
}

function heuristicComponentPick(
  intent: string,
  available: ManufactureComponentRequest[],
): ManufactureComponentRequest | null {
  const words = intent
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((word) => word.length >= 2);
  let best: { component: ManufactureComponentRequest; score: number } | null =
    null;
  for (const component of available) {
    const haystack = `${component.kind} ${component.id}`.toLowerCase();
    let score = 0;
    if (haystack.includes(intent.trim().toLowerCase())) {
      score += 4;
    }
    for (const word of words) {
      if (haystack.includes(word)) {
        score += 1;
      }
    }
    if (!best || score > best.score) {
      best = { component, score };
    }
  }
  return best ? best.component : null;
}

function evalFileExists(packDir: string, gate: string): boolean {
  const file = gate.split("#")[0]?.trim();
  if (!file || file.includes("..") || path.isAbsolute(file)) {
    return false;
  }
  return (
    existsSync(path.join(packDir, "evals", file)) ||
    existsSync(path.join(packDir, "evals", "visible", file))
  );
}

interface PipelineChainEntry {
  id: string;
  goal: string;
}

function chainPipeline(entries: PipelineChainEntry[]): {
  nodes: Array<{
    id: string;
    type: "agent";
    description: string;
    inputs: string[];
    outputs: string[];
  }>;
  edges: Array<{ from: string; to: string }>;
} {
  const nodes: Array<{
    id: string;
    type: "agent";
    description: string;
    inputs: string[];
    outputs: string[];
  }> = [];
  const edges: Array<{ from: string; to: string }> = [];
  for (const entry of entries) {
    const previous = nodes[nodes.length - 1];
    nodes.push({
      id: entry.id,
      type: "agent",
      description: entry.goal,
      inputs: previous ? [`${previous.id}_output`] : ["task"],
      outputs: [`${entry.id}_output`],
    });
    if (previous) {
      edges.push({ from: previous.id, to: entry.id });
    }
  }
  return { nodes, edges };
}

function slugId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return ID_PATTERN.test(cleaned) ? cleaned : "manufactured-asset";
}

function uniqueId(base: string, used: Set<string>): string {
  const seed = slugId(base);
  let id = seed;
  let index = 2;
  while (used.has(id)) {
    id = `${seed}-${index}`;
    index += 1;
  }
  return id;
}

function firstSentence(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const sentence = trimmed.split(/(?<=[.!?。！？])\s/)[0] ?? trimmed;
  return sentence.slice(0, max);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function stringList(value: unknown[], max: number): string[] {
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, max);
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const cleaned = value
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
