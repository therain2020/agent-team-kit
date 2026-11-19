import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvolutionCycleRecord } from "./cycle";
import type { EvolutionRepository } from "./repository";

/**
 * Workspace-level freeze switch for the evolution plane (70 §3.8).
 *
 * Evolution can be stopped for four reasons:
 * - `incident`: an ongoing incident outranks every optimization (70 §3.8).
 * - `manual`: an operator froze it explicitly.
 * - `convergence`: N consecutive cycles produced no significant improvement
 *   (70 §3.8); the direction needs a retrospective before more spend.
 * - `divergence`: metrics rise while outcomes fall (85 §3.5 Goodhart guard).
 *
 * While frozen a cycle is skipped before any model call or write, so a freeze
 * is a hard stop rather than a soft hint.
 */
export type EvolutionFreezeKind =
  | "incident"
  | "manual"
  | "convergence"
  | "divergence";

export type EvolutionFreezeStatus = "active" | "frozen";

export interface EvolutionFreezeState {
  workspaceId: string;
  status: EvolutionFreezeStatus;
  /** Present only while frozen. */
  kind?: EvolutionFreezeKind;
  /** Why evolution is frozen (present only while frozen). */
  reason?: string;
  /** Who froze it (present only while frozen). */
  actor?: string;
  /** When the freeze took effect (ISO, present only while frozen). */
  since?: string;
  /** The condition an operator must satisfy before lifting the freeze. */
  liftCondition?: string;
  /** When the last freeze was lifted (ISO). */
  liftedAt?: string;
  /** Who lifted the last freeze. */
  liftedBy?: string;
  /** Why the last freeze was lifted. */
  liftReason?: string;
}

export const DEFAULT_FREEZE = "variants/freeze.json";

/** Consecutive no-improvement cycles that trigger a convergence freeze. */
export const DEFAULT_CONVERGENCE_WINDOW = 3;

/**
 * Minimum score delta that counts as a significant improvement when a cycle
 * is evaluated. The cycle's own decision already encodes this (a promoted or
 * canaried candidate beat the baseline); the epsilon documents the contract.
 */
export const IMPROVEMENT_EPSILON = 0.02;

export interface FreezeOptions {
  workspaceId?: string;
  /** File-mode persistence path (ignored when a repository is given). */
  freezePath?: string;
  repo?: EvolutionRepository;
}

export interface FreezeInput {
  kind: EvolutionFreezeKind;
  reason: string;
  actor?: string;
  liftCondition?: string;
}

export interface UnfreezeInput {
  reason?: string;
  actor?: string;
}

const DEFAULT_LIFT_CONDITIONS: Record<EvolutionFreezeKind, string> = {
  incident:
    "lift once the incident is closed and a canary evaluation shows no regression",
  manual: "lift explicitly with `kit evolve unfreeze`",
  convergence:
    "review the last cycles (retrospective), adjust hypothesis/signals/eval, then run `kit evolve unfreeze`",
  divergence:
    "investigate why scores rose while outcomes fell, restore the evaluation baseline, then run `kit evolve unfreeze`",
};

/** Decisions that represent a real attempt to improve the system. */
const ATTEMPT_DECISIONS = new Set<EvolutionCycleRecord["decision"]>([
  "promoted",
  "canary",
  "rejected",
  "failed",
]);

const IMPROVEMENT_DECISIONS = new Set<EvolutionCycleRecord["decision"]>([
  "promoted",
  "canary",
]);

export async function loadFreezeState(
  options: FreezeOptions = {},
): Promise<EvolutionFreezeState> {
  if (options.repo) {
    const stored = await options.repo.getFreeze();
    return stored ?? activeState(options);
  }
  return await readFreezeFile(options.freezePath ?? DEFAULT_FREEZE, options);
}

export async function freezeEvolution(
  input: FreezeInput,
  options: FreezeOptions = {},
): Promise<EvolutionFreezeState> {
  const state: EvolutionFreezeState = {
    workspaceId: workspaceFor(options),
    status: "frozen",
    kind: input.kind,
    reason: input.reason.trim() || defaultReason(input.kind),
    actor: input.actor ?? "operator",
    since: new Date().toISOString(),
    liftCondition: input.liftCondition ?? DEFAULT_LIFT_CONDITIONS[input.kind],
  };
  await persistFreeze(state, options);
  return state;
}

export async function unfreezeEvolution(
  input: UnfreezeInput = {},
  options: FreezeOptions = {},
): Promise<EvolutionFreezeState> {
  const now = new Date().toISOString();
  const state: EvolutionFreezeState = {
    workspaceId: workspaceFor(options),
    status: "active",
    liftedAt: now,
    liftedBy: input.actor ?? "operator",
    ...(input.reason ? { liftReason: input.reason } : {}),
  };
  await persistFreeze(state, options);
  return state;
}

/**
 * Rationale for a cycle that was blocked by a freeze. Recorded on the skipped
 * cycle so history explains why evolution stopped without re-reading state.
 */
export function frozenRationale(state: EvolutionFreezeState): string {
  if (state.status !== "frozen") {
    return "evolution is not frozen";
  }
  const parts = [`evolution is frozen (${state.kind ?? "manual"})`];
  if (state.reason) {
    parts.push(state.reason);
  }
  parts.push(`lift: ${state.liftCondition ?? DEFAULT_LIFT_CONDITIONS.manual}`);
  return parts.join("; ");
}

export interface ConvergenceGuardResult {
  frozen: boolean;
  /** Trailing consecutive attempt cycles without significant improvement. */
  streak: number;
  window: number;
  /** Retrospective hint, present when `frozen` is true. */
  hint?: string;
}

export function isSignificantImprovement(cycle: EvolutionCycleRecord): boolean {
  return IMPROVEMENT_DECISIONS.has(cycle.decision);
}

/**
 * Counts trailing attempt cycles (newest first, skipped cycles ignored) that
 * made no significant improvement. Returns `frozen` once the streak reaches
 * the window, with a retrospective hint for the operator.
 */
export function convergenceGuard(
  cycles: readonly EvolutionCycleRecord[],
  window = DEFAULT_CONVERGENCE_WINDOW,
): ConvergenceGuardResult {
  const effectiveWindow = Math.max(1, window);
  const ordered = [...cycles].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  let streak = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const cycle = ordered[index];
    if (!cycle || !ATTEMPT_DECISIONS.has(cycle.decision)) {
      continue;
    }
    if (isSignificantImprovement(cycle)) {
      break;
    }
    streak += 1;
  }
  const frozen = streak >= effectiveWindow;
  return {
    frozen,
    streak,
    window: effectiveWindow,
    ...(frozen ? { hint: convergenceHint(streak) } : {}),
  };
}

export function convergenceHint(streak: number): string {
  return `${streak} consecutive cycles made no significant improvement; evolution auto-froze for a retrospective — revisit the hypothesis, signals and evaluation, then run \`kit evolve unfreeze\` to resume`;
}

export interface CycleBudget {
  budgetCny?: number;
  budgetTokens?: number;
}

export interface BudgetUsage {
  costCny: number;
  tokens: number;
}

/**
 * Stop-loss for a single cycle. Returns a recorded reason once the spend
 * crosses the cap, or null while inside budget.
 */
export function budgetStop(
  usage: BudgetUsage,
  budget: CycleBudget,
): string | null {
  if (
    budget.budgetCny !== undefined &&
    budget.budgetCny > 0 &&
    usage.costCny > budget.budgetCny
  ) {
    return `cycle budget exceeded: spent ${round(usage.costCny)} of ${budget.budgetCny} CNY`;
  }
  if (
    budget.budgetTokens !== undefined &&
    budget.budgetTokens > 0 &&
    usage.tokens > budget.budgetTokens
  ) {
    return `cycle token budget exceeded: used ${usage.tokens} of ${budget.budgetTokens} tokens`;
  }
  return null;
}

export interface EvolutionCostReport {
  cycles: number;
  evolutionCostCny: number;
  productionCostCny: number;
  /** Evolution share of (evolution + production) spend; null without production cost. */
  share: number | null;
  /** Plan cap for evolution spend share (70 §6). */
  cap: number;
  withinCap: boolean | null;
}

export const EVOLUTION_COST_CAP = 0.1;

/**
 * Reports evolution spend against production spend for the same window so the
 * "evolution ≤ 10% of production budget" gate (70 §6) is observable.
 */
export function evolutionCostReport(
  cycles: readonly EvolutionCycleRecord[],
  productionCostCny?: number,
): EvolutionCostReport {
  const evolutionCostCny = round(
    cycles.reduce((sum, cycle) => sum + (cycle.costCny ?? 0), 0),
  );
  if (productionCostCny === undefined) {
    return {
      cycles: cycles.length,
      evolutionCostCny,
      productionCostCny: 0,
      share: null,
      cap: EVOLUTION_COST_CAP,
      withinCap: null,
    };
  }
  const total = evolutionCostCny + Math.max(0, productionCostCny);
  const share = total > 0 ? round(evolutionCostCny / total) : 0;
  return {
    cycles: cycles.length,
    evolutionCostCny,
    productionCostCny: round(productionCostCny),
    share,
    cap: EVOLUTION_COST_CAP,
    withinCap: share <= EVOLUTION_COST_CAP,
  };
}

function activeState(options: FreezeOptions): EvolutionFreezeState {
  return { workspaceId: workspaceFor(options), status: "active" };
}

function defaultReason(kind: EvolutionFreezeKind): string {
  switch (kind) {
    case "incident":
      return "evolution frozen during an incident";
    case "convergence":
      return "evolution converged without significant improvement";
    case "divergence":
      return "scores rose while outcomes fell; evolution frozen";
    default:
      return "evolution frozen by operator";
  }
}

async function persistFreeze(
  state: EvolutionFreezeState,
  options: FreezeOptions,
): Promise<void> {
  if (options.repo) {
    await options.repo.setFreeze(state);
    return;
  }
  await writeFreezeFile(options.freezePath ?? DEFAULT_FREEZE, state);
}

async function readFreezeFile(
  freezePath: string,
  options: FreezeOptions,
): Promise<EvolutionFreezeState> {
  if (!existsSync(freezePath)) {
    return activeState(options);
  }
  try {
    const raw = JSON.parse(
      await readFile(freezePath, "utf8"),
    ) as EvolutionFreezeState;
    return normalizeFreeze(raw, options);
  } catch {
    // A corrupt freeze file must not silently unfreeze evolution.
    return {
      workspaceId: workspaceFor(options),
      status: "frozen",
      kind: "manual",
      reason: `unreadable freeze state: ${freezePath}`,
      actor: "system",
      since: new Date().toISOString(),
      liftCondition: DEFAULT_LIFT_CONDITIONS.manual,
    };
  }
}

async function writeFreezeFile(
  freezePath: string,
  state: EvolutionFreezeState,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(freezePath)), { recursive: true });
  await writeFile(freezePath, JSON.stringify(state, null, 2), "utf8");
}

function normalizeFreeze(
  raw: EvolutionFreezeState,
  options: FreezeOptions,
): EvolutionFreezeState {
  const workspaceId =
    typeof raw.workspaceId === "string" && raw.workspaceId
      ? raw.workspaceId
      : workspaceFor(options);
  if (raw.status !== "frozen") {
    return {
      workspaceId,
      status: "active",
      ...(raw.liftedAt ? { liftedAt: raw.liftedAt } : {}),
      ...(raw.liftedBy ? { liftedBy: raw.liftedBy } : {}),
      ...(raw.liftReason ? { liftReason: raw.liftReason } : {}),
    };
  }
  const kind = isFreezeKind(raw.kind) ? raw.kind : "manual";
  return {
    workspaceId,
    status: "frozen",
    kind,
    reason: raw.reason || defaultReason(kind),
    actor: raw.actor || "operator",
    since: raw.since ?? new Date().toISOString(),
    liftCondition: raw.liftCondition ?? DEFAULT_LIFT_CONDITIONS[kind],
  };
}

function isFreezeKind(value: unknown): value is EvolutionFreezeKind {
  return (
    value === "incident" ||
    value === "manual" ||
    value === "convergence" ||
    value === "divergence"
  );
}

function workspaceFor(options: FreezeOptions): string {
  return options.workspaceId ?? options.repo?.workspaceId ?? "default";
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
