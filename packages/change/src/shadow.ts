import type { ChangeProposal, ChangeRisk } from "@kit/core";
import type { ChangeProposalService, initStore } from "@kit/store";
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
 * byte-for-byte identical — with one deliberate exception: a **high-risk**
 * iteration task is always recorded (and its approval requested) even when the
 * switch is off. High-risk changes must be approved (85 hard contract 3,
 * 98 §5.2 G4); without the proposal the approval would have nowhere to point,
 * so G4 could never be judged from real data. The proposal id is deterministic
 * and creation is idempotent, so enabling the shadow switch later does not
 * duplicate rows.
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
 * written. With the pipeline off only high-risk tasks are recorded (so their
 * required approval has a subject); never throws.
 */
export async function recordShadowIterationProposals(
  store: Store,
  input: ShadowIterationInput,
): Promise<string[]> {
  const enabled = isChangePipelineEnabled(input.env ?? process.env);
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
    const plan = adaptIterationChange(changeInput);
    // High-risk changes are recorded even with the shadow switch off so the
    // approval has a real subject (see the module comment).
    if (!enabled && plan.proposal.risk !== "high") {
      continue;
    }
    try {
      const proposal = await pipeline.record(plan);
      ids.push(proposal.id);
    } catch (error) {
      console.error(
        `[change] shadow iteration proposal failed for ${input.iterationId}/${result.taskId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // High-risk proposals that cannot auto-promote still land in the shared
    // approval inbox (85.3.5.5); the deterministic proposal id makes this
    // idempotent even when the transition above was refused.
    if (plan.proposal.risk === "high") {
      await requestChangeApprovalSafely(store, plan.proposal.id);
    }
  }
  return ids;
}

/**
 * Queues an approval for a high-risk proposal. Best-effort like the rest of
 * shadow recording: a decision inbox failure must never change the loop's
 * result, and non-high proposals simply return null.
 */
async function requestChangeApprovalSafely(
  store: Store,
  changeId: string,
): Promise<void> {
  try {
    await store.changeApprovals.request(changeId);
  } catch (error) {
    console.error(
      `[change] approval request failed for ${changeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Records an evolution cycle on the unified change pipeline unconditionally.
 *
 * The evolution cycle calls this after an auto-promotion so every applied
 * instruction change (the `cycle.promote` record) is rollbackable by
 * `changeId` (85 §3.5.6). Returns null for a skipped cycle. Unlike the shadow
 * recorder this is not gated by `KIT_CHANGE_PIPELINE`: an applied promotion
 * must always have an audited proposal with a structured `revert`.
 */
export async function recordEvolutionCycleProposal(
  service: ChangeProposalService,
  input: EvolutionChangeInput,
): Promise<ChangeProposal | null> {
  const plan = adaptEvolutionChange(input);
  if (!plan) {
    return null;
  }
  return await new ChangePipeline(service).record(plan);
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
    const proposal = await recordEvolutionCycleProposal(
      store.changeProposals,
      input,
    );
    if (!proposal) {
      return null;
    }
    if (proposal.risk === "high") {
      await requestChangeApprovalSafely(store, proposal.id);
    }
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
