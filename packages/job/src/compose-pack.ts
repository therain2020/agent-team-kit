import { type AgentRole, agentRoleSchema } from "@kit/core";
import { createModelGateway, loadModelConfig } from "@kit/model";
import { type TemplateSummary, listTemplates } from "@kit/pack";
import { JobError } from "./types";

/**
 * Composer for creating a brand-new Team Pack from a one-line intent.
 *
 * Unlike the runtime composers in `compose.ts`, a `pack` draft does not act on
 * an existing pack directory: the pack does not exist yet. The draft is pure
 * data (`values`) plus a rationale/warnings envelope; nothing is persisted here.
 * The wizard renders it for review and only the create API writes files after
 * explicit approval.
 */

export const MAX_PACK_AGENTS = 12;
const SLUG = /^[a-z][a-z0-9-]*$/;
const DEFAULT_MANAGER_INSTRUCTIONS =
  "You are the Manager of this team. Review exceptions, explain trade-offs, and ask the operator only when a decision cannot be made from the evidence. Never invent evidence.";

export interface PackDraftAgent {
  id: string;
  description: string;
  /** Employees are never `manager`; the manager is a separate field. */
  role: Exclude<AgentRole, "manager">;
  model: string;
  instructions: string;
}

export interface PackDraftManager {
  model: string;
  instructions: string;
}

export interface PackDraftValues {
  /** Directory under packs/; also the pack id. */
  dirName: string;
  name: string;
  description: string;
  /** Chosen template id; the create API needs it to scaffold workflows/policies. */
  template: string;
  manager: PackDraftManager;
  agents: PackDraftAgent[];
}

export interface PackComposeDraft {
  values: PackDraftValues;
  rationale: string;
  warnings: string[];
  model: "live" | "heuristic";
}

export interface PackComposeOptions {
  /** Template pre-selected by the user; empty/omitted lets the AI choose. */
  templateId?: string;
  env: Record<string, string | undefined>;
}

export interface PackComposeFacts {
  templates: TemplateSummary[];
  models: string[];
  roles: Array<Exclude<AgentRole, "manager">>;
  requestedTemplate: string | null;
}

export async function composePackDraft(
  intent: string,
  options: PackComposeOptions,
): Promise<PackComposeDraft> {
  const trimmed = intent.trim();
  if (!trimmed) {
    throw new JobError("intent_required", "a one-line intent is required", 400);
  }

  const templates = await listTemplates();
  if (templates.length === 0) {
    throw new JobError(
      "templates_unavailable",
      "no templates are available to scaffold a pack",
      500,
    );
  }

  const env = options.env;
  const models = modelWhitelist(env);
  const requested = (options.templateId ?? "").trim();
  const facts: PackComposeFacts = {
    templates,
    models,
    roles: ["builder", "seller", "specialist"],
    requestedTemplate:
      requested && templates.some((item) => item.id === requested)
        ? requested
        : null,
  };

  const warnings: string[] = [];
  if (requested && !facts.requestedTemplate) {
    warnings.push(`模板 ${requested} 不存在，已按意图自动选择。`);
  }
  const fallback = defaultPackDraft(trimmed, facts, warnings);
  let values = fallback;
  let rationale =
    "按意图挑选模板，并用模板默认角色与指令生成可编辑的模具草稿。";
  let model: PackComposeDraft["model"] = "heuristic";

  const config = loadModelConfig(env);
  if (config.mode === "live") {
    try {
      const gateway = createModelGateway(config);
      const response = await gateway.complete({
        model: "deepseek-flash",
        instructions: `You draft a Team Pack skeleton from a one-line intent.
Return JSON only:
{"templateId":"<id>","dirName":"<slug>","name":"<team name>","description":"<one sentence>","manager":{"model":"<model>","instructions":"<Markdown role prompt>"},"agents":[{"id":"<slug>","description":"<one sentence>","role":"builder|seller|specialist","model":"<model>","instructions":"<Markdown role prompt>"}],"rationale":"<one sentence>","warnings":["<optional>"]}
Rules:
- templateId must be one of the provided template ids.
- dirName and every agent id are lowercase slugs matching ^[a-z][a-z0-9-]*$; ids are unique and never "manager".
- employees use role builder, seller or specialist; never "manager".
- model must be one of the allowed model ids; prefer deepseek-flash for doers and deepseek-pro for reviewers/managers.
- keep 1 to ${MAX_PACK_AGENTS} agents, as small as the intent allows; reuse the template's agents when they already fit.
- descriptions are one sentence; instructions are concise Markdown role prompts.
- do not invent tools, skills, workflows or facts.`,
        input: JSON.stringify({
          intent: trimmed,
          requestedTemplate: facts.requestedTemplate,
          templates: facts.templates.map((template) => ({
            id: template.id,
            name: template.name,
            description: template.description,
            agents: template.agents.map((agent) => ({
              id: agent.id,
              description: agent.description,
              role: agent.role,
              model: agent.model,
            })),
          })),
          models: facts.models,
          roles: facts.roles,
        }),
      });
      const parsed = parseJson(response.text);
      if (parsed) {
        const validated = validatePackDraft(parsed, fallback, facts);
        if (validated.accepted) {
          values = validated.values;
          rationale = validated.rationale ?? rationale;
          warnings.push(...validated.warnings);
          model = "live";
        } else {
          warnings.push(...validated.warnings);
          warnings.push("AI 草稿未通过校验，已使用模板默认草稿。");
        }
      }
    } catch {
      warnings.push("AI 草稿不可用，已使用模板默认草稿。");
    }
  }

  return {
    values,
    rationale,
    warnings: [...new Set(warnings)],
    model,
  };
}

function defaultPackDraft(
  intent: string,
  facts: PackComposeFacts,
  warnings: string[],
): PackDraftValues {
  const template =
    facts.templates.find((item) => item.id === facts.requestedTemplate) ??
    pickTemplate(intent, facts.templates) ??
    facts.templates.find((item) => item.agents.length > 0) ??
    facts.templates[0];
  if (!template) {
    throw new JobError(
      "templates_unavailable",
      "no templates are available to scaffold a pack",
      500,
    );
  }

  const name = template.name;
  const dirName = toSlug(name, "team");
  const managerModel = preferredModel(facts.models, "deepseek-pro");
  const agentModel = preferredModel(facts.models, "deepseek-flash");

  const employees = template.agents
    .filter((agent) => agent.role !== "manager")
    .slice(0, MAX_PACK_AGENTS)
    .map((agent) => ({
      id: toSlug(agent.id, "worker"),
      description: agent.description,
      role: employeeRole(agent.role),
      model: facts.models.includes(agent.model) ? agent.model : agentModel,
      instructions: defaultAgentInstructions(agent.id, agent.description),
    }));

  if (template.agents.length > MAX_PACK_AGENTS) {
    warnings.push(`模板员工超过 ${MAX_PACK_AGENTS} 人，已截断。`);
  }
  if (employees.length === 0) {
    employees.push({
      id: "worker",
      description: "Team member",
      role: "builder",
      model: agentModel,
      instructions: defaultAgentInstructions("worker", "Team member"),
    });
    warnings.push("模板没有可用员工，已补充一个 Builder。");
  }

  return {
    dirName,
    name,
    description: template.description || `${name} agent team`,
    template: template.id,
    manager: {
      model: managerModel,
      instructions: DEFAULT_MANAGER_INSTRUCTIONS,
    },
    agents: employees,
  };
}

export interface PackDraftValidation {
  values: PackDraftValues;
  rationale?: string;
  warnings: string[];
  accepted: boolean;
}

export function validatePackDraft(
  parsed: Record<string, unknown>,
  fallback: PackDraftValues,
  facts: PackComposeFacts,
): PackDraftValidation {
  const warnings: string[] = [];
  let accepted = false;
  const templateIds = new Set(facts.templates.map((template) => template.id));
  const models = new Set(facts.models);

  const values: PackDraftValues = {
    ...fallback,
    manager: { ...fallback.manager },
    agents: fallback.agents.map((agent) => ({ ...agent })),
  };

  if (
    typeof parsed.templateId === "string" &&
    templateIds.has(parsed.templateId)
  ) {
    values.template = parsed.templateId;
    accepted = true;
  } else if (parsed.templateId !== undefined) {
    warnings.push("AI 选择的模板不存在，已保留默认模板。");
  }

  if (typeof parsed.name === "string" && parsed.name.trim()) {
    values.name = parsed.name.trim().slice(0, 120);
    accepted = true;
  }
  if (typeof parsed.description === "string" && parsed.description.trim()) {
    values.description = parsed.description.trim().slice(0, 300);
    accepted = true;
  }

  const dirName = normalizeSlug(parsed.dirName);
  if (dirName) {
    values.dirName = dirName;
    accepted = true;
  } else if (parsed.dirName !== undefined) {
    warnings.push("AI 生成的目录名不合法，已保留默认目录名。");
  }

  if (parsed.manager && typeof parsed.manager === "object") {
    const manager = parsed.manager as Record<string, unknown>;
    if (typeof manager.model === "string" && manager.model.trim()) {
      const candidate = manager.model.trim();
      if (models.has(candidate)) {
        values.manager.model = candidate;
        accepted = true;
      } else {
        warnings.push(`经理模型 ${candidate} 不在白名单内，已保留默认模型。`);
      }
    }
    if (
      typeof manager.instructions === "string" &&
      manager.instructions.trim()
    ) {
      values.manager.instructions = manager.instructions.trim().slice(0, 8000);
      accepted = true;
    }
  }

  if (Array.isArray(parsed.agents)) {
    const raw = parsed.agents.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    );
    if (raw.length > MAX_PACK_AGENTS) {
      warnings.push(`AI 生成超过 ${MAX_PACK_AGENTS} 个员工，已截断。`);
    }
    const next: PackDraftAgent[] = [];
    const seen = new Set<string>();
    for (const item of raw.slice(0, MAX_PACK_AGENTS)) {
      const id = normalizeSlug(item.id);
      if (!id) {
        warnings.push("AI 员工 id 不合法，已忽略该员工。");
        continue;
      }
      if (seen.has(id)) {
        warnings.push(`AI 员工 id 重复：${id}，已忽略。`);
        continue;
      }
      const role = employeeRoleFrom(item.role);
      if (!role) {
        warnings.push(`AI 员工 ${id} 的职责不合法，已忽略该员工。`);
        continue;
      }
      const candidateModel =
        typeof item.model === "string" && models.has(item.model.trim())
          ? item.model.trim()
          : null;
      if (
        typeof item.model === "string" &&
        item.model.trim() &&
        !candidateModel
      ) {
        warnings.push(`AI 员工 ${id} 的模型不在白名单内，已改用默认模型。`);
      }
      seen.add(id);
      const description =
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim().slice(0, 300)
          : `Team member ${id}`;
      next.push({
        id,
        description,
        role,
        model: candidateModel ?? preferredModel(facts.models, "deepseek-flash"),
        instructions:
          typeof item.instructions === "string" && item.instructions.trim()
            ? item.instructions.trim().slice(0, 8000)
            : defaultAgentInstructions(id, description),
      });
    }
    if (next.length > 0) {
      values.agents = next;
      accepted = true;
    } else {
      warnings.push("AI 没有提供可用的员工，已保留模板默认员工。");
    }
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

/**
 * Server-side re-validation for the create API. Returns a list of hard errors;
 * an empty list means the submitted draft is safe to hand to `createPack`.
 */
export function validatePackCreation(
  input: {
    dirName: string;
    name: string;
    managerModel?: string;
    agents?: Array<{
      id?: unknown;
      role?: unknown;
      model?: unknown;
    }>;
  },
  env: Record<string, string | undefined>,
): string[] {
  const errors: string[] = [];
  const models = new Set(modelWhitelist(env));

  if (!SLUG.test(input.dirName)) {
    errors.push("dirName must match ^[a-z][a-z0-9-]*$");
  }
  if (!input.name.trim()) {
    errors.push("name is required");
  }
  if (input.managerModel?.trim() && !models.has(input.managerModel.trim())) {
    errors.push(`manager model ${input.managerModel} is not allowed`);
  }

  const agents = input.agents ?? [];
  if (agents.length > MAX_PACK_AGENTS) {
    errors.push(`at most ${MAX_PACK_AGENTS} agents are allowed`);
  }
  const seen = new Set<string>();
  for (const agent of agents) {
    if (typeof agent.id !== "string" || !SLUG.test(agent.id)) {
      errors.push(`agent id is invalid: ${String(agent.id)}`);
      continue;
    }
    if (agent.id === "manager") {
      errors.push('agent id "manager" is reserved for the manager');
    }
    if (seen.has(agent.id)) {
      errors.push(`agent id is duplicated: ${agent.id}`);
    }
    seen.add(agent.id);
    if (agent.role !== undefined) {
      const parsed = agentRoleSchema.safeParse(agent.role);
      if (!parsed.success) {
        errors.push(`agent ${agent.id} role is invalid: ${String(agent.role)}`);
      } else if (parsed.data === "manager") {
        errors.push(`agent ${agent.id} cannot use the manager role`);
      }
    }
    if (
      typeof agent.model === "string" &&
      agent.model.trim() &&
      !models.has(agent.model.trim())
    ) {
      errors.push(`agent ${agent.id} model is not allowed: ${agent.model}`);
    }
  }
  return errors;
}

function modelWhitelist(env: Record<string, string | undefined>): string[] {
  const config = loadModelConfig(env);
  return [
    ...new Set([
      ...Object.keys(config.aliases),
      ...Object.values(config.aliases),
    ]),
  ].sort();
}

function preferredModel(models: string[], preferred: string): string {
  if (models.includes(preferred)) {
    return preferred;
  }
  return models[0] ?? preferred;
}

function pickTemplate(
  intent: string,
  templates: TemplateSummary[],
): TemplateSummary | undefined {
  const text = intent.toLowerCase();
  return templates.find((template) =>
    [template.id, template.name, template.description].some((value) =>
      text.includes(value.toLowerCase()),
    ),
  );
}

function employeeRole(role: string): PackDraftAgent["role"] {
  return role === "seller" || role === "specialist" ? role : "builder";
}

function employeeRoleFrom(value: unknown): PackDraftAgent["role"] | null {
  if (value === "builder" || value === "seller" || value === "specialist") {
    return value;
  }
  return null;
}

function defaultAgentInstructions(id: string, description: string): string {
  return `You are ${id}. ${description.trim()} Complete the assigned stage and return a concise, verifiable result.`;
}

function normalizeSlug(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return SLUG.test(trimmed) && trimmed !== "manager" ? trimmed : null;
}

function toSlug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (/^[a-z][a-z0-9-]*$/.test(cleaned)) {
    return cleaned;
  }
  const prefixed = `team-${cleaned}`.replace(/-+$/g, "");
  return SLUG.test(prefixed) ? prefixed : fallback;
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
