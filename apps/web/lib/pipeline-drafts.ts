import type { ComponentKind, ComponentRef } from "@kit/core";
import type { WorkflowStageDraft } from "./studio-drafts";

/**
 * Editable pipeline assembly draft (94 C-6c+, 88 M3b).
 *
 * The composer produces `values`; the review step lets the operator add,
 * remove, replace and reorder component refs and stage bindings before
 * approval. Everything in this module is pure: transforms return new values
 * and validation only reads them, so review edits never touch disk. The single
 * side-effect entry stays `approvePipelineAssembly` in the Studio, which runs
 * the real assembler and only then writes the workflow.
 */

export interface PipelineComponentOption {
  kind: ComponentKind;
  id: string;
  version: string;
  source: ComponentRef["source"];
  description: string;
  tools: string[];
  toolAdapters: Record<string, "http" | "mcp" | "command">;
  /** Agents a workflow component binds in its stages. */
  workflowAgents: string[];
  /** Version already pinned in the pack lockfile, when bound before. */
  lockedVersion?: string;
}

export interface PipelineComponentDraft {
  ref: ComponentRef;
  description: string;
}

export interface PipelineBindingDraft {
  /** Stage id the component binds to. */
  node: string;
  component: ComponentRef;
}

export type PipelineIssueCode =
  | "component_not_found"
  | "duplicate_component"
  | "version_conflict"
  | "tool_consent_required"
  | "stage_not_found"
  | "duplicate_binding"
  | "binding_component_missing"
  | "component_kind_mismatch"
  | "agent_missing"
  | "agent_not_found"
  | "workflow_agent_missing";

export interface PipelineIssue {
  code: PipelineIssueCode;
  path: string;
  message: string;
}

export interface PipelineDraftValues {
  id: string;
  name: string;
  description: string;
  stages: WorkflowStageDraft[];
  components: PipelineComponentDraft[];
  bindings: PipelineBindingDraft[];
  /** Selections the server rejected when the draft was generated. */
  issues: PipelineIssue[];
}

export interface PipelineEditContext {
  /** Component library snapshot the draft was generated against. */
  library: readonly PipelineComponentOption[];
  /** Team agents that already exist in the pack. */
  teamAgents: readonly string[];
}

export interface PipelineEditValidation {
  issues: PipelineIssue[];
  warnings: string[];
}

export function pipelineComponentKey(
  ref: Pick<ComponentRef, "kind" | "id">,
): string {
  return `${ref.kind}/${ref.id}`;
}

export function pipelineOptionKey(
  option: Pick<PipelineComponentOption, "kind" | "id">,
): string {
  return `${option.kind}/${option.id}`;
}

function cloneRef(ref: ComponentRef): ComponentRef {
  return { ...ref, source: { ...ref.source } };
}

function cloneValues(values: PipelineDraftValues): PipelineDraftValues {
  return {
    ...values,
    stages: values.stages.map((stage) => ({
      ...stage,
      inputs: [...stage.inputs],
      outputs: [...stage.outputs],
      depends: [...stage.depends],
    })),
    components: values.components.map((component) => ({
      ref: cloneRef(component.ref),
      description: component.description,
    })),
    bindings: values.bindings.map((binding) => ({
      node: binding.node,
      component: cloneRef(binding.component),
    })),
    issues: [...values.issues],
  };
}

export function componentDraftFromOption(
  option: PipelineComponentOption,
): PipelineComponentDraft {
  return {
    ref: {
      kind: option.kind,
      id: option.id,
      version: option.version,
      source: { ...option.source },
    },
    description: option.description,
  };
}

function findComponent(
  values: PipelineDraftValues,
  key: string,
): PipelineComponentDraft | undefined {
  return values.components.find(
    (component) => pipelineComponentKey(component.ref) === key,
  );
}

function findStage(
  stages: WorkflowStageDraft[],
  node: string,
): WorkflowStageDraft | undefined {
  return stages.find((stage) => stage.id === node);
}

function setStageAgent(
  stages: WorkflowStageDraft[],
  node: string,
  agent: string | null,
): void {
  const index = stages.findIndex((stage) => stage.id === node);
  const stage = stages[index];
  if (!stage) {
    return;
  }
  stages[index] = {
    ...stage,
    ...(agent ? { agent } : { agent: undefined }),
  };
}

/** Undo a binding's effect: an agent stage must not keep a removed component. */
function clearBindingEffect(
  stages: WorkflowStageDraft[],
  binding: PipelineBindingDraft,
): void {
  if (binding.component.kind !== "agent") {
    return;
  }
  const stage = findStage(stages, binding.node);
  if (stage?.agent === binding.component.id) {
    setStageAgent(stages, binding.node, null);
  }
}

function moveItem<T>(items: T[], index: number, offset: number): void {
  const target = index + offset;
  if (
    index < 0 ||
    index >= items.length ||
    target < 0 ||
    target >= items.length
  ) {
    return;
  }
  const [item] = items.splice(index, 1);
  if (item !== undefined) {
    items.splice(target, 0, item);
  }
}

export function addPipelineComponent(
  values: PipelineDraftValues,
  option: PipelineComponentOption,
): PipelineDraftValues {
  if (findComponent(values, pipelineOptionKey(option))) {
    return values;
  }
  const next = cloneValues(values);
  next.components.push(componentDraftFromOption(option));
  return next;
}

/**
 * Swap the component at `index` for another library entry. Bindings that
 * referenced the old ref follow the rename; agent stages are re-pointed when
 * the replacement is still an agent, and cleared otherwise so validation can
 * name the now-unbound stage instead of leaving a dangling reference.
 */
export function replacePipelineComponent(
  values: PipelineDraftValues,
  index: number,
  option: PipelineComponentOption,
): PipelineDraftValues {
  const current = values.components[index];
  if (!current) {
    return values;
  }
  const nextKey = pipelineOptionKey(option);
  const oldKey = pipelineComponentKey(current.ref);
  if (
    nextKey !== oldKey &&
    values.components.some(
      (component, componentIndex) =>
        componentIndex !== index &&
        pipelineComponentKey(component.ref) === nextKey,
    )
  ) {
    return values;
  }
  const next = cloneValues(values);
  const replacement = componentDraftFromOption(option);
  next.components[index] = replacement;
  for (const binding of next.bindings) {
    if (pipelineComponentKey(binding.component) === oldKey) {
      binding.component = cloneRef(replacement.ref);
    }
  }
  if (current.ref.kind === "agent") {
    // Stages point at an agent either through a binding or directly; re-point
    // every reference to the replacement, or clear it when the replacement is
    // no longer an agent so validation names the unbound stage.
    for (const stage of next.stages) {
      if (stage.agent === current.ref.id) {
        setStageAgent(
          next.stages,
          stage.id,
          replacement.ref.kind === "agent" ? replacement.ref.id : null,
        );
      }
    }
  }
  return next;
}

export function removePipelineComponent(
  values: PipelineDraftValues,
  index: number,
): PipelineDraftValues {
  const current = values.components[index];
  if (!current) {
    return values;
  }
  const key = pipelineComponentKey(current.ref);
  const next = cloneValues(values);
  next.components.splice(index, 1);
  next.bindings = next.bindings.filter((binding) => {
    if (pipelineComponentKey(binding.component) !== key) {
      return true;
    }
    clearBindingEffect(next.stages, binding);
    return false;
  });
  if (current.ref.kind === "agent") {
    for (const stage of next.stages) {
      if (stage.agent === current.ref.id) {
        setStageAgent(next.stages, stage.id, null);
      }
    }
  }
  return next;
}

function canMove(length: number, index: number, offset: number): boolean {
  const target = index + offset;
  return index >= 0 && index < length && target >= 0 && target < length;
}

export function movePipelineComponent(
  values: PipelineDraftValues,
  index: number,
  offset: number,
): PipelineDraftValues {
  if (!canMove(values.components.length, index, offset)) {
    return values;
  }
  const next = cloneValues(values);
  moveItem(next.components, index, offset);
  return next;
}

/**
 * Bind a component to a stage. One binding per stage: re-binding the same node
 * replaces the previous entry instead of stacking duplicates.
 */
export function addPipelineBinding(
  values: PipelineDraftValues,
  node: string,
  componentKey: string,
): PipelineDraftValues {
  const component = findComponent(values, componentKey);
  if (!component) {
    return values;
  }
  const existing = values.bindings.findIndex(
    (binding) => binding.node === node,
  );
  if (existing >= 0) {
    return updatePipelineBinding(values, existing, { componentKey });
  }
  const next = cloneValues(values);
  next.bindings.push({ node, component: cloneRef(component.ref) });
  if (component.ref.kind === "agent") {
    setStageAgent(next.stages, node, component.ref.id);
  }
  return next;
}

export function updatePipelineBinding(
  values: PipelineDraftValues,
  index: number,
  patch: { node?: string; componentKey?: string },
): PipelineDraftValues {
  const current = values.bindings[index];
  if (!current) {
    return values;
  }
  const component =
    patch.componentKey === undefined
      ? findComponent(values, pipelineComponentKey(current.component))
      : findComponent(values, patch.componentKey);
  if (!component) {
    return values;
  }
  const node = patch.node ?? current.node;
  const next = cloneValues(values);
  const row = next.bindings[index];
  if (!row) {
    return values;
  }
  clearBindingEffect(next.stages, row);
  next.bindings = next.bindings.filter((binding, bindingIndex) => {
    if (bindingIndex === index || binding.node !== node) {
      return true;
    }
    // One binding per stage: drop the displaced row and undo its effect too.
    clearBindingEffect(next.stages, binding);
    return false;
  });
  const rowIndex = next.bindings.indexOf(row);
  if (rowIndex < 0) {
    return values;
  }
  next.bindings[rowIndex] = { node, component: cloneRef(component.ref) };
  if (component.ref.kind === "agent") {
    setStageAgent(next.stages, node, component.ref.id);
  }
  return next;
}

export function removePipelineBinding(
  values: PipelineDraftValues,
  index: number,
): PipelineDraftValues {
  const current = values.bindings[index];
  if (!current) {
    return values;
  }
  const next = cloneValues(values);
  const row = next.bindings[index];
  if (row) {
    clearBindingEffect(next.stages, row);
  }
  next.bindings.splice(index, 1);
  return next;
}

export function movePipelineBinding(
  values: PipelineDraftValues,
  index: number,
  offset: number,
): PipelineDraftValues {
  if (!canMove(values.bindings.length, index, offset)) {
    return values;
  }
  const next = cloneValues(values);
  moveItem(next.bindings, index, offset);
  return next;
}

/**
 * Point a stage at a team agent (or clear it). A stage has at most one source
 * of `agent`: the team member or the bound agent component, so any existing
 * binding for the node is dropped.
 */
export function assignPipelineStageAgent(
  values: PipelineDraftValues,
  node: string,
  agent: string | null,
): PipelineDraftValues {
  const next = cloneValues(values);
  const index = next.bindings.findIndex((binding) => binding.node === node);
  const binding = index >= 0 ? next.bindings[index] : undefined;
  if (binding) {
    clearBindingEffect(next.stages, binding);
    next.bindings.splice(index, 1);
  }
  setStageAgent(next.stages, node, agent);
  return next;
}

/** Stages as they will be written: agent bindings are applied to `agent`. */
export function applyPipelineBindings(
  values: PipelineDraftValues,
): WorkflowStageDraft[] {
  const stages = cloneValues(values).stages;
  for (const binding of values.bindings) {
    if (binding.component.kind === "agent") {
      setStageAgent(stages, binding.node, binding.component.id);
    }
  }
  return stages;
}

/** Ordered, de-duplicated component list for the assembler request. */
export function pipelineAssemblyComponents(
  values: PipelineDraftValues,
): Array<{ kind: ComponentKind; id: string }> {
  const seen = new Set<string>();
  const components: Array<{ kind: ComponentKind; id: string }> = [];
  for (const component of values.components) {
    const key = pipelineComponentKey(component.ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    components.push({ kind: component.ref.kind, id: component.ref.id });
  }
  return components;
}

/**
 * Deterministic client-side validation of review edits. It mirrors the
 * composer's selection rules (`validatePipelineDraft`) and the assembler's
 * identity constraints so the operator sees the same rejection before the
 * server runs; the assembler dry-run remains the authoritative check.
 */
export function validatePipelineDraftEdits(
  values: PipelineDraftValues,
  context: PipelineEditContext,
): PipelineEditValidation {
  const issues: PipelineIssue[] = [];
  const warnings: string[] = [];
  // An empty snapshot means the library could not be loaded: membership,
  // version and tool checks cannot run, so they stay with the server dry-run
  // instead of blocking a draft the composer already validated.
  const libraryKnown = context.library.length > 0;
  const libraryByKey = new Map(
    context.library.map((option) => [pipelineOptionKey(option), option]),
  );
  const assembledByKey = new Map(
    values.components.map((component) => [
      pipelineComponentKey(component.ref),
      component,
    ]),
  );
  const assembledAgentIds = new Set(
    values.components
      .filter((component) => component.ref.kind === "agent")
      .map((component) => component.ref.id),
  );
  const knownAgents = new Set([...context.teamAgents, ...assembledAgentIds]);

  const seenComponents = new Set<string>();
  for (const component of values.components) {
    const key = pipelineComponentKey(component.ref);
    if (seenComponents.has(key)) {
      issues.push({
        code: "duplicate_component",
        path: key,
        message: `组件 ${key} 重复，装配请求会被拒绝`,
      });
      continue;
    }
    seenComponents.add(key);
    const option = libraryByKey.get(key);
    if (!option) {
      if (libraryKnown) {
        issues.push({
          code: "component_not_found",
          path: key,
          message: "组件库中不存在该组件",
        });
      }
      continue;
    }
    if (
      option.lockedVersion &&
      option.lockedVersion !== component.ref.version
    ) {
      issues.push({
        code: "version_conflict",
        path: key,
        message: `已锁定 ${option.lockedVersion}，组件库为 ${component.ref.version}`,
      });
    }
    if (
      option.kind === "toolpack" &&
      Object.values(option.toolAdapters).includes("command")
    ) {
      issues.push({
        code: "tool_consent_required",
        path: key,
        message: "工具包包含 command 适配器，需要显式授权后才能装配",
      });
    }
  }

  const boundNodes = new Set<string>();
  for (const binding of values.bindings) {
    const stage = findStage(values.stages, binding.node);
    if (!stage) {
      issues.push({
        code: "stage_not_found",
        path: binding.node,
        message: `阶段 ${binding.node} 不存在`,
      });
      continue;
    }
    const component = assembledByKey.get(
      pipelineComponentKey(binding.component),
    );
    if (!component) {
      issues.push({
        code: "binding_component_missing",
        path: binding.node,
        message: `绑定引用了未装配的组件 ${pipelineComponentKey(binding.component)}`,
      });
    }
    const duplicate = boundNodes.has(binding.node);
    if (duplicate) {
      issues.push({
        code: "duplicate_binding",
        path: binding.node,
        message: `阶段 ${binding.node} 有多个绑定，只允许一个`,
      });
    }
    boundNodes.add(binding.node);
    if (!component || duplicate) {
      continue;
    }
    if (stage.type === "coder") {
      issues.push({
        code: "component_kind_mismatch",
        path: binding.node,
        message: `coder 阶段 ${stage.id} 不能绑定组件`,
      });
      continue;
    }
    const expected = stage.type === "agent" ? "agent" : "workflow";
    if (component.ref.kind !== expected) {
      issues.push({
        code: "component_kind_mismatch",
        path: binding.node,
        message: `阶段 ${stage.id} 是 ${stage.type} 类型，不能绑定 ${component.ref.kind} 组件`,
      });
    }
  }

  for (const stage of values.stages) {
    if (stage.type !== "agent") {
      continue;
    }
    if (!stage.agent) {
      issues.push({
        code: "agent_missing",
        path: stage.id,
        message: `agent 阶段 ${stage.id} 缺少成员绑定`,
      });
      continue;
    }
    if (!knownAgents.has(stage.agent)) {
      issues.push({
        code: "agent_not_found",
        path: stage.id,
        message: `agent 阶段 ${stage.id} 引用了不存在的成员或组件：${stage.agent}`,
      });
    }
  }

  for (const component of values.components) {
    if (component.ref.kind !== "workflow") {
      continue;
    }
    const option = libraryByKey.get(pipelineComponentKey(component.ref));
    const missing = (option?.workflowAgents ?? []).filter(
      (agent) => !knownAgents.has(agent),
    );
    if (missing.length > 0) {
      issues.push({
        code: "workflow_agent_missing",
        path: pipelineComponentKey(component.ref),
        message: `工作流组件引用了不可用的成员：${missing.slice(0, 3).join(", ")}`,
      });
    }
  }

  for (const component of values.components) {
    if (
      component.ref.kind === "toolpack" ||
      component.ref.kind === "skillpack"
    ) {
      continue;
    }
    const key = pipelineComponentKey(component.ref);
    if (
      !values.bindings.some(
        (binding) => pipelineComponentKey(binding.component) === key,
      )
    ) {
      warnings.push(`组件 ${key} 未绑定到任何阶段`);
    }
  }

  return { issues, warnings };
}
