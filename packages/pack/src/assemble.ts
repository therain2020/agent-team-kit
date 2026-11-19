import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ASSEMBLY_LOCK_FILE,
  type AgentFrontmatter,
  type AgentRole,
  type AssemblyLock,
  type ComponentKind,
  type ComponentRef,
  type PackTool,
  type SkillPack,
  type ToolPack,
  type WorkflowDefinition,
  componentKey,
} from "@kit/core";
import { KNOWN_TOOLS } from "@kit/tools";
import { parse, stringify } from "yaml";
import { loadPack } from "./load-pack";
import {
  type RoleRules,
  inferAgentRole,
  rolePlanForAgents,
  validateRolePlan,
} from "./role-plan";

/**
 * Component assembler (plan 88 §3.1 / §6.1 M3b, D-69).
 *
 * Binds validated components from a component library (agent / workflow /
 * toolpack / skillpack) into a host pack. The assembler is deliberately
 * component-source agnostic: component resolution and lockfile IO are provided
 * through the {@link ComponentLibrary} port so `@kit/pack` never imports
 * `@kit/workshop` (which depends on `@kit/pack`). `@kit/workshop` supplies the
 * production adapter; tests supply fixtures.
 *
 * Guarantees:
 *   - Every resolved component is validated before anything is written.
 *   - Writes are staged (temp file + rename) and validated with `loadPack`;
 *     any failure restores every touched file, so no half-written pack remains.
 *   - Bindings are recorded in `components.lock.json`; re-running the same
 *     assembly is idempotent, a changed version/hash is an explicit conflict.
 */

export interface ComponentLibraryIssue {
  code: string;
  path: string;
  message: string;
}

export type AssemblyComponentSpec =
  | { kind: "agent"; data: AgentFrontmatter }
  | { kind: "workflow"; data: WorkflowDefinition }
  | { kind: "toolpack"; data: ToolPack }
  | { kind: "skillpack"; data: SkillPack };

export interface ResolvedComponent {
  kind: ComponentKind;
  id: string;
  version: string;
  ref: ComponentRef;
  spec: AssemblyComponentSpec;
  /** Raw entry file text (agent markdown / workflow|toolpack|skillpack yaml). */
  entryText: string;
  /** Supporting files relative to the component root (skillpacks only). */
  files: Array<{ path: string; content: string }>;
}

export type ResolveComponentResult =
  | { ok: true; component: ResolvedComponent }
  | { ok: false; issues: ComponentLibraryIssue[] };

export interface LockReadResult {
  ok: boolean;
  lock: AssemblyLock;
  issues: ComponentLibraryIssue[];
}

export interface LockWriteResult {
  ok: boolean;
  issues: ComponentLibraryIssue[];
}

/**
 * Dependency-inversion port over the component library and its lockfile. The
 * production implementation lives in `@kit/workshop`; the assembler itself
 * only needs these three operations.
 */
export interface ComponentLibrary {
  resolve(kind: ComponentKind, id: string): Promise<ResolveComponentResult>;
  readLock(packDir: string): Promise<LockReadResult>;
  writeLock(packDir: string, lock: AssemblyLock): Promise<LockWriteResult>;
}

export interface ComponentRequest {
  kind: ComponentKind;
  id: string;
}

export interface AssembleInput {
  packDir: string;
  components: ComponentRequest[];
  /** Allow toolpacks that ship `command` adapters (explicit consent). */
  allowCommand?: boolean;
}

export interface AssemblyBinding {
  /** Binding slot key: `kind/id` (unique per assembled component). */
  node: string;
  component: ComponentRef;
}

export interface AssemblyResult {
  packDir: string;
  lockPath: string;
  bindings: AssemblyBinding[];
  /** Pack-relative files written by this run (empty when idempotent no-op). */
  written: string[];
  warnings: string[];
  /** True when the assembly was already fully applied. */
  noop: boolean;
  lock: AssemblyLock;
}

/** Thrown with a structured issue list; nothing is written on this error. */
export class AssemblyError extends Error {
  readonly issues: ComponentLibraryIssue[];
  readonly warnings: string[];

  constructor(
    message: string,
    issues: ComponentLibraryIssue[] = [],
    warnings: string[] = [],
  ) {
    super(message);
    this.name = "AssemblyError";
    this.issues = issues;
    this.warnings = warnings;
  }
}

interface TeamDoc {
  manager?: { agent: string; model?: string };
  workflows?: string[];
  agents: Array<{
    id: string;
    file: string;
    model?: string;
    role?: string;
    tools?: string[];
    skills?: string[];
  }>;
  workspaces?: Record<string, { agents?: string[] }>;
  toolpacks?: string[];
  skillpacks?: string[];
  [key: string]: unknown;
}

interface Snapshot {
  absolute: string;
  existed: boolean;
  content: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function assembleComponents(
  input: AssembleInput,
  library: ComponentLibrary,
): Promise<AssemblyResult> {
  const packDir = path.resolve(input.packDir);
  const issues: ComponentLibraryIssue[] = [];
  const warnings: string[] = [];

  const loaded = await loadPack(packDir);
  if (!loaded.ok) {
    throw new AssemblyError(
      "pack is invalid before assembly",
      loaded.errors.map((message) => ({
        code: "pack_invalid",
        path: ".",
        message,
      })),
    );
  }

  if (input.components.length === 0) {
    throw new AssemblyError("no components requested", [
      { code: "empty_request", path: ".", message: "no components requested" },
    ]);
  }

  // Reject duplicate components within a single request up front.
  const requested = new Set<string>();
  for (const request of input.components) {
    if (!ID_PATTERN.test(request.id)) {
      issues.push({
        code: "component_id_invalid",
        path: componentKey(request),
        message: `invalid component id: ${request.id}`,
      });
      continue;
    }
    const key = componentKey(request);
    if (requested.has(key)) {
      issues.push({
        code: "duplicate_request",
        path: key,
        message: `component requested twice in one assembly: ${key}`,
      });
    }
    requested.add(key);
  }
  if (issues.length > 0) {
    throw new AssemblyError("invalid assembly request", issues);
  }

  // Resolve every component first; an unresolvable component aborts the run.
  const resolved: ResolvedComponent[] = [];
  for (const request of input.components) {
    const result = await library.resolve(request.kind, request.id);
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({
          code: issue.code,
          path: `${componentKey(request)}/${issue.path}`,
          message: issue.message,
        });
      }
      continue;
    }
    resolved.push(result.component);
  }
  if (issues.length > 0) {
    throw new AssemblyError("one or more components are invalid", issues);
  }

  const lockRead = await library.readLock(packDir);
  if (!lockRead.ok) {
    throw new AssemblyError("existing lockfile is invalid", lockRead.issues);
  }
  const lock = lockRead.lock;
  const lockPath = path.join(packDir, ASSEMBLY_LOCK_FILE);
  const lockExisted = existsSync(lockPath);

  // Version / duplicate-binding guards before touching any state.
  const lockedByKey = new Map(
    lock.components.map((ref) => [componentKey(ref), ref] as const),
  );
  for (const component of resolved) {
    const key = componentKey(component);
    const prior = lockedByKey.get(key);
    if (
      prior &&
      (prior.version !== component.ref.version ||
        prior.source.sha256 !== component.ref.source.sha256 ||
        prior.source.commit !== component.ref.source.commit)
    ) {
      issues.push({
        code: "version_conflict",
        path: key,
        message: `${key} is locked at ${prior.version} (${prior.source.sha256.slice(
          0,
          12,
        )}) but ${component.ref.version} (${component.ref.source.sha256.slice(
          0,
          12,
        )}) was requested; unbind it first to change the version`,
      });
    }
  }
  if (issues.length > 0) {
    throw new AssemblyError("component version conflict", issues);
  }

  // ---- Build the in-memory catalog that the assembled pack will expose. ----
  const availableTools = new Set<string>(KNOWN_TOOLS);
  const toolDefs = new Map<string, PackTool>();
  for (const toolPack of loaded.toolPacks) {
    for (const tool of toolPack.tools) {
      availableTools.add(tool.name);
      toolDefs.set(tool.name, tool);
    }
  }
  const availableSkills = new Set<string>(loaded.skills.keys());
  const agentIds = new Set<string>(loaded.agents.keys());
  const workflowIds = new Set(loaded.workflows.map((workflow) => workflow.id));

  // Pre-pass: toolpacks and skillpacks expand the available catalog so agents
  // and workflows from the same assembly can reference them regardless of
  // request order.
  for (const component of resolved) {
    if (component.spec.kind !== "toolpack") {
      continue;
    }
    const key = componentKey(component);
    // Already locked => its tools are already in the pack catalog; re-running
    // the same assembly must not re-add them or report a conflict.
    if (lockedByKey.has(key)) {
      continue;
    }
    for (const tool of component.spec.data.tools) {
      if (KNOWN_TOOLS.includes(tool.name)) {
        issues.push({
          code: "tool_conflict",
          path: key,
          message: `tool ${tool.name} conflicts with a builtin tool`,
        });
        continue;
      }
      if (availableTools.has(tool.name)) {
        issues.push({
          code: "tool_conflict",
          path: key,
          message: `duplicate tool name across components: ${tool.name}`,
        });
        continue;
      }
      if (tool.adapter === "command" && input.allowCommand !== true) {
        issues.push({
          code: "command_tool_consent",
          path: key,
          message: `tool ${tool.name} is a command tool; pass allowCommand to bind it`,
        });
        continue;
      }
      availableTools.add(tool.name);
      toolDefs.set(tool.name, tool);
    }
  }

  for (const component of resolved) {
    if (component.spec.kind !== "skillpack") {
      continue;
    }
    const key = componentKey(component);
    if (lockedByKey.has(key)) {
      continue;
    }
    if (availableSkills.has(component.spec.data.name)) {
      issues.push({
        code: "skill_conflict",
        path: key,
        message: `skill ${component.spec.data.name} already exists in the pack`,
      });
      continue;
    }
    availableSkills.add(component.spec.data.name);
  }

  // Agents: validate role, tools, skills and permissions against the catalog.
  const newAgents: Array<{
    id: string;
    spec: AgentFrontmatter;
    component: ResolvedComponent;
  }> = [];
  for (const component of resolved) {
    if (component.spec.kind !== "agent") {
      continue;
    }
    const key = componentKey(component);
    const agent = component.spec.data;
    const role = agent.role ?? inferAgentRole(component.id, agent.description);
    if (component.id === "manager" || role === "manager") {
      issues.push({
        code: "manager_component",
        path: key,
        message:
          "manager agents are pack-level; they cannot be bound as components",
      });
      continue;
    }
    const relative = `agents/${component.id}.md`;
    const prior = lockedByKey.get(key);
    if (
      !prior &&
      (agentIds.has(component.id) || existsSync(packPath(packDir, relative)))
    ) {
      issues.push({
        code: "agent_exists",
        path: key,
        message: `agent ${component.id} already exists in the pack`,
      });
      continue;
    }
    for (const tool of agent.tools) {
      if (!availableTools.has(tool)) {
        issues.push({
          code: "unknown_tool",
          path: key,
          message: `agent ${component.id} references unknown tool: ${tool}`,
        });
        continue;
      }
      const definition = toolDefs.get(tool);
      if (
        definition &&
        (definition.adapter === "http" || definition.adapter === "mcp") &&
        agent.permissions?.network === "none"
      ) {
        issues.push({
          code: "permission_conflict",
          path: key,
          message: `agent ${component.id} uses network tool ${tool} but declares permissions.network: none`,
        });
      }
      if (definition?.adapter === "command" && input.allowCommand !== true) {
        issues.push({
          code: "command_tool_consent",
          path: key,
          message: `agent ${component.id} uses command tool ${tool}; pass allowCommand to bind it`,
        });
      }
    }
    for (const skill of agent.skills) {
      if (!availableSkills.has(skill)) {
        issues.push({
          code: "unknown_skill",
          path: key,
          message: `agent ${component.id} references unknown skill: ${skill}`,
        });
      }
    }
    agentIds.add(component.id);
    newAgents.push({ id: component.id, spec: agent, component });
  }

  // Workflows: every referenced agent must exist after assembly.
  for (const component of resolved) {
    if (component.spec.kind !== "workflow") {
      continue;
    }
    const key = componentKey(component);
    const workflow = component.spec.data;
    const relative = `workflows/${component.id}.yaml`;
    const prior = lockedByKey.get(key);
    if (
      !prior &&
      (workflowIds.has(workflow.id) || existsSync(packPath(packDir, relative)))
    ) {
      issues.push({
        code: "workflow_exists",
        path: key,
        message: `workflow ${workflow.id} already exists in the pack`,
      });
      continue;
    }
    for (const stage of workflow.stages) {
      if (
        stage.type === "agent" &&
        (!stage.agent || !agentIds.has(stage.agent))
      ) {
        issues.push({
          code: "unknown_agent",
          path: key,
          message: `workflow ${workflow.id} stage ${stage.id} references unknown agent: ${
            stage.agent ?? "<none>"
          }`,
        });
      }
      if (stage.revisionAgent && !agentIds.has(stage.revisionAgent)) {
        issues.push({
          code: "unknown_agent",
          path: key,
          message: `workflow ${workflow.id} stage ${stage.id} revisionAgent references unknown agent: ${stage.revisionAgent}`,
        });
      }
      if (stage.type === "coder" && stage.agent && !agentIds.has(stage.agent)) {
        issues.push({
          code: "unknown_agent",
          path: key,
          message: `workflow ${workflow.id} stage ${stage.id} references unknown agent: ${stage.agent}`,
        });
      }
    }
    workflowIds.add(workflow.id);
  }

  // Role rules: incremental assemblies must not violate the pack's role plan.
  const roles = roleRulesOf(loaded.pack);
  const roleErrors = checkRoleRules(loaded.agents, newAgents, roles);
  for (const error of roleErrors.errors) {
    issues.push({ code: "role_rule", path: ".", message: error });
  }
  warnings.push(...roleErrors.warnings);

  if (issues.length > 0) {
    const summary = issues
      .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
      .join("; ");
    throw new AssemblyError(`assembly rejected: ${summary}`, issues, warnings);
  }

  // ---- Plan the writes. ----
  const teamYamlPath = path.join(packDir, "team.yaml");
  const originalTeam = await readFile(teamYamlPath, "utf8");
  const teamDoc = parseTeamDoc(originalTeam);
  let teamChanged = false;

  const writes: Array<{ relative: string; content: string }> = [];
  const bindings: AssemblyBinding[] = [];
  const nextComponents = [...lock.components];
  const nextBindings = [...lock.bindings];
  const boundNodes = new Set(lock.bindings.map((binding) => binding.node));

  const recordRef = (component: ResolvedComponent) => {
    const key = componentKey(component);
    if (!nextComponents.some((ref) => componentKey(ref) === key)) {
      nextComponents.push(component.ref);
    }
    const node = key;
    if (!boundNodes.has(node)) {
      nextBindings.push({ node, component: component.ref });
      boundNodes.add(node);
    }
    bindings.push({ node, component: component.ref });
  };

  // Toolpacks.
  for (const component of resolved) {
    if (component.spec.kind !== "toolpack") {
      continue;
    }
    const relative = `toolpacks/${component.id}.yaml`;
    writes.push({ relative, content: component.entryText });
    teamDoc.toolpacks ??= [];
    const list = teamDoc.toolpacks;
    if (!list.includes(relative)) {
      list.push(relative);
      teamChanged = true;
    }
    recordRef(component);
  }

  // Skillpacks: rewrite manifest paths under skillpacks/<id>/.
  for (const component of resolved) {
    if (component.spec.kind !== "skillpack") {
      continue;
    }
    const base = `skillpacks/${component.id}`;
    const rewritten = {
      ...component.spec.data,
      entry: `${base}/${component.spec.data.entry}`,
      files: component.spec.data.files.map((file) => `${base}/${file}`),
    };
    writes.push({
      relative: `${base}/skillpack.yaml`,
      content: stringify(rewritten),
    });
    for (const file of component.files) {
      writes.push({ relative: `${base}/${file.path}`, content: file.content });
    }
    teamDoc.skillpacks ??= [];
    const list = teamDoc.skillpacks;
    if (!list.includes(`${base}/skillpack.yaml`)) {
      list.push(`${base}/skillpack.yaml`);
      teamChanged = true;
    }
    recordRef(component);
  }

  // Agents: preserve the component's frontmatter and instructions verbatim.
  for (const { id, spec, component } of newAgents) {
    const relative = `agents/${id}.md`;
    writes.push({ relative, content: component.entryText });
    if (!teamDoc.agents.some((entry) => entry.id === id)) {
      teamDoc.agents.push({
        id,
        file: relative,
        model: spec.model,
        ...(spec.role ? { role: spec.role } : {}),
        tools: [...spec.tools],
        skills: [...spec.skills],
      });
      addToDefaultWorkspace(teamDoc, id);
      teamChanged = true;
    }
    recordRef(component);
  }

  // Workflows.
  for (const component of resolved) {
    if (component.spec.kind !== "workflow") {
      continue;
    }
    const relative = `workflows/${component.id}.yaml`;
    writes.push({ relative, content: stringify(component.spec.data) });
    teamDoc.workflows ??= [];
    const list = teamDoc.workflows;
    if (!list.includes(relative)) {
      list.push(relative);
      teamChanged = true;
    }
    recordRef(component);
  }

  // Strip writes whose content already matches disk (idempotent re-run).
  const effectiveWrites: Array<{
    relative: string;
    absolute: string;
    content: string;
  }> = [];
  for (const write of writes) {
    const absolute = packPath(packDir, write.relative);
    if (existsSync(absolute)) {
      const current = await readFile(absolute, "utf8");
      if (current === write.content) {
        continue;
      }
    }
    effectiveWrites.push({ ...write, absolute });
  }

  const nextTeamText = stringify(teamDoc);
  const lockChanged =
    !lockExisted ||
    nextComponents.length !== lock.components.length ||
    nextBindings.length !== lock.bindings.length;

  if (effectiveWrites.length === 0 && !teamChanged && !lockChanged) {
    return {
      packDir,
      lockPath,
      bindings,
      written: [],
      warnings,
      noop: true,
      lock,
    };
  }

  const nextLock = buildLock(lock, packDir, nextComponents, nextBindings);

  // ---- Apply atomically with rollback. ----
  const snapshots: Snapshot[] = [];
  const createdDirs: string[] = [];
  const remember = async (absolute: string) => {
    const existed = existsSync(absolute);
    snapshots.push({
      absolute,
      existed,
      content: existed ? await readFile(absolute, "utf8") : "",
    });
  };

  try {
    await remember(teamYamlPath);
    for (const write of effectiveWrites) {
      await remember(write.absolute);
      const dir = path.dirname(write.absolute);
      if (!existsSync(dir)) {
        createdDirs.push(dir);
      }
    }

    for (const write of effectiveWrites) {
      await writeFileAtomic(write.absolute, write.content);
    }
    if (teamChanged) {
      await writeFileAtomic(teamYamlPath, nextTeamText);
    }
    const lockWrite = await library.writeLock(packDir, nextLock);
    if (!lockWrite.ok) {
      throw new AssemblyError("failed to write lockfile", lockWrite.issues);
    }

    const validation = await loadPack(packDir);
    if (!validation.ok) {
      throw new AssemblyError(
        "assembled pack failed validation",
        validation.errors.map((message) => ({
          code: "pack_invalid",
          path: ".",
          message,
        })),
        warnings,
      );
    }
  } catch (error) {
    await rollback(snapshots, createdDirs, {
      lockPath,
      lockExisted,
      originalLock: lock,
      library,
      packDir,
    });
    if (error instanceof AssemblyError) {
      throw error;
    }
    throw new AssemblyError(
      `assembly failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    packDir,
    lockPath,
    bindings,
    written: effectiveWrites.map((write) => write.relative),
    warnings,
    noop: false,
    lock: nextLock,
  };
}

interface RollbackState {
  lockPath: string;
  lockExisted: boolean;
  originalLock: AssemblyLock;
  library: ComponentLibrary;
  packDir: string;
}

async function rollback(
  snapshots: Snapshot[],
  createdDirs: string[],
  state: RollbackState,
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.existed) {
        await writeFileAtomic(snapshot.absolute, snapshot.content);
      } else {
        await rm(snapshot.absolute, { force: true });
      }
    } catch {
      // Best effort: keep restoring the rest so the pack is not left partial.
    }
  }
  try {
    if (state.lockExisted) {
      await state.library.writeLock(state.packDir, state.originalLock);
    } else {
      await rm(state.lockPath, { force: true });
    }
  } catch {
    // Best effort as above.
  }
  for (const dir of [...new Set(createdDirs)].sort(
    (left, right) => right.length - left.length,
  )) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore: an unrelated leftover directory is preferable to data loss.
    }
  }
}

function buildLock(
  base: AssemblyLock,
  packDir: string,
  components: ComponentRef[],
  bindings: Array<{ node: string; component: ComponentRef }>,
): AssemblyLock {
  return {
    ...base,
    pack: { ...base.pack, id: path.basename(path.resolve(packDir)) },
    components: [...components].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
    ),
    bindings: [...bindings].sort((left, right) =>
      left.node.localeCompare(right.node),
    ),
    generatedAt: new Date().toISOString(),
  };
}

function checkRoleRules(
  existing: ReadonlyMap<string, { role: AgentRole }>,
  newAgents: Array<{ id: string; spec: AgentFrontmatter }>,
  roles: RoleRules,
): { errors: string[]; warnings: string[] } {
  const agents = new Map<string, { role: AgentRole }>();
  for (const [id, agent] of existing) {
    agents.set(id, { role: agent.role });
  }
  for (const { id, spec } of newAgents) {
    agents.set(id, { role: spec.role ?? inferAgentRole(id, spec.description) });
  }
  const plan = rolePlanForAgents(agents, roles.allowCombined);
  const problems = validateRolePlan({
    agents,
    rules: roles,
    sellers: plan.sellers,
    builders: plan.builders,
    specialists: plan.specialists,
    allowCombined: roles.allowCombined,
  });
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const problem of problems) {
    if (problem.startsWith("this Pack requires")) {
      warnings.push(problem);
    } else {
      errors.push(problem);
    }
  }
  return { errors, warnings };
}

function roleRulesOf(pack: { roles?: Partial<RoleRules> }): RoleRules {
  return {
    requireSeller: pack.roles?.requireSeller ?? false,
    requireBuilder: pack.roles?.requireBuilder ?? true,
    allowCombined: pack.roles?.allowCombined ?? true,
  };
}

function addToDefaultWorkspace(teamDoc: TeamDoc, id: string): void {
  const workspaces = teamDoc.workspaces;
  if (!workspaces) {
    return;
  }
  const name = workspaces.default ? "default" : Object.keys(workspaces)[0];
  if (!name) {
    return;
  }
  const workspace = workspaces[name];
  if (!workspace) {
    return;
  }
  workspace.agents ??= [];
  if (!workspace.agents.includes(id)) {
    workspace.agents.push(id);
  }
}

function parseTeamDoc(text: string): TeamDoc {
  const parsed = parse(text) as Partial<TeamDoc> | null;
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new AssemblyError("team.yaml agents must be an array", [
      {
        code: "team_invalid",
        path: "team.yaml",
        message: "agents must be an array",
      },
    ]);
  }
  return parsed as TeamDoc;
}

function packPath(packDir: string, relative: string): string {
  const root = path.resolve(packDir);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new AssemblyError(`unsafe pack path: ${relative}`, [
      { code: "unsafe_path", path: relative, message: "path escapes the pack" },
    ]);
  }
  return target;
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}
