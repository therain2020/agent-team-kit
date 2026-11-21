import type { StudioStage } from "@/lib/pack-studio";

/**
 * Client-side shape of a workflow stage inside a composer draft. It mirrors
 * `StudioStage` but is serialisable back to the workflow YAML, so the review
 * step of the Studio create flows can edit it before approval.
 */
export interface WorkflowStageDraft {
  id: string;
  type: StudioStage["type"];
  agent?: string;
  coder?: string;
  goal?: string;
  acceptance?: string;
  inputs: string[];
  outputs: string[];
  timeout?: string;
  retry?: { max: number; backoff: "fixed" | "exp" };
  gate?: string;
  depends: string[];
  includeInitialInput?: boolean;
  revisionAgent?: string;
  approval?: PolicyApproval | null;
}

export interface PolicyApproval {
  mode: "required" | "auto" | "never";
  position: "before" | "after";
  riskClass: "low" | "medium" | "high";
  ttl: string;
  autoApproveWhen?: {
    maxRunCostCny?: number;
    riskClass?: Array<"low" | "medium" | "high">;
    stages?: string[];
  };
}

/** Serialise a draft stage back into the workflow YAML vocabulary. */
export function draftStageToYaml(
  stage: WorkflowStageDraft,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: stage.id,
    type: stage.type,
    inputs: stage.inputs,
    outputs: stage.outputs,
  };
  if (stage.agent) {
    out.agent = stage.agent;
  }
  if (stage.coder) {
    out.coder = stage.coder;
  }
  if (stage.goal) {
    out.goal = stage.goal;
  }
  if (stage.acceptance) {
    out.acceptance = stage.acceptance;
  }
  if (stage.timeout) {
    out.timeout = stage.timeout;
  }
  if (stage.retry) {
    out.retry = stage.retry;
  }
  if (stage.gate) {
    out.gate = stage.gate;
  }
  if (stage.depends.length === 1) {
    out.inputFrom = stage.depends[0];
  } else if (stage.depends.length > 1) {
    out.inputsFrom = stage.depends;
  }
  if (stage.includeInitialInput) {
    out.includeInitialInput = true;
  }
  if (stage.revisionAgent) {
    out.revisionAgent = stage.revisionAgent;
  }
  if (stage.approval) {
    out.approval = stage.approval;
  }
  return out;
}
