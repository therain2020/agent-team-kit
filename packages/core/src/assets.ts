import { z } from "zod";
import { deliverySchema, stageApprovalSchema } from "./workflow";

/**
 * Asset contract for the开放工坊 three-layer split (plan 88 §2, D-69):
 *
 *   components (agent | workflow | toolpack | skillpack)
 *     -> pipeline  (StageSpec graph + component bindings + policies + delivery)
 *       -> pack    (manager / budget / policy / workspace runtime shell)
 *
 * `ComponentRef` pins a component to a repo/commit and a content hash so a
 * pack can be reproduced from its lockfile. `PipelineSpec` is the reusable
 * middle layer that a pack wraps; it may be published and installed on its
 * own. All schemas are additive: manifests without the new fields keep working.
 */

export const COMPONENT_KINDS = [
  "agent",
  "workflow",
  "toolpack",
  "skillpack",
] as const;

export const componentKindSchema = z.enum(COMPONENT_KINDS);

export type ComponentKind = z.infer<typeof componentKindSchema>;

export const ASSET_KINDS = [
  "pack",
  "workflow",
  "agent",
  "toolpack",
  "skillpack",
  "pipeline",
  "source",
  "template",
] as const;

export const assetKindSchema = z.enum(ASSET_KINDS);

export type AssetKind = z.infer<typeof assetKindSchema>;

/**
 * Entry-file convention for the asset kinds added in M3a. Legacy kinds keep
 * their free-form `entry`; these three are fixed so discovery, install and
 * publish agree on a single filename.
 */
export const ASSET_ENTRY: Readonly<Record<string, string>> = Object.freeze({
  pipeline: "pipeline.yaml",
  source: "source.yaml",
  template: "template.yaml",
});

/**
 * Envelope of a `source.yaml` asset. `@kit/source` keeps the adapter-level
 * schema; until the unified market kernel (M1, #115) folds it into the shared
 * core this envelope is enough to reject malformed source entries.
 */
export const sourceAssetSchema = z
  .object({
    apiVersion: z.literal("agentteam/source/v1"),
    kind: z.literal("Source"),
    metadata: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "invalid source name"),
      version: z.string().min(1),
    }),
    spec: z.object({
      type: z.enum(["rss", "json", "github"]),
    }),
  })
  .passthrough();

export type SourceAsset = z.infer<typeof sourceAssetSchema>;

export const COMPONENT_ENV_ROOT = "KIT_COMPONENTS_ROOT";
export const COMPONENT_ENTRY: Readonly<Record<ComponentKind, string>> =
  Object.freeze({
    agent: "agent.md",
    workflow: "workflow.yaml",
    toolpack: "toolpack.yaml",
    skillpack: "skillpack.yaml",
  });

/** Filename of the per-pack assembly lockfile (component refs + bindings). */
export const ASSEMBLY_LOCK_FILE = "components.lock.json";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
// Accept `x.y` as well as `x.y.z` because legacy workflow versions use `1.0`.
const SEMVER_PATTERN = /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

export const componentSourceSchema = z.object({
  /** GitHub `owner/name`, or `local/<id>` for components authored in place. */
  repo: z
    .string()
    .regex(REPO_PATTERN, "repo must be owner/name (or local/<id>)"),
  /** 40-char git commit; local components use a content-derived pseudo-commit. */
  commit: z
    .string()
    .regex(COMMIT_PATTERN, "commit must be a 40-character git sha"),
  /** Optional git ref (branch/tag) that resolved to `commit`. */
  ref: z.string().min(1).optional(),
  /** SHA-256 of the component content, used to detect drift. */
  sha256: z
    .string()
    .regex(SHA256_PATTERN, "sha256 must be a 64-character hex digest"),
});

export type ComponentSource = z.infer<typeof componentSourceSchema>;

export const componentRefSchema = z.object({
  kind: componentKindSchema,
  id: z.string().regex(ID_PATTERN, "component id must be kebab-case"),
  version: z.string().regex(SEMVER_PATTERN, "version must be semver"),
  source: componentSourceSchema,
});

export type ComponentRef = z.infer<typeof componentRefSchema>;

/** Stable `kind/id` key for a component reference. */
export function componentKey(ref: Pick<ComponentRef, "kind" | "id">): string {
  return `${ref.kind}/${ref.id}`;
}

export const pipelineNodeTypeSchema = z.enum([
  "agent",
  "coder",
  "human",
  "subflow",
]);

export type PipelineNodeType = z.infer<typeof pipelineNodeTypeSchema>;

export const pipelineNodeSchema = z
  .object({
    id: z.string().regex(ID_PATTERN, "node id must be kebab-case"),
    type: pipelineNodeTypeSchema,
    /** Inline reference; a binding may supply or override it later. */
    component: componentRefSchema.optional(),
    inputs: z.array(z.string().min(1)).default([]),
    outputs: z.array(z.string().min(1)).default([]),
    gate: z.string().min(1).optional(),
    approval: stageApprovalSchema.optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    description: z.string().default(""),
  })
  .superRefine((node, ctx) => {
    const issue = (message: string, path: Array<string | number>) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (node.type === "human" && node.component) {
      issue("human nodes cannot bind a component", ["component"]);
    }
    if (node.type === "subflow") {
      if (!node.component) {
        issue("subflow node requires a component", ["component"]);
      } else if (node.component.kind !== "workflow") {
        issue("subflow component must be kind workflow", ["component", "kind"]);
      }
    }
    if (
      node.type === "agent" &&
      node.component &&
      node.component.kind !== "agent"
    ) {
      issue("agent node must bind a kind agent component", [
        "component",
        "kind",
      ]);
    }
  });

export type PipelineNode = z.infer<typeof pipelineNodeSchema>;

export const pipelineEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    condition: z.string().min(1).optional(),
  })
  .superRefine((edge, ctx) => {
    if (edge.from === edge.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "edge cannot reference itself",
        path: ["to"],
      });
    }
  });

export type PipelineEdge = z.infer<typeof pipelineEdgeSchema>;

export const pipelineGraphSchema = z
  .object({
    nodes: z.array(pipelineNodeSchema).min(1).max(500),
    edges: z.array(pipelineEdgeSchema).max(2000).default([]),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id: ${node.id}`,
          path: ["nodes", index, "id"],
        });
      }
      ids.add(node.id);
    }

    for (const [index, edge] of graph.edges.entries()) {
      if (!ids.has(edge.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge.from references unknown node: ${edge.from}`,
          path: ["edges", index, "from"],
        });
      }
      if (!ids.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge.to references unknown node: ${edge.to}`,
          path: ["edges", index, "to"],
        });
      }
    }

    if (
      hasCycle(
        graph.nodes.map((node) => node.id),
        graph.edges,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "graph must be acyclic",
        path: ["edges"],
      });
    }
  });

export type PipelineGraph = z.infer<typeof pipelineGraphSchema>;

export const pipelineBindingSchema = z.object({
  node: z.string().min(1),
  component: componentRefSchema,
});

export type PipelineBinding = z.infer<typeof pipelineBindingSchema>;

export const pipelineSpecSchema = z
  .object({
    apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
    kind: z.literal("Pipeline").default("Pipeline"),
    id: z.string().regex(ID_PATTERN, "pipeline id must be kebab-case"),
    name: z.string().min(1).optional(),
    version: z.string().regex(SEMVER_PATTERN, "version must be semver"),
    description: z.string().default(""),
    graph: pipelineGraphSchema,
    bindings: z.array(pipelineBindingSchema).default([]),
    policies: z.array(z.string().min(1)).default([]),
    delivery: deliverySchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const nodesById = new Map(spec.graph.nodes.map((node) => [node.id, node]));
    const bound = new Set<string>();
    for (const [index, binding] of spec.bindings.entries()) {
      const node = nodesById.get(binding.node);
      if (!node) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `binding references unknown node: ${binding.node}`,
          path: ["bindings", index, "node"],
        });
        continue;
      }
      if (bound.has(binding.node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate binding for node: ${binding.node}`,
          path: ["bindings", index, "node"],
        });
      }
      bound.add(binding.node);
      if (node.type === "human") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "human nodes cannot be bound",
          path: ["bindings", index, "node"],
        });
      }
      if (node.type === "subflow" && binding.component.kind !== "workflow") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "subflow nodes require a kind workflow component",
          path: ["bindings", index, "component", "kind"],
        });
      }
      if (node.type === "agent" && binding.component.kind !== "agent") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "agent nodes require a kind agent component",
          path: ["bindings", index, "component", "kind"],
        });
      }
    }
  });

export type PipelineSpec = z.infer<typeof pipelineSpecSchema>;

/**
 * Per-pack lockfile. `components` records the pinned refs (kind/id/version plus
 * repo/commit/sha256); `bindings` records how those refs bind to the pack's or
 * a pipeline's nodes. A component that is only listed here but never bound is
 * not runnable (plan 88 §5 "未绑定组件不参与运行").
 */
export const assemblyLockSchema = z
  .object({
    apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
    kind: z.literal("AssemblyLock").default("AssemblyLock"),
    lockVersion: z.literal(1).default(1),
    pack: z
      .object({
        id: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
      })
      .optional(),
    components: z.array(componentRefSchema).default([]),
    bindings: z.array(pipelineBindingSchema).default([]),
    generatedAt: z.string().min(1).optional(),
  })
  .superRefine((lock, ctx) => {
    const keys = new Set<string>();
    for (const [index, ref] of lock.components.entries()) {
      const key = componentKey(ref);
      if (keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate component in lockfile: ${key}`,
          path: ["components", index],
        });
      }
      keys.add(key);
    }
    const nodes = new Set<string>();
    for (const [index, binding] of lock.bindings.entries()) {
      if (nodes.has(binding.node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate binding for node: ${binding.node}`,
          path: ["bindings", index, "node"],
        });
      }
      nodes.add(binding.node);
      const key = componentKey(binding.component);
      if (!keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `binding references a component that is not locked: ${key}`,
          path: ["bindings", index, "component"],
        });
      }
    }
  });

export type AssemblyLock = z.infer<typeof assemblyLockSchema>;

/** Components that are actually bound to a node (the only runnable ones). */
export function boundComponentKeys(lock: AssemblyLock): string[] {
  return [
    ...new Set(lock.bindings.map((binding) => componentKey(binding.component))),
  ].sort();
}

function hasCycle(nodeIds: string[], edges: PipelineEdge[]): boolean {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    const targets = adjacency.get(edge.from);
    if (targets) {
      targets.push(edge.to);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (visit(next)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const id of nodeIds) {
    if (visit(id)) {
      return true;
    }
  }
  return false;
}
