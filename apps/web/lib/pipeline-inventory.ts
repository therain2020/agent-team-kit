import type {
  InvalidPipelineComponent,
  PipelineComponentEntry,
  PipelineInventory,
} from "@kit/job";
import {
  type ComponentSpec,
  buildComponentRef,
  listComponents,
  loadComponent,
  readAssemblyLock,
} from "@kit/workshop";
import { getComponentsRoot } from "./paths";

/**
 * Server-side snapshot of the local component library for the pipeline
 * composer (94 C-6c, 88 M3b).
 *
 * `@kit/job` never reads components itself; the API route loads this snapshot
 * and passes it into `composeJob`. Invalid components are kept in a separate
 * list so the draft can name them in a warning instead of silently selecting
 * something that cannot be assembled.
 */
export async function loadPipelineInventory(
  packDir: string,
): Promise<PipelineInventory> {
  const root = getComponentsRoot();
  const summaries = await listComponents(root);
  const components: PipelineComponentEntry[] = [];
  const invalid: InvalidPipelineComponent[] = [];

  for (const summary of summaries) {
    const loaded = await loadComponent(summary.kind, summary.id, root);
    if (!loaded.ok) {
      invalid.push({
        kind: summary.kind,
        id: summary.id,
        issues: loaded.issues.map(
          (issue) => `${issue.code} ${issue.path}: ${issue.message}`,
        ),
      });
      continue;
    }
    const ref = await buildComponentRef(summary.kind, summary.id, root);
    const spec = loaded.component.spec;
    components.push({
      kind: summary.kind,
      id: summary.id,
      version: ref.version,
      source: ref.source,
      description: describeComponent(spec),
      tools: spec.kind === "agent" ? [...spec.data.tools] : [],
      toolAdapters:
        spec.kind === "toolpack"
          ? Object.fromEntries(
              spec.data.tools.map((tool) => [tool.name, tool.adapter] as const),
            )
          : {},
      workflowAgents:
        spec.kind === "workflow" ? workflowAgents(spec.data.stages) : [],
    });
  }

  const lock = await readAssemblyLock(packDir);
  return {
    components,
    invalid,
    locked: lock.ok ? lock.lock.components : [],
  };
}

function describeComponent(spec: ComponentSpec): string {
  if (spec.kind === "agent") {
    return spec.data.description;
  }
  if (spec.kind === "workflow") {
    return spec.data.id;
  }
  return spec.data.name;
}

function workflowAgents(
  stages: ReadonlyArray<{ agent?: string; revisionAgent?: string }>,
): string[] {
  const ids = new Set<string>();
  for (const stage of stages) {
    if (stage.agent) {
      ids.add(stage.agent);
    }
    if (stage.revisionAgent) {
      ids.add(stage.revisionAgent);
    }
  }
  return [...ids];
}
