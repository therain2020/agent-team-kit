import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentFrontmatter,
  type AgentRole,
  type AgentSpec,
  type AutopilotConfig,
  type Policy,
  type SkillFrontmatter,
  type TeamPack,
  type WorkflowDefinition,
  agentFrontmatterSchema,
  autopilotSchema,
  policySchema,
  rubricSetSchema,
  skillFrontmatterSchema,
  teamPackSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import { parse } from "yaml";
import { type RoleRules, getRoleRules, resolveAgentRole } from "./role-plan";

export interface LoadedAgent {
  spec: AgentSpec;
  frontmatter: AgentFrontmatter;
  role: AgentRole;
}

export interface LoadedPack {
  pack: TeamPack;
  dir: string;
  agents: Map<string, LoadedAgent>;
  skills: Map<string, SkillFrontmatter>;
  workflows: WorkflowDefinition[];
  policies: Policy[];
  autopilot?: AutopilotConfig;
  roleRules: RoleRules;
  warnings: string[];
}

export type LoadResult =
  | ({ ok: true } & LoadedPack)
  | { ok: false; dir: string; errors: string[] };

const KIT_VERSION = "1.0.0";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
];

export async function loadPack(dirInput: string): Promise<LoadResult> {
  const dir = path.resolve(process.cwd(), dirInput);
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifestPath = path.join(dir, "team.yaml");

  if (!existsSync(manifestPath)) {
    return { ok: false, dir, errors: ["team.yaml not found"] };
  }

  let raw: unknown;
  try {
    raw = parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, dir, errors: [`team.yaml parse error: ${message}`] };
  }

  scanSecrets(await readFile(manifestPath, "utf8"), "team.yaml", errors);

  const parsed = teamPackSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      dir,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      ),
    };
  }

  const pack = parsed.data;

  if (!satisfiesKitRange(pack.metadata.compatibility.kit)) {
    errors.push(
      `kit compatibility mismatch: pack requires ${pack.metadata.compatibility.kit}, kit is ${KIT_VERSION}`,
    );
  }

  const agents = new Map<string, LoadedAgent>();

  for (const agent of pack.agents) {
    if (agents.has(agent.id)) {
      errors.push(`duplicate agent id: ${agent.id}`);
      continue;
    }

    const agentPath = path.join(dir, agent.file);
    if (!existsSync(agentPath)) {
      errors.push(`agent file missing: ${agent.file}`);
      continue;
    }

    const text = await readFile(agentPath, "utf8");
    scanSecrets(text, agent.file, errors);

    const frontmatter = parseFrontmatter(text);
    if (!frontmatter) {
      errors.push(`agent frontmatter missing: ${agent.file}`);
      continue;
    }

    const parsedAgent = agentFrontmatterSchema.safeParse(frontmatter);
    if (!parsedAgent.success) {
      errors.push(
        ...parsedAgent.error.issues.map(
          (issue) => `${agent.file}: ${issue.path.join(".")}: ${issue.message}`,
        ),
      );
      continue;
    }

    if (parsedAgent.data.name !== agent.id) {
      errors.push(
        `agent ${agent.id}: frontmatter name "${parsedAgent.data.name}" does not match id`,
      );
    }
    if (parsedAgent.data.model !== agent.model) {
      warnings.push(
        `agent ${agent.id}: model mismatch (team.yaml ${agent.model}, frontmatter ${parsedAgent.data.model})`,
      );
    }
    if (
      agent.role &&
      parsedAgent.data.role &&
      agent.role !== parsedAgent.data.role
    ) {
      warnings.push(
        `agent ${agent.id}: role mismatch (team.yaml ${agent.role}, frontmatter ${parsedAgent.data.role})`,
      );
    }

    const role = resolveAgentRole({
      id: agent.id,
      description: parsedAgent.data.description,
      specRole: agent.role,
      frontmatterRole: parsedAgent.data.role,
    });

    agents.set(agent.id, {
      spec: agent,
      frontmatter: parsedAgent.data,
      role,
    });
  }

  if (pack.manager && !existsSync(path.join(dir, pack.manager.agent))) {
    errors.push(`manager agent file missing: ${pack.manager.agent}`);
  }

  const skills = new Map<string, SkillFrontmatter>();

  for (const agent of pack.agents) {
    for (const skill of agent.skills) {
      if (skills.has(skill)) {
        continue;
      }

      const skillPath = path.join(dir, "skills", skill, "SKILL.md");
      if (!existsSync(skillPath)) {
        errors.push(`skill missing: skills/${skill}/SKILL.md`);
        continue;
      }

      const text = await readFile(skillPath, "utf8");
      scanSecrets(text, `skills/${skill}/SKILL.md`, errors);

      const frontmatter = parseFrontmatter(text);
      if (!frontmatter) {
        errors.push(`skill frontmatter missing: skills/${skill}/SKILL.md`);
        continue;
      }

      const parsedSkill = skillFrontmatterSchema.safeParse(frontmatter);
      if (!parsedSkill.success) {
        errors.push(
          ...parsedSkill.error.issues.map(
            (issue) =>
              `skills/${skill}/SKILL.md: ${issue.path.join(".")}: ${issue.message}`,
          ),
        );
        continue;
      }

      if (parsedSkill.data.name !== skill) {
        errors.push(
          `skill ${skill}: frontmatter name "${parsedSkill.data.name}" does not match directory`,
        );
      }

      skills.set(skill, parsedSkill.data);
    }
  }

  const workflows: WorkflowDefinition[] = [];
  const workflowIds = new Set<string>();

  for (const workflowFile of pack.workflows) {
    const workflowPath = path.join(dir, workflowFile);
    if (!existsSync(workflowPath)) {
      errors.push(`workflow file missing: ${workflowFile}`);
      continue;
    }

    const text = await readFile(workflowPath, "utf8");
    scanSecrets(text, workflowFile, errors);

    let doc: unknown;
    try {
      doc = parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${workflowFile}: parse error: ${message}`);
      continue;
    }

    const parsedWorkflow = workflowDefinitionSchema.safeParse(doc);
    if (!parsedWorkflow.success) {
      errors.push(
        ...parsedWorkflow.error.issues.map(
          (issue) =>
            `${workflowFile}: ${issue.path.join(".")}: ${issue.message}`,
        ),
      );
      continue;
    }

    const workflow = parsedWorkflow.data;
    if (workflowIds.has(workflow.id)) {
      errors.push(`duplicate workflow id: ${workflow.id}`);
    }
    workflowIds.add(workflow.id);

    const seenStageIds = new Set<string>();

    for (const stage of workflow.stages) {
      if (stage.inputFrom && !seenStageIds.has(stage.inputFrom)) {
        errors.push(
          `${workflowFile}: stage ${stage.id} inputFrom must reference an earlier stage: ${stage.inputFrom}`,
        );
      }
      if (stage.revisionAgent && !agents.has(stage.revisionAgent)) {
        errors.push(
          `${workflowFile}: stage ${stage.id} revisionAgent references unknown agent: ${stage.revisionAgent}`,
        );
      }
      seenStageIds.add(stage.id);

      if (
        stage.type === "agent" &&
        (!stage.agent || !agents.has(stage.agent))
      ) {
        errors.push(
          `${workflowFile}: stage ${stage.id} references unknown agent: ${stage.agent ?? "<none>"}`,
        );
      }

      if (stage.gate) {
        const [gateFileRaw, gateKey] = stage.gate.split("#");
        const gateFile = gateFileRaw ?? "";
        const gatePath = path.join(dir, gateFile);

        if (!existsSync(gatePath)) {
          errors.push(
            `${workflowFile}: stage ${stage.id} gate file missing: ${gateFile}`,
          );
        } else {
          const gateText = await readFile(gatePath, "utf8");
          scanSecrets(gateText, gateFile, errors);

          let gateDoc: unknown;
          try {
            gateDoc = parse(gateText);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            errors.push(`${gateFile}: parse error: ${message}`);
            gateDoc = undefined;
          }

          if (gateDoc !== undefined) {
            const parsedRubric = rubricSetSchema.safeParse(gateDoc);
            if (!parsedRubric.success) {
              errors.push(
                ...parsedRubric.error.issues.map(
                  (issue) =>
                    `${gateFile}: ${issue.path.join(".")}: ${issue.message}`,
                ),
              );
            } else if (gateKey && !parsedRubric.data.rubrics[gateKey]) {
              errors.push(
                `${workflowFile}: stage ${stage.id} gate rubric missing: ${gateKey}`,
              );
            }
          }
        }
      }
    }

    workflows.push(workflow);
  }

  const policies: Policy[] = [];

  for (const policyFile of pack.policies) {
    const policyPath = path.join(dir, policyFile);
    if (!existsSync(policyPath)) {
      errors.push(`policy file missing: ${policyFile}`);
      continue;
    }

    const text = await readFile(policyPath, "utf8");
    scanSecrets(text, policyFile, errors);

    let doc: unknown;
    try {
      doc = parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${policyFile}: parse error: ${message}`);
      continue;
    }

    const parsedPolicy = policySchema.safeParse(doc);
    if (!parsedPolicy.success) {
      errors.push(
        ...parsedPolicy.error.issues.map(
          (issue) => `${policyFile}: ${issue.path.join(".")}: ${issue.message}`,
        ),
      );
      continue;
    }

    policies.push(parsedPolicy.data);
  }

  if (pack.evals?.rubrics && !existsSync(path.join(dir, pack.evals.rubrics))) {
    errors.push(`evals rubric file missing: ${pack.evals.rubrics}`);
  }

  let autopilot: AutopilotConfig | undefined;
  const autopilotPath = path.join(dir, "autopilot.yaml");
  if (existsSync(autopilotPath)) {
    const text = await readFile(autopilotPath, "utf8");
    scanSecrets(text, "autopilot.yaml", errors);
    try {
      const parsedAutopilot = autopilotSchema.safeParse(parse(text));
      if (!parsedAutopilot.success) {
        errors.push(
          ...parsedAutopilot.error.issues.map(
            (issue) =>
              `autopilot.yaml: ${issue.path.join(".")}: ${issue.message}`,
          ),
        );
      } else {
        autopilot = parsedAutopilot.data;
        for (const schedule of autopilot.schedules) {
          if (!workflowIds.has(schedule.workflow)) {
            errors.push(
              `autopilot.yaml: schedule ${schedule.id} references unknown workflow: ${schedule.workflow}`,
            );
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`autopilot.yaml: parse error: ${message}`);
    }
  }

  if (pack.workspaces) {
    for (const [name, workspace] of Object.entries(pack.workspaces)) {
      for (const agentId of workspace.agents) {
        if (!agents.has(agentId)) {
          errors.push(`workspace ${name} references unknown agent: ${agentId}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, dir, errors };
  }

  return {
    ok: true,
    dir,
    pack,
    agents,
    skills,
    workflows,
    policies,
    autopilot,
    roleRules: getRoleRules(pack),
    warnings,
  };
}

function parseFrontmatter(text: string): unknown {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return undefined;
  }
  return parse(match[1] ?? "");
}

function scanSecrets(text: string, file: string, errors: string[]): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      errors.push(`possible secret in ${file}`);
      return;
    }
  }
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

function satisfiesKitRange(range: string): boolean {
  const current = KIT_VERSION.split(".").map(Number);
  const tokens = range.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return true;
  }

  for (const token of tokens) {
    const match = token.match(/^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!match) {
      return true;
    }

    const operator = match[1] ?? "=";
    const version = [
      Number(match[2] ?? 0),
      Number(match[3] ?? 0),
      Number(match[4] ?? 0),
    ];
    const comparison = compareVersions(current, version);
    const ok =
      operator === ">="
        ? comparison >= 0
        : operator === "<="
          ? comparison <= 0
          : operator === ">"
            ? comparison > 0
            : operator === "<"
              ? comparison < 0
              : comparison === 0;

    if (!ok) {
      return false;
    }
  }

  return true;
}
