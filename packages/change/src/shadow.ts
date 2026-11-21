import type { ChangeRisk } from "@kit/core";
import type { initStore } from "@kit/store";
import {
  type EvolutionChangeInput,
  type IterationChangeInput,
  adaptEvolutionChange,
  adaptIterationChange,
} from "./adapters";
import { ChangePipeline } from "./pipeline";

type Store = Awaited<ReturnType<typeof initStore>>;

/**
 * Shadow wiring (85 §3.5, first version).
 *
 * Both loops keep their existing behavior and CLI output. When
 * `KIT_CHANGE_PIPELINE=shadow` (or `on`) is set, they additionally mirror what
 * they already did onto the unified `ChangeProposal` machine. The recorder is
 * strictly best-effort: a storage or validation failure is logged and never
 * changes the loop's result.
 *
 * Default is `off` so existing deployments, tests and command output stay
 * byte-for-byte identical.
 */

export type ChangePipelineMode = "off" | "shadow" | "on";

export function changePipelineMode(
  env: Record<string, string | undefined> = process.env,
): ChangePipelineMode {
  const value = env.KIT_CHANGE_PIPELINE?.trim().toLowerCase();
  if (value === "1" || value === "on" || value === "true") {
    return "on";
  }
  if (value === "shadow") {
    return "shadow";
  }
  return "off";
}

export function isChangePipelineEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return changePipelineMode(env) !== "off";
}

export interface ShadowIterationInput {
  workspaceId: string;
  iterationId: string;
  goal: string;
  plan: {
    tasks: ReadonlyArray<{
      id: string;
      domain: string;
      goal: string;
      acceptance: string;
      risk: ChangeRisk;
    }>;
  };
  results: ReadonlyArray<{
    taskId: string;
    verificationPass: boolean;
    applyStatus?: string;
    commit?: string;
    baseSha?: string;
    backupDir?: string;
    error?: string;
  }>;
  checks?: string[];
  at?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Mirrors an iteration report onto change proposals. Returns the proposal ids
 * written (empty when the pipeline is off). Never throws.
 */
export async function recordShadowIterationProposals(
  store: Store,
  input: ShadowIterationInput,
): Promise<string[]> {
  if (!isChangePipelineEnabled(input.env ?? process.env)) {
    return [];
  }
  const pipeline = new ChangePipeline(store.changeProposals);
  const tasks = new Map(input.plan.tasks.map((task) => [task.id, task]));
  const ids: string[] = [];
  for (const result of input.results) {
    const task = tasks.get(result.taskId);
    if (!task) {
      continue;
    }
    const changeInput: IterationChangeInput = {
      workspaceId: input.workspaceId,
      iterationId: input.iterationId,
      goal: input.goal,
      task,
      result,
      ...(input.checks ? { checks: input.checks } : {}),
      ...(input.at ? { at: input.at } : {}),
    };
    try {
      const proposal = await pipeline.record(adaptIterationChange(changeInput));
      ids.push(proposal.id);
    } catch (error) {
      console.error(
        `[change] shadow iteration proposal failed for ${input.iterationId}/${result.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return ids;
}

/**
 * Mirrors an evolution cycle onto a change proposal. Returns the proposal id,
 * or null when the cycle was skipped or the pipeline is off. Never throws.
 */
export async function recordShadowEvolutionCycle(
  store: Store,
  input: EvolutionChangeInput & { env?: Record<string, string | undefined> },
): Promise<string | null> {
  if (!isChangePipelineEnabled(input.env ?? process.env)) {
    return null;
  }
  try {
    const plan = adaptEvolutionChange(input);
    if (!plan) {
      return null;
    }
    const proposal = await new ChangePipeline(store.changeProposals).record(
      plan,
    );
    return proposal.id;
  } catch (error) {
    console.error(
      `[change] shadow evolution proposal failed for ${input.cycle.cycleId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
