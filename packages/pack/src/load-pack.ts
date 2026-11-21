import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentFrontmatter,
  type AgentRole,
  type AgentSpec,
  type AutopilotConfig,
  type IterationConfig,
  type Policy,
  type SkillFrontmatter,
  type SkillPack,
  type TeamPack,
  type ToolPack,
  type WorkflowDefinition,
  agentFrontmatterSchema,
  autopilotSchema,
  iterationConfigSchema,
  policySchema,
  rubricSetSchema,
  skillFrontmatterSchema,
  skillPackSchema,
  teamPackSchema,
  toolPackSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import { KNOWN_TOOLS } from "@kit/tools";
import { parse } from "yaml";
import { type RoleRules, getRoleRules, resolveAgentRole } from "./role-plan";
import { scanSecrets } from "./security";

export interface LoadedAgent {
  spec: AgentSpec;
  frontmatter: AgentFrontmatter;
  role: AgentRole;
  /** Instruction body after the frontmatter; scanned by security invariants. */
  instructions: string;
}

export interface LoadedPack {
  pack: TeamPack;
  dir: string;
  agents: Map<string, LoadedAgent>;
  skills: Map<string, SkillFrontmatter>;
  toolPacks: ToolPack[];
  skillPacks: SkillPack[];
  workflows: WorkflowDefinition[];
  policies: Policy[];
  autopilot?: AutopilotConfig;
  iteration?: IterationConfig;
  roleRules: RoleRules;
  warnings: string[];
}

export type LoadResult =
  | ({ ok: true } & LoadedPack)
  | { ok: false; dir: string; errors: string[] };

const KIT_VERSION = "0.9.0";
const MAX_PACK_FILE_BYTES = 256 * 1024;

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

    const agentPath = resolvePackPath(dir, agent.file);
    if (!agentPath) {
      errors.push(`agent file escapes the pack: ${agent.file}`);
      continue;
    }
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
      instructions: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
    });
  }

  if (pack.manager) {
    const managerPath = resolvePackPath(dir, pack.manager.agent);
    if (!managerPath) {
      errors.push(`manager file escapes the pack: ${pack.manager.agent}`);
    } else if (!existsSync(managerPath)) {
      errors.push(`manager agent file missing: ${pack.manager.agent}`);
    }
  }

  const toolPacks: ToolPack[] = [];
  const toolNames = new Set<string>();

  for (const toolpackFile of pack.toolpacks) {
    const toolpackPath = resolvePackPath(dir, toolpackFile);
    if (!toolpackPath) {
      errors.push(`${toolpackFile}: file escapes the pack`);
      continue;
    }
    if (!existsSync(toolpackPath)) {
      errors.push(`toolpack file missing: ${toolpackFile}`);
      continue;
    }

    const text = await readFile(toolpackPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_PACK_FILE_BYTES) {
      errors.push(`${toolpackFile}: file exceeds 256KB`);
      continue;
    }
    scanSecrets(text, toolpackFile, errors);

    let doc: unknown;
    try {
      doc = parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${toolpackFile}: parse error: ${message}`);
      continue;
    }

    const parsedToolPack = toolPackSchema.safeParse(doc);
    if (!parsedToolPack.success) {
      errors.push(
        ...parsedToolPack.error.issues.map(
          (issue) =>
            `${toolpackFile}: ${issue.path.join(".") || "<root>"}: ${issue.message}`,
        ),
      );
      continue;
    }

    for (const tool of parsedToolPack.data.tools) {
      if (KNOWN_TOOLS.includes(tool.name)) {
        errors.push(
          `${toolpackFile}: tool ${tool.name} conflicts with a builtin tool`,
        );
      }
      if (toolNames.has(tool.name)) {
        errors.push(
          `${toolpackFile}: duplicate tool name across packs: ${tool.name}`,
        );
      }
      toolNames.add(tool.name);
      if (tool.adapter === "command") {
        warnings.push(
          `tool ${tool.name}: command tools stay disabled until KIT_TOOLS_ALLOW_COMMAND=1`,
        );
      }
    }

    toolPacks.push(parsedToolPack.data);
  }

  const availableTools = new Set<string>([...KNOWN_TOOLS, ...toolNames]);
  for (const agent of pack.agents) {
    for (const tool of agent.tools) {
      if (!availableTools.has(tool)) {
        errors.push(`agent ${agent.id}: unknown tool: ${tool}`);
      }
    }
  }

  const skills = new Map<string, SkillFrontmatter>();
  const skillPacks: SkillPack[] = [];

  for (const skillpackFile of pack.skillpacks) {
    const skillpackPath = resolvePackPath(dir, skillpackFile);
    if (!skillpackPath) {
      errors.push(`${skillpackFile}: file escapes the pack`);
      continue;
    }
    if (!existsSync(skillpackPath)) {
      errors.push(`skillpack file missing: ${skillpackFile}`);
      continue;
    }

    const text = await readFile(skillpackPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_PACK_FILE_BYTES) {
      errors.push(`${skillpackFile}: file exceeds 256KB`);
      continue;
    }
    scanSecrets(text, skillpackFile, errors);

    let doc: unknown;
    try {
      doc = parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${skillpackFile}: parse error: ${message}`);
      continue;
    }

    const parsedSkillPack = skillPackSchema.safeParse(doc);
    if (!parsedSkillPack.success) {
      errors.push(
        ...parsedSkillPack.error.issues.map(
          (issue) =>
            `${skillpackFile}: ${issue.path.join(".") || "<root>"}: ${issue.message}`,
        ),
      );
      continue;
    }

    const skillPack = parsedSkillPack.data;
    for (const file of skillPack.files) {
      const filePath = resolvePackPath(dir, file);
      if (!filePath) {
        errors.push(`${skillpackFile}: file escapes the pack: ${file}`);
        continue;
      }
      if (!existsSync(filePath)) {
        errors.push(`${skillpackFile}: file missing: ${file}`);
        continue;
      }
      const fileText = await readFile(filePath, "utf8");
      if (Buffer.byteLength(fileText, "utf8") > MAX_PACK_FILE_BYTES) {
        errors.push(`${skillpackFile}: file exceeds 256KB: ${file}`);
        continue;
      }
      scanSecrets(fileText, file, errors);
    }

    const entryPath = resolvePackPath(dir, skillPack.entry);
    if (!entryPath || !existsSync(entryPath)) {
      continue;
    }

    const frontmatter = parseFrontmatter(await readFile(entryPath, "utf8"));
    if (!frontmatter) {
      errors.push(
        `${skillpackFile}: skill frontmatter missing: ${skillPack.entry}`,
      );
      continue;
    }

    const parsedSkill = skillFrontmatterSchema.safeParse(frontmatter);
    if (!parsedSkill.success) {
      errors.push(
        ...parsedSkill.error.issues.map(
          (issue) =>
            `${skillPack.entry}: ${issue.path.join(".")}: ${issue.message}`,
        ),
      );
      continue;
    }

    if (parsedSkill.data.name !== skillPack.name) {
      errors.push(
        `${skillpackFile}: frontmatter name "${parsedSkill.data.name}" does not match skill pack name "${skillPack.name}"`,
      );
    }

    skills.set(skillPack.name, parsedSkill.data);
    skillPacks.push(skillPack);
  }

  for (const agent of pack.agents) {
    for (const skill of agent.skills) {
      if (skills.has(skill)) {
        continue;
      }

      const skillPath = resolvePackPath(
        dir,
        path.join("skills", skill, "SKILL.md"),
      );
      if (!skillPath) {
        errors.push(`skill escapes the pack: ${skill}`);
        continue;
      }
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
    const workflowPath = resolvePackPath(dir, workflowFile);
    if (!workflowPath) {
      errors.push(`${workflowFile}: file escapes the pack`);
      continue;
    }
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
      if (stage.inputFrom && stage.inputsFrom) {
        errors.push(
          `${workflowFile}: stage ${stage.id} cannot use inputFrom and inputsFrom together`,
        );
      }
      for (const upstream of stage.inputsFrom ?? []) {
        if (!seenStageIds.has(upstream)) {
          errors.push(
            `${workflowFile}: stage ${stage.id} inputsFrom must reference an earlier stage: ${upstream}`,
          );
        }
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

      if (stage.type === "coder") {
        if (!stage.coder) {
          errors.push(
            `${workflowFile}: stage ${stage.id} is a coder stage without coder`,
          );
        }
        if (stage.agent && !agents.has(stage.agent)) {
          errors.push(
            `${workflowFile}: stage ${stage.id} references unknown agent for instructions: ${stage.agent}`,
          );
        }
      }

      if (stage.gate) {
        const [gateFileRaw, gateKey] = stage.gate.split("#");
        const gateFile = gateFileRaw ?? "";
        const gatePath = resolvePackPath(dir, gateFile);

        if (!gatePath) {
          errors.push(
            `${workflowFile}: stage ${stage.id} gate file escapes the pack: ${gateFile}`,
          );
        } else if (!existsSync(gatePath)) {
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
    const policyPath = resolvePackPath(dir, policyFile);
    if (!policyPath) {
      errors.push(`policy file escapes the pack: ${policyFile}`);
      continue;
    }
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

  if (pack.evals?.rubrics) {
    const rubricPath = resolvePackPath(dir, pack.evals.rubrics);
    if (!rubricPath) {
      errors.push(`evals rubric file escapes the pack: ${pack.evals.rubrics}`);
    } else if (!existsSync(rubricPath)) {
      errors.push(`evals rubric file missing: ${pack.evals.rubrics}`);
    }
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

  let iteration: IterationConfig | undefined;
  const iterationPath = path.join(dir, "iteration.yaml");
  if (existsSync(iterationPath)) {
    const text = await readFile(iterationPath, "utf8");
    scanSecrets(text, "iteration.yaml", errors);
    try {
      const parsedIteration = iterationConfigSchema.safeParse(parse(text));
      if (!parsedIteration.success) {
        errors.push(
          ...parsedIteration.error.issues.map(
            (issue) =>
              `iteration.yaml: ${issue.path.join(".")}: ${issue.message}`,
          ),
        );
      } else {
        iteration = parsedIteration.data;
        for (const [domain, config] of Object.entries(iteration.domains)) {
          if (!workflowIds.has(config.workflow)) {
            errors.push(
              `iteration.yaml: domain ${domain} references unknown workflow: ${config.workflow}`,
            );
          }
          if (config.agent && !agents.has(config.agent)) {
            errors.push(
              `iteration.yaml: domain ${domain} references unknown agent: ${config.agent}`,
            );
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`iteration.yaml: parse error: ${message}`);
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
    toolPacks,
    skillPacks,
    workflows,
    policies,
    ...(autopilot ? { autopilot } : {}),
    ...(iteration ? { iteration } : {}),
    roleRules: getRoleRules(pack),
    warnings,
  };
}

function resolvePackPath(dir: string, relative: string): string | null {
  const root = path.resolve(dir);
  const target = path.resolve(root, relative);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

function parseFrontmatter(text: string): unknown {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return undefined;
  }
  return parse(match[1] ?? "");
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
