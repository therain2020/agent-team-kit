/**
 * Validation for workflow stage graphs produced by the AI composer.
 *
 * A pack workflow is ordered (the runtime resolves `inputFrom`/`inputsFrom`
 * against earlier stages only), so a draft must be a single-entry DAG whose
 * upstream stages appear before their dependents. Compose rejects anything
 * else and falls back to a safe linear draft instead of writing a workflow
 * that cannot run.
 */

export const STAGE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const STAGE_TYPES = ["workflow", "agent", "coder"] as const;
export const STAGE_CODERS = ["dsh", "codex", "opencode", "command"] as const;

export type DraftStageType = (typeof STAGE_TYPES)[number];
export type DraftStageCoder = (typeof STAGE_CODERS)[number];

export interface DraftStageApproval {
  mode: "required" | "auto" | "never";
  position: "before" | "after";
  riskClass: "low" | "medium" | "high";
  ttl: string;
  autoApproveWhen?: { maxRunCostCny?: number };
}

export interface DraftStage {
  id: string;
  type: DraftStageType;
  agent?: string;
  coder?: DraftStageCoder;
  goal?: string;
  acceptance?: string;
  inputs: string[];
  outputs: string[];
  timeout?: string;
  retry?: { max: number; backoff: "fixed" | "exp" };
  gate?: string;
  /** Upstream stage ids; serialized to inputFrom/inputsFrom on save. */
  depends: string[];
  includeInitialInput?: boolean;
  revisionAgent?: string;
  approval?: DraftStageApproval | null;
}

export interface StageGraphValidation {
  ok: boolean;
  errors: string[];
}

export function validateStageGraph(
  stages: readonly DraftStage[],
  agentIds: Iterable<string>,
): StageGraphValidation {
  const errors: string[] = [];
  if (stages.length === 0) {
    return { ok: false, errors: ["stages must contain at least one stage"] };
  }

  const agents = new Set(agentIds);
  const seen = new Map<string, number>();

  stages.forEach((stage, index) => {
    if (!STAGE_ID_PATTERN.test(stage.id)) {
      errors.push(
        `stage ${index + 1} id "${stage.id}" must be a slug (^[a-z][a-z0-9-]*$)`,
      );
    }
    if (seen.has(stage.id)) {
      errors.push(`duplicate stage id: ${stage.id}`);
    }
    seen.set(stage.id, index);

    if (stage.inputs.length === 0) {
      errors.push(`stage ${stage.id} needs at least one input`);
    }
    if (stage.outputs.length === 0) {
      errors.push(`stage ${stage.id} needs at least one output`);
    }

    if (stage.type === "agent") {
      if (!stage.agent) {
        errors.push(`agent stage ${stage.id} requires an agent binding`);
      } else if (!agents.has(stage.agent)) {
        errors.push(
          `stage ${stage.id} references unknown agent: ${stage.agent}`,
        );
      }
    }
    if (stage.type === "coder") {
      if (!stage.coder) {
        errors.push(`coder stage ${stage.id} requires a coder binding`);
      }
      if (stage.agent && !agents.has(stage.agent)) {
        errors.push(
          `stage ${stage.id} references unknown agent for instructions: ${stage.agent}`,
        );
      }
    }
    if (
      stage.type !== "agent" &&
      stage.agent !== undefined &&
      !agents.has(stage.agent)
    ) {
      errors.push(
        `stage ${stage.id} references unknown agent: ${stage.agent}`,
      );
    }
    if (stage.revisionAgent && !agents.has(stage.revisionAgent)) {
      errors.push(
        `stage ${stage.id} revisionAgent references unknown agent: ${stage.revisionAgent}`,
      );
    }

    const uniqueDepends = new Set<string>();
    for (const dependency of stage.depends) {
      if (dependency === stage.id) {
        errors.push(`stage ${stage.id} cannot depend on itself`);
        continue;
      }
      if (uniqueDepends.has(dependency)) {
        errors.push(
          `stage ${stage.id} lists dependency twice: ${dependency}`,
        );
        continue;
      }
      uniqueDepends.add(dependency);
      if (!seen.has(dependency)) {
        errors.push(
          `stage ${stage.id} depends on an unknown or later stage: ${dependency}; each dependency must reference an earlier stage`,
        );
      }
    }
  });

  const entries = stages.filter((stage) => stage.depends.length === 0);
  if (entries.length !== 1) {
    const ids = entries.map((stage) => stage.id).join(", ") || "none";
    errors.push(
      `workflow must have exactly one entry stage without dependencies (found: ${ids})`,
    );
  }

  return { ok: errors.length === 0, errors };
}
