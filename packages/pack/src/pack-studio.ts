import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type AgentRole,
  type AutopilotConfig,
  type StageApproval,
  autopilotSchema,
  stageApprovalSchema,
  workflowDefinitionSchema,
} from "@kit/core";
import { KNOWN_TOOL_DEFINITIONS } from "@kit/tools";
import { parse, stringify } from "yaml";
import { type LoadResult, type LoadedPack, loadPack } from "./load-pack";
import { inferAgentRole } from "./role-plan";
import { scanSecrets } from "./security";
import { loadTemplate } from "./templates";

const MAX_FILE_BYTES = 256 * 1024;
const AGENT_ID = /^[a-z][a-z0-9-]*$/;
const WORKFLOW_ID = /^[a-z][a-z0-9-]*$/;
const WORKFLOW_FILE = /^workflows\/[a-z][a-z0-9-]*\.yaml$/;
const ALLOWED_FILES =
  /^(team\.yaml|iteration\.yaml|autopilot\.yaml|README\.md|agents\/[^/]+\.md|workflows\/[^/]+\.yaml|policies\/[^/]+\.yaml|evals\/[^/]+\.yaml|skills\/[^/]+\/SKILL\.md)$/;

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

export async function deleteAgent(
  packDir: string,
  agentId: string,
): Promise<void> {
  if (!AGENT_ID.test(agentId) || agentId === "manager") {
    throw new Error("agent id must match ^[a-z][a-z0-9-]*$ and not be manager");
  }
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  const target = loaded.agents.get(agentId);
  if (!target) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  assertAgentUnreferenced(loaded, agentId);

  const absolute = resolvePackRelative(packDir, target.spec.file);
  if (!absolute || !existsSync(absolute)) {
    throw new Error(`agent file not found: ${target.spec.file}`);
  }
  const teamPath = path.join(loaded.dir, "team.yaml");
  const originalTeam = await readFile(teamPath, "utf8");
  const originalAgent = await readFile(absolute, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  teamDoc.agents = teamDoc.agents.filter((entry) => entry.id !== agentId);
  removeFromWorkspaces(teamDoc, agentId);

  await writePackFile(packDir, "team.yaml", stringify(teamDoc));
  await rm(absolute, { force: true });

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await writeFile(teamPath, originalTeam, "utf8");
    await writeFile(absolute, originalAgent, "utf8");
    throw new Error(validation.errors.join("\n"));
  }
}

export interface CreateManagerInput {
  description?: string;
  model?: string;
  instructions?: string;
}

export async function createManager(
  packDir: string,
  input: CreateManagerInput = {},
): Promise<void> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  if (loaded.pack.manager || loaded.agents.has("manager")) {
    throw new Error("manager already exists");
  }

  const relative = "agents/manager.md";
  const absolute = resolvePackRelative(packDir, relative);
  if (!absolute) {
    throw new Error("invalid manager file");
  }
  if (existsSync(absolute)) {
    throw new Error(`manager file already exists: ${relative}`);
  }

  const teamPath = path.join(loaded.dir, "team.yaml");
  const originalTeam = await readFile(teamPath, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  const model = input.model?.trim() || "deepseek-pro";
  const description =
    input.description?.trim() || "Coordinates the team and handles exceptions";
  teamDoc.manager = {
    agent: relative,
    model,
    budget: { tokens: 16000, costCny: 3, wallClockSeconds: 180 },
  };
  teamDoc.agents.push({
    id: "manager",
    file: relative,
    model,
    role: "manager",
    tools: [],
    skills: [],
  });

  await writePackFile(
    packDir,
    relative,
    agentMarkdown({
      id: "manager",
      description,
      model,
      role: "manager",
      instructions:
        input.instructions?.trim() ||
        "You are the Manager of this team. Review exceptions, explain trade-offs, and ask the operator only when a decision cannot be made from the evidence. Never invent evidence.",
    }),
  );
  await writePackFile(packDir, "team.yaml", stringify(teamDoc));

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await rm(absolute, { force: true }).catch(() => undefined);
    await writeFile(teamPath, originalTeam, "utf8");
    throw new Error(validation.errors.join("\n"));
  }
}

export async function deleteManager(packDir: string): Promise<void> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  const managerFile = loaded.pack.manager?.agent;
  if (!managerFile) {
    throw new Error("manager is not configured");
  }
  const managerAgent = [...loaded.agents.values()].find(
    (entry) => entry.spec.file === managerFile,
  );
  const managerId = managerAgent?.spec.id ?? "manager";
  assertAgentUnreferenced(loaded, managerId);

  const absolute = resolvePackRelative(packDir, managerFile);
  if (!absolute || !existsSync(absolute)) {
    throw new Error(`manager file not found: ${managerFile}`);
  }
  const teamPath = path.join(loaded.dir, "team.yaml");
  const originalTeam = await readFile(teamPath, "utf8");
  const originalAgent = await readFile(absolute, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  Reflect.deleteProperty(teamDoc, "manager");
  teamDoc.agents = teamDoc.agents.filter(
    (entry) => entry.file !== managerFile && entry.id !== managerId,
  );
  removeFromWorkspaces(teamDoc, managerId);

  await writePackFile(packDir, "team.yaml", stringify(teamDoc));
  await rm(absolute, { force: true });

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    await writeFile(teamPath, originalTeam, "utf8");
    await writeFile(absolute, originalAgent, "utf8");
    throw new Error(validation.errors.join("\n"));
  }
}

export async function writeValidatedPackFile(
  packDir: string,
  relative: string,
  content: string,
): Promise<void> {
  const file = resolvePackRelative(packDir, relative);
  if (!file) {
    throw new Error(`file is not editable: ${relative}`);
  }
  const findings: string[] = [];
  scanSecrets(content, relative, findings);
  if (findings.length > 0) {
    throw new Error(findings.join("\n"));
  }
  const hadFile = existsSync(file);
  const original = hadFile ? await readFile(file, "utf8") : "";
  await writePackFile(packDir, relative, content);

  const validation = await loadPack(packDir);
  if (!validation.ok) {
    if (hadFile) {
      await writeFile(file, original, "utf8");
    } else {
      await rm(file, { force: true });
    }
    throw new Error(validation.errors.join("\n"));
  }
}

export async function listEditablePackFiles(
  packDir: string,
): Promise<string[]> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  const files = new Set<string>(["team.yaml", ...loaded.pack.policies]);
  if (existsSync(path.join(loaded.dir, "iteration.yaml"))) {
    files.add("iteration.yaml");
  }
  const skillsDir = path.join(loaded.dir, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relative = `skills/${entry.name}/SKILL.md`;
    if (existsSync(path.join(loaded.dir, relative))) {
      files.add(relative);
    }
  }
  return [...files];
}

export interface PackToolCatalogEntry {
  name: string;
  description: string;
  source: "builtin" | "toolpack";
}

export interface PackCatalog {
  tools: PackToolCatalogEntry[];
  skills: string[];
}

export async function packCatalog(packDir: string): Promise<PackCatalog> {
  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("\n"));
  }
  const tools: PackToolCatalogEntry[] = KNOWN_TOOL_DEFINITIONS.map((tool) => ({
    ...tool,
    source: "builtin",
  }));
  for (const toolPack of loaded.toolPacks) {
    for (const tool of toolPack.tools) {
      tools.push({
        name: tool.name,
        description: tool.description,
        source: "toolpack",
      });
    }
  }
  const skills = new Set<string>(loaded.skills.keys());
  const entries = await readdir(path.join(loaded.dir, "skills"), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      skills.add(entry.name);
    }
  }
  return { tools, skills: [...skills].sort() };
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

export interface StageEdge {
  from: string;
  to: string;
}

/**
 * Rewrites stage dependencies from the canvas edges. Dependencies become
 * explicit `inputFrom`/`inputsFrom` entries and stages are re-ordered
 * topologically, because validation and the runtime both require upstream
 * stages to appear before their dependents.
 */
export async function setStageEdges(
  packDir: string,
  relative: string,
  edges: StageEdge[],
): Promise<string> {
  const raw = await readPackFile(packDir, relative);
  const doc = parse(raw) as {
    stages?: Array<Record<string, unknown>>;
  };
  const stages = doc.stages;
  if (!Array.isArray(stages)) {
    throw new Error("workflow stages missing");
  }

  const stageOrder = new Map<string, number>();
  for (const [index, stage] of stages.entries()) {
    const id = stage.id;
    if (typeof id !== "string" || !id) {
      throw new Error(`workflow stage ${index + 1} is missing an id`);
    }
    if (stageOrder.has(id)) {
      throw new Error(`duplicate workflow stage id: ${id}`);
    }
    stageOrder.set(id, index);
  }

  const dependencies = new Map<string, string[]>();
  for (const id of stageOrder.keys()) {
    dependencies.set(id, []);
  }
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    const from = edge?.from;
    const to = edge?.to;
    if (typeof from !== "string" || typeof to !== "string") {
      throw new Error("every edge needs a from and to stage");
    }
    if (!stageOrder.has(from) || !stageOrder.has(to)) {
      throw new Error(`edge references unknown stage: ${from} -> ${to}`);
    }
    if (from === to) {
      throw new Error(`stage ${to} cannot depend on itself`);
    }
    const key = `${from}->${to}`;
    if (seenEdges.has(key)) {
      throw new Error(`duplicate edge: ${from} -> ${to}`);
    }
    seenEdges.add(key);
    dependencies.get(to)?.push(from);
  }

  // Stable topological sort: the earliest-declared ready stage goes next.
  const ordered: Array<Record<string, unknown>> = [];
  const placed = new Set<string>();
  while (ordered.length < stages.length) {
    const next = stages.find((stage) => {
      const id = stage.id as string;
      return (
        !placed.has(id) &&
        (dependencies.get(id) ?? []).every((upstream) => placed.has(upstream))
      );
    });
    if (!next) {
      const remaining = stages
        .map((stage) => stage.id)
        .filter((id): id is string => typeof id === "string")
        .filter((id) => !placed.has(id));
      throw new Error(`workflow has a cycle: ${remaining.join(", ")}`);
    }
    placed.add(next.id as string);
    ordered.push(next);
  }

  const roots = ordered.filter(
    (stage) => (dependencies.get(stage.id as string) ?? []).length === 0,
  );
  if (roots.length !== 1) {
    // The runtime treats a stage without links as depending on the previous
    // stage, so a graph can only have one real entry point.
    const rootIds = roots.map((stage) => String(stage.id)).join(", ");
    throw new Error(
      `workflow must have exactly one entry stage without upstream links (found: ${rootIds}); connect the extra entry stages to an upstream stage`,
    );
  }

  for (const stage of ordered) {
    const id = stage.id as string;
    const upstreams = [...(dependencies.get(id) ?? [])].sort(
      (left, right) =>
        (stageOrder.get(left) ?? 0) - (stageOrder.get(right) ?? 0),
    );
    stage.inputFrom = undefined;
    stage.inputsFrom = undefined;
    if (upstreams.length === 1) {
      stage.inputFrom = upstreams[0];
    } else if (upstreams.length > 1) {
      stage.inputsFrom = upstreams;
    }
  }
  doc.stages = ordered;

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

export interface StageFieldsUpdate {
  type?: "workflow" | "agent" | "coder";
  agent?: string | null;
  coder?: "dsh" | "codex" | "opencode" | "command" | null;
  goal?: string | null;
  acceptance?: string | null;
  inputs?: string[];
  outputs?: string[];
  timeout?: string | null;
  retry?: { max: number; backoff: "fixed" | "exp" } | null;
  gate?: string | null;
  inputFrom?: string | null;
  inputsFrom?: string[] | null;
  includeInitialInput?: boolean | null;
  revisionAgent?: string | null;
  failureMode?: "fail_open" | "fail_closed" | null;
}

export async function updateStageFields(
  packDir: string,
  relative: string,
  stageId: string,
  update: StageFieldsUpdate,
): Promise<void> {
  const raw = await readPackFile(packDir, relative);
  const doc = parse(raw) as {
    stages?: Array<Record<string, unknown>>;
  };
  const stages = doc.stages;
  if (!Array.isArray(stages)) {
    throw new Error("workflow stages missing");
  }
  const stage = stages.find((item) => item.id === stageId);
  if (!stage) {
    throw new Error(`unknown stage: ${stageId}`);
  }

  const assign = (key: string, value: unknown) => {
    if (value === undefined) {
      return;
    }
    if (value === null || value === "") {
      Reflect.deleteProperty(stage, key);
      return;
    }
    stage[key] = value;
  };

  assign("type", update.type);
  assign("agent", update.agent);
  assign("coder", update.coder);
  assign("goal", update.goal);
  assign("acceptance", update.acceptance);
  assign("inputs", update.inputs);
  assign("outputs", update.outputs);
  assign("timeout", update.timeout);
  assign("retry", update.retry);
  assign("gate", update.gate);
  assign("includeInitialInput", update.includeInitialInput);
  assign("revisionAgent", update.revisionAgent);
  assign("failureMode", update.failureMode);
  if (update.inputsFrom !== undefined) {
    assign("inputsFrom", update.inputsFrom);
    if (update.inputsFrom !== null) {
      Reflect.deleteProperty(stage, "inputFrom");
    }
  }
  if (update.inputFrom !== undefined) {
    assign("inputFrom", update.inputFrom);
    if (update.inputFrom !== null) {
      Reflect.deleteProperty(stage, "inputsFrom");
    }
  }

  const parsed = workflowDefinitionSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
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
  manager?: {
    agent: string;
    model?: string;
    budget?: { tokens?: number; costCny?: number; wallClockSeconds?: number };
  };
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

function removeFromWorkspaces(teamDoc: TeamDoc, agentId: string): void {
  for (const workspace of Object.values(teamDoc.workspaces ?? {})) {
    if (!workspace?.agents) {
      continue;
    }
    workspace.agents = workspace.agents.filter((id) => id !== agentId);
  }
}

function assertAgentUnreferenced(loaded: LoadedPack, agentId: string): void {
  for (const workflow of loaded.workflows) {
    for (const stage of workflow.stages) {
      if (
        stage.agent === agentId ||
        stage.revisionAgent === agentId ||
        stage.coder === agentId
      ) {
        throw new Error(
          `agent ${agentId} is referenced by workflow ${workflow.id} stage ${stage.id}; reassign the stage first`,
        );
      }
    }
  }
  for (const [name, domain] of Object.entries(
    loaded.iteration?.domains ?? {},
  )) {
    if (domain.agent === agentId) {
      throw new Error(
        `agent ${agentId} is referenced by iteration domain ${name}; remove the reference first`,
      );
    }
  }
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
