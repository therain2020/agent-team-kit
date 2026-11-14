import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentRole,
  type AutopilotConfig,
  type StageApproval,
  autopilotSchema,
  stageApprovalSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import { parse, stringify } from "yaml";
import { type LoadResult, loadPack } from "./load-pack";
import { inferAgentRole } from "./role-plan";
import { loadTemplate } from "./templates";

const MAX_FILE_BYTES = 256 * 1024;
const AGENT_ID = /^[a-z][a-z0-9-]*$/;
const WORKFLOW_ID = /^[a-z][a-z0-9-]*$/;
const WORKFLOW_FILE = /^workflows\/[a-z][a-z0-9-]*\.yaml$/;
const ALLOWED_FILES =
  /^(team\.yaml|autopilot\.yaml|README\.md|agents\/[^/]+\.md|workflows\/[^/]+\.yaml|policies\/[^/]+\.yaml|evals\/[^/]+\.yaml|skills\/[^/]+\/SKILL\.md)$/;

export type PackTemplate = string;

export interface CreatePackInput {
  root: string;
  dirName: string;
  name: string;
  description?: string;
  template: PackTemplate;
  managerName?: string;
  managerModel?: string;
  managerInstructions?: string;
  agents?: Array<{
    id: string;
    description: string;
    model?: string;
    role?: AgentRole;
    instructions?: string;
  }>;
}

export interface AgentUpdate {
  description: string;
  model: string;
  role: AgentRole;
  tools: string[];
  skills: string[];
  instructions: string;
  permissions?: { filesystem?: string; network?: string };
}

export interface CreateAgentInput {
  id: string;
  description: string;
  model?: string;
  role?: AgentRole;
  instructions?: string;
  tools?: string[];
  skills?: string[];
}

export interface StudioResult {
  dirName: string;
  name: string;
  dir: string;
}

export function resolvePackRelative(
  packDir: string,
  relative: string,
): string | null {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    !ALLOWED_FILES.test(normalized)
  ) {
    return null;
  }
  const resolved = path.resolve(packDir, normalized);
  const root = path.resolve(packDir);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

export async function readPackFile(
  packDir: string,
  relative: string,
): Promise<string> {
  const file = resolvePackRelative(packDir, relative);
  if (!file || !existsSync(file)) {
    throw new Error(`file not found: ${relative}`);
  }
  return readFile(file, "utf8");
}

export async function writePackFile(
  packDir: string,
  relative: string,
  content: string,
): Promise<void> {
  const file = resolvePackRelative(packDir, relative);
  if (!file) {
    throw new Error(`file is not editable: ${relative}`);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("file exceeds 256KB");
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${Date.now()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

export async function createPack(
  input: CreatePackInput,
): Promise<StudioResult> {
  if (!AGENT_ID.test(input.dirName)) {
    throw new Error("dirName must match ^[a-z][a-z0-9-]*$");
  }
  const dir = path.resolve(input.root, input.dirName);
  if (!dir.startsWith(`${path.resolve(input.root)}${path.sep}`)) {
    throw new Error("invalid pack directory");
  }
  if (existsSync(path.join(dir, "team.yaml"))) {
    throw new Error(`pack already exists: ${input.dirName}`);
  }

  const template = await loadTemplate(input.template);
  const employees = input.agents?.length
    ? input.agents.map((agent, index) => {
        const id = agent.id || `worker-${index + 1}`;
        const description = agent.description || "Team member";
        return {
          id,
          description,
          model:
            agent.model || (index === 0 ? "deepseek-flash" : "deepseek-pro"),
          role: agent.role ?? inferAgentRole(id, description),
          instructions:
            agent.instructions ||
            `You are ${id}. Complete the assigned stage and return a concise, verifiable result.`,
          tools: [] as string[],
          skills: [] as string[],
        };
      })
    : template.agents.map((agent) => ({
        ...agent,
        tools: [...agent.tools],
        skills: [...agent.skills],
      }));

  for (const agent of employees) {
    if (!AGENT_ID.test(agent.id)) {
      throw new Error(`invalid agent id: ${agent.id}`);
    }
  }
  const unique = new Set(employees.map((agent) => agent.id));
  if (unique.size !== employees.length) {
    throw new Error("agent ids must be unique");
  }

  const agentIds = new Set(["manager", ...employees.map((agent) => agent.id)]);
  for (const stage of template.workflow.stages) {
    if (stage.agent && !agentIds.has(stage.agent)) {
      throw new Error(
        `template ${template.id} workflow references unknown agent: ${stage.agent}`,
      );
    }
  }

  const managerModel = input.managerModel || "deepseek-pro";
  const managerName = input.managerName?.trim() || "manager";
  const managerInstructions =
    input.managerInstructions?.trim() ||
    "You are the Manager of this team. Review exceptions, explain trade-offs, and ask the operator only when a decision cannot be made from the evidence. Never invent evidence.";

  const team = {
    apiVersion: "agentteam/v1",
    kind: "TeamPack",
    metadata: {
      name: input.name,
      version: "1.0.0",
      description: input.description || `${input.name} agent team`,
      license: "Apache-2.0",
      compatibility: { kit: ">=0.1 <2.0" },
      topics: ["agent-team-pack", template.id],
    },
    manager: {
      agent: "agents/manager.md",
      model: managerModel,
      budget: { tokens: 16000, costCny: 3, wallClockSeconds: 180 },
    },
    agents: [
      {
        id: "manager",
        file: "agents/manager.md",
        model: managerModel,
        role: "manager",
        tools: [],
        skills: [],
      },
      ...employees.map((agent) => ({
        id: agent.id,
        file: `agents/${agent.id}.md`,
        model: agent.model,
        role: agent.role,
        tools: agent.tools,
        skills: agent.skills,
      })),
    ],
    roles: template.roles,
    workspaces: {
      default: {
        agents: employees.map((agent) => agent.id),
        delivery: "local_file",
      },
    },
    workflows: ["workflows/starter.yaml"],
    policies: ["policies/autonomy.yaml"],
  };

  const workflow = template.workflow;
  const autonomy = template.policy;
  const autopilot = template.autopilot;

  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "workflows"), { recursive: true });
  await mkdir(path.join(dir, "policies"), { recursive: true });
  await writeFile(path.join(dir, "team.yaml"), stringify(team), "utf8");
  await writeFile(
    path.join(dir, "autopilot.yaml"),
    stringify(autopilot),
    "utf8",
  );
  await writeFile(
    path.join(dir, "workflows", "starter.yaml"),
    stringify(workflow),
    "utf8",
  );
  await writeFile(
    path.join(dir, "policies", "autonomy.yaml"),
    stringify(autonomy),
    "utf8",
  );
  await writeFile(
    path.join(dir, "agents", "manager.md"),
    agentMarkdown({
      id: "manager",
      description: "Coordinates the team and handles exceptions",
      model: managerModel,
      role: "manager",
      instructions: managerInstructions,
    }),
    "utf8",
  );
  for (const agent of employees) {
    await writeFile(
      path.join(dir, "agents", `${agent.id}.md`),
      agentMarkdown({
        id: agent.id,
        description: agent.description,
        model: agent.model,
        role: agent.role,
        instructions: agent.instructions,
        tools: agent.tools,
        skills: agent.skills,
      }),
      "utf8",
    );
  }
  await writeFile(
    path.join(dir, "README.md"),
    `# ${input.name}\n\n${input.description || `${input.name} agent team`}\n\nTeam Pack for Agent Team Kit.\n\nNext steps (run from this directory):\n\n\`\`\`bash\nkit pack validate .\nkit pack simulate .\n\`\`\`\n\nOpen the Manager Console, pick this team under /packs, and run it.\n`,
    "utf8",
  );

  const validation = await loadPack(dir);
  if (!validation.ok) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(validation.errors.join("\n"));
  }

  return { dirName: input.dirName, name: input.name, dir };
}

export async function updateAgent(
  packDir: string,
  agentId: string,
  update: AgentUpdate,
): Promise<StudioResult> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }

  const regular = loaded.agents.get(agentId);
  const managerPath = loaded.pack.manager?.agent;
  const isManager = agentId === "manager" && Boolean(managerPath);

  if (!regular && !isManager) {
    throw new Error(`unknown agent: ${agentId}`);
  }

  const file = regular?.spec.file ?? managerPath;
  if (!file) {
    throw new Error(`agent file missing: ${agentId}`);
  }
  const absolute = resolvePackRelative(packDir, file);
  if (!absolute) {
    throw new Error(`agent file outside pack: ${file}`);
  }
  if (!AGENT_ID.test(agentId) && !isManager) {
    throw new Error(`invalid agent id: ${agentId}`);
  }

  const originalAgent = await readFile(absolute, "utf8");
  const originalTeam = await readFile(path.join(packDir, "team.yaml"), "utf8");
  const frontmatter = splitFrontmatter(originalAgent);
  const nextFrontmatter = {
    ...frontmatter.data,
    name: agentId,
    description: update.description,
    model: update.model,
    role: isManager ? "manager" : update.role,
    tools: update.tools,
    skills: update.skills,
    ...(update.permissions ? { permissions: update.permissions } : {}),
  };
  const nextAgent = `---\n${stringify(nextFrontmatter)}---\n\n${update.instructions.trim()}\n`;

  const teamDoc = parseTeamDoc(originalTeam);
  if (isManager && teamDoc.manager) {
    teamDoc.manager.model = update.model;
  }
  const index = teamDoc.agents.findIndex((entry) => entry.id === agentId);
  if (index >= 0) {
    const entry = teamDoc.agents[index];
    if (entry) {
      entry.model = update.model;
      entry.role = isManager ? "manager" : update.role;
      entry.tools = update.tools;
      entry.skills = update.skills;
    }
  }

  await writePackFile(packDir, file, nextAgent);
  await writePackFile(packDir, "team.yaml", stringify(teamDoc));

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await writeFile(absolute, originalAgent, "utf8");
    await writeFile(path.join(packDir, "team.yaml"), originalTeam, "utf8");
    throw new Error(validation.errors.join("\n"));
  }

  return {
    dirName: path.basename(path.resolve(packDir)),
    name: validation.pack.metadata.name,
    dir: path.resolve(packDir),
  };
}

export async function createAgent(
  packDir: string,
  input: CreateAgentInput,
): Promise<void> {
  if (!AGENT_ID.test(input.id) || input.id === "manager") {
    throw new Error("agent id must match ^[a-z][a-z0-9-]*$ and not be manager");
  }
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  if (loaded.agents.has(input.id)) {
    throw new Error(`agent already exists: ${input.id}`);
  }

  const relative = `agents/${input.id}.md`;
  const originalTeam = await readFile(path.join(packDir, "team.yaml"), "utf8");
  const teamDoc = parseTeamDoc(originalTeam);

  const model = input.model || "deepseek-flash";
  teamDoc.agents.push({
    id: input.id,
    file: relative,
    model,
    role: input.role ?? inferAgentRole(input.id, input.description),
    tools: input.tools ?? [],
    skills: input.skills ?? [],
  });

  const workspaces = teamDoc.workspaces;
  const workspaceName = workspaces?.default
    ? "default"
    : Object.keys(workspaces ?? {})[0];
  if (workspaceName) {
    const workspace = workspaces?.[workspaceName];
    if (workspace) {
      workspace.agents = workspace.agents ?? [];
      if (!workspace.agents.includes(input.id)) {
        workspace.agents.push(input.id);
      }
    }
  }

  await writePackFile(
    packDir,
    relative,
    agentMarkdown({
      id: input.id,
      description: input.description,
      model,
      role: input.role ?? inferAgentRole(input.id, input.description),
      instructions:
        input.instructions ||
        `You are ${input.id}. Complete your assigned stage and return a verifiable result.`,
      tools: input.tools,
      skills: input.skills,
    }),
  );
  await writePackFile(packDir, "team.yaml", stringify(teamDoc));

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    const created = resolvePackRelative(packDir, relative);
    if (created) {
      await rm(created, { force: true }).catch(() => undefined);
    }
    await writeFile(path.join(packDir, "team.yaml"), originalTeam, "utf8");
    throw new Error(validation.errors.join("\n"));
  }
}

export async function writeWorkflowFile(
  packDir: string,
  relative: string,
  content: string,
): Promise<void> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  if (!loaded.pack.workflows.includes(relative)) {
    throw new Error(`workflow is not listed in team.yaml: ${relative}`);
  }
  const original = await readPackFile(packDir, relative);
  await writePackFile(packDir, relative, content);
  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await writePackFile(packDir, relative, original);
    throw new Error(validation.errors.join("\n"));
  }
}

export interface WorkflowSummary {
  file: string;
  id: string;
}

export interface CreateWorkflowInput {
  file?: string;
  id?: string;
  content?: string;
}

export interface RenameWorkflowInput {
  file: string;
  newFile: string;
  newId?: string;
}

export async function listWorkflows(
  packDir: string,
): Promise<WorkflowSummary[]> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  return Promise.all(
    loaded.pack.workflows.map(async (file) => {
      const raw = await readFile(path.join(loaded.dir, file), "utf8");
      const doc = parse(raw) as { id?: unknown };
      return {
        file,
        id: typeof doc.id === "string" ? doc.id : file,
      };
    }),
  );
}

export async function createWorkflow(
  packDir: string,
  input: CreateWorkflowInput = {},
): Promise<WorkflowSummary> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  const id = input.id ?? nextWorkflowId(loaded);
  if (!WORKFLOW_ID.test(id)) {
    throw new Error("workflow id must match ^[a-z][a-z0-9-]*$");
  }
  const file = input.file ?? `workflows/${id}.yaml`;
  if (!WORKFLOW_FILE.test(file)) {
    throw new Error("workflow file must be workflows/<id>.yaml");
  }
  if (loaded.pack.workflows.includes(file)) {
    throw new Error(`workflow file already exists: ${file}`);
  }
  if (loaded.workflows.some((workflow) => workflow.id === id)) {
    throw new Error(`workflow id already exists: ${id}`);
  }

  const content =
    input.content ?? stringify(defaultWorkflow(id, firstAgentId(loaded)));
  const parsed = workflowDefinitionSchema.safeParse(parse(content));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  if (parsed.data.id !== id) {
    throw new Error(
      `workflow content id "${parsed.data.id}" does not match "${id}"`,
    );
  }

  const teamPath = path.join(loaded.dir, "team.yaml");
  const originalTeam = await readFile(teamPath, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  teamDoc.workflows = [...(teamDoc.workflows ?? []), file];

  await writePackFile(packDir, file, content);
  await writePackFile(packDir, "team.yaml", stringify(teamDoc));

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    const created = resolvePackRelative(packDir, file);
    if (created) {
      await rm(created, { force: true }).catch(() => undefined);
    }
    await writeFile(teamPath, originalTeam, "utf8");
    throw new Error(validation.errors.join("\n"));
  }

  return { file, id };
}

export async function deleteWorkflow(
  packDir: string,
  file: string,
): Promise<void> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  if (!loaded.pack.workflows.includes(file)) {
    throw new Error(`workflow is not listed in team.yaml: ${file}`);
  }
  if (loaded.pack.workflows.length <= 1) {
    throw new Error("a Pack must keep at least one workflow");
  }
  const absolute = resolvePackRelative(packDir, file);
  if (!absolute || !existsSync(absolute)) {
    throw new Error(`workflow file not found: ${file}`);
  }

  const teamPath = path.join(loaded.dir, "team.yaml");
  const originalTeam = await readFile(teamPath, "utf8");
  const originalContent = await readFile(absolute, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  teamDoc.workflows = (teamDoc.workflows ?? []).filter((item) => item !== file);

  await writePackFile(packDir, "team.yaml", stringify(teamDoc));
  await rm(absolute, { force: true });

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await writeFile(teamPath, originalTeam, "utf8");
    await writeFile(absolute, originalContent, "utf8");
    throw new Error(validation.errors.join("\n"));
  }
}

export async function renameWorkflow(
  packDir: string,
  input: RenameWorkflowInput,
): Promise<WorkflowSummary> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  if (!loaded.pack.workflows.includes(input.file)) {
    throw new Error(`workflow is not listed in team.yaml: ${input.file}`);
  }
  if (!WORKFLOW_FILE.test(input.newFile)) {
    throw new Error("workflow file must be workflows/<id>.yaml");
  }
  if (loaded.pack.workflows.includes(input.newFile)) {
    throw new Error(`workflow file already exists: ${input.newFile}`);
  }
  const oldAbsolute = resolvePackRelative(packDir, input.file);
  const newAbsolute = resolvePackRelative(packDir, input.newFile);
  if (!oldAbsolute || !newAbsolute || !existsSync(oldAbsolute)) {
    throw new Error(`workflow file not found: ${input.file}`);
  }
  if (existsSync(newAbsolute)) {
    throw new Error(`workflow file already exists: ${input.newFile}`);
  }

  const originalContent = await readFile(oldAbsolute, "utf8");
  const doc = parse(originalContent) as Record<string, unknown>;
  const nextId =
    input.newId ?? (typeof doc.id === "string" ? doc.id : input.newFile);
  if (!WORKFLOW_ID.test(nextId)) {
    throw new Error("workflow id must match ^[a-z][a-z0-9-]*$");
  }
  const nextContent = stringify({ ...doc, id: nextId });

  const teamPath = path.join(loaded.dir, "team.yaml");
  const originalTeam = await readFile(teamPath, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  teamDoc.workflows = (teamDoc.workflows ?? []).map((item) =>
    item === input.file ? input.newFile : item,
  );

  await writePackFile(packDir, input.newFile, nextContent);
  await writePackFile(packDir, "team.yaml", stringify(teamDoc));
  await rm(oldAbsolute, { force: true });

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await writeFile(teamPath, originalTeam, "utf8");
    await rm(newAbsolute, { force: true }).catch(() => undefined);
    await writeFile(oldAbsolute, originalContent, "utf8");
    throw new Error(validation.errors.join("\n"));
  }

  return { file: input.newFile, id: nextId };
}

export interface StagePosition {
  x: number;
  y: number;
}

export async function setStagePositions(
  packDir: string,
  relative: string,
  positions: Record<string, StagePosition>,
): Promise<string> {
  const raw = await readPackFile(packDir, relative);
  const doc = parse(raw) as {
    stages?: Array<Record<string, unknown>>;
  };
  const stages = doc.stages;
  if (!Array.isArray(stages)) {
    throw new Error("workflow stages missing");
  }
  for (const [stageId, position] of Object.entries(positions)) {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      throw new Error(`invalid position for stage: ${stageId}`);
    }
    const index = stages.findIndex((stage) => stage.id === stageId);
    const stage = index >= 0 ? stages[index] : undefined;
    if (!stage) {
      continue;
    }
    stage.position = {
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
  }
  const content = stringify(doc);
  await writeWorkflowFile(packDir, relative, content);
  return content;
}

export async function setStageApproval(
  packDir: string,
  relative: string,
  stageId: string,
  approval: Partial<StageApproval> | null,
): Promise<void> {
  const raw = await readPackFile(packDir, relative);
  const doc = parse(raw) as {
    stages?: Array<Record<string, unknown>>;
  };
  const stages = doc.stages;
  if (!Array.isArray(stages)) {
    throw new Error("workflow stages missing");
  }
  const index = stages.findIndex((stage) => stage.id === stageId);
  if (index < 0) {
    throw new Error(`unknown stage: ${stageId}`);
  }
  const stage = stages[index];
  if (!stage) {
    throw new Error(`unknown stage: ${stageId}`);
  }

  if (approval === null) {
    stages[index] = Object.fromEntries(
      Object.entries(stage).filter(([key]) => key !== "approval"),
    );
  } else {
    stage.approval = stageApprovalSchema.parse(approval);
  }

  await writeWorkflowFile(packDir, relative, stringify(doc));
}

export async function writeAutopilotFile(
  packDir: string,
  content: string,
): Promise<AutopilotConfig> {
  const parsed = autopilotSchema.safeParse(parse(content));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  }
  const hadFile = existsSync(path.join(packDir, "autopilot.yaml"));
  const original = hadFile
    ? await readFile(path.join(packDir, "autopilot.yaml"), "utf8")
    : "";
  await writePackFile(packDir, "autopilot.yaml", content);
  const validation = await loadPack(packDir);
  if (!validation.ok) {
    if (hadFile) {
      await writeFile(path.join(packDir, "autopilot.yaml"), original, "utf8");
    } else {
      await rm(path.join(packDir, "autopilot.yaml"), { force: true });
    }
    throw new Error(validation.errors.join("\n"));
  }
  return parsed.data;
}

export async function validatePack(
  packDir: string,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const result: LoadResult = await loadPack(packDir);
  if (!result.ok) {
    return { ok: false, errors: result.errors, warnings: [] };
  }
  return { ok: true, errors: [], warnings: result.warnings };
}

export interface TeamDoc {
  manager?: { model?: string };
  workflows?: string[];
  agents: Array<{
    id: string;
    file: string;
    model?: string;
    role?: AgentRole;
    tools?: string[];
    skills?: string[];
  }>;
  workspaces?: Record<string, { agents?: string[] }>;
  [key: string]: unknown;
}

function parseTeamDoc(text: string): TeamDoc {
  const parsed = parse(text) as Partial<TeamDoc> | null;
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new Error("team.yaml agents must be an array");
  }
  return parsed as TeamDoc;
}

function nextWorkflowId(loaded: {
  workflows: Array<{ id: string }>;
}): string {
  const used = new Set(loaded.workflows.map((workflow) => workflow.id));
  let index = 1;
  while (used.has(`workflow-${index}`)) {
    index += 1;
  }
  return `workflow-${index}`;
}

function firstAgentId(loaded: {
  agents: ReadonlyMap<string, { spec: { id: string }; role: string }>;
}): string {
  for (const agent of loaded.agents.values()) {
    if (agent.role !== "manager") {
      return agent.spec.id;
    }
  }
  return "manager";
}

function defaultWorkflow(id: string, agent: string) {
  return {
    id,
    version: "1.0",
    trigger: { event: "task.received" },
    stages: [
      {
        id: agent,
        type: "agent",
        agent,
        inputs: ["task"],
        outputs: [`${agent}_output`],
        timeout: "15m",
        retry: { max: 1, backoff: "fixed" },
      },
    ],
    delivery: { channel: "local_file" },
  };
}

export function splitFrontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: {}, body: text.trim() };
  }
  const parsed = parse(match[1] ?? "");
  return {
    data:
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {},
    body: text.slice(match[0].length).trim(),
  };
}

function agentMarkdown(input: {
  id: string;
  description: string;
  model: string;
  role: AgentRole;
  instructions: string;
  tools?: string[];
  skills?: string[];
}): string {
  const frontmatter = {
    name: input.id,
    description: input.description,
    model: input.model,
    role: input.role,
    tools: input.tools ?? [],
    skills: input.skills ?? [],
    permissions: { filesystem: "readonly", network: "none" },
  };
  return `---\n${stringify(frontmatter)}---\n\n${input.instructions.trim()}\n`;
}
