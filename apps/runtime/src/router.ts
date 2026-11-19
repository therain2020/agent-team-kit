import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  type EventEnvelope,
  isExecutionBlocked,
  resolveKillSwitch,
} from "@kit/core";
import { activeModeForWorkspace, auditBlockedExecution } from "@kit/engine";
import {
  type CanaryState,
  type EvolutionRepository,
  selectRunVariant,
} from "@kit/evolution";
import { JobError, dedupeRunId, startJob } from "@kit/job";
import { type LoadedPack, loadPack, simulatePack } from "@kit/pack";
import type { initStore } from "@kit/store";

type Store = Awaited<ReturnType<typeof initStore>>;

export interface RouteResult {
  started: Array<{
    pack: string;
    workflow: string;
    runId: string;
    variant?: "canary";
  }>;
  skipped: Array<{ pack: string; workflow: string; reason: string }>;
  errors: string[];
}

export interface EventBudget {
  dailyRuns?: number;
  dailyCostCny?: number;
}

export interface BudgetUsage {
  runs: number;
  costCny: number;
}

export interface RunVariantSelection {
  path: string;
  variantId: string;
  trafficPercent: number;
}

export interface RunVariantSelector {
  select(
    workspaceId: string,
    runId: string,
  ): Promise<RunVariantSelection | null>;
}

export class EvolutionRunVariantSelector implements RunVariantSelector {
  private cached?: { at: number; state: CanaryState | null };

  constructor(
    private readonly repo: EvolutionRepository,
    private readonly ttlMs = 15_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async select(
    workspaceId: string,
    runId: string,
  ): Promise<RunVariantSelection | null> {
    const route = selectRunVariant(
      await this.canaryState(),
      runId,
      workspaceId,
    );
    if (!route || !existsSync(path.join(route.path, "team.yaml"))) {
      return null;
    }
    return {
      path: route.path,
      variantId: route.variantId,
      trafficPercent: route.trafficPercent,
    };
  }

  private async canaryState(): Promise<CanaryState | null> {
    const now = this.now();
    if (this.cached && now - this.cached.at < this.ttlMs) {
      return this.cached.state;
    }
    // Routing state is advisory: a store hiccup must not block champion
    // traffic, so failures fall back to the live pack.
    const state = await this.repo
      .getState()
      .then((stored) => stored?.state ?? null)
      .catch(() => null);
    this.cached = { at: now, state };
    return state;
  }
}

export class EventRouter {
  private cache?: { at: number; packs: LoadedPack[] };

  constructor(
    private readonly store: Store,
    private readonly repoRoot: string,
    private readonly variantSelector: RunVariantSelector | null = null,
    private readonly workspaceId = "default",
  ) {}

  async route(event: EventEnvelope, payload: unknown): Promise<RouteResult> {
    const result: RouteResult = { started: [], skipped: [], errors: [] };
    const packs = await this.loadPacks();
    const active = await this.store.runs.list({ limit: 200 });
    const mode = await activeModeForWorkspace(this.store, event.workspaceId);
    const readOnly = isExecutionBlocked(mode);
    if (mode && readOnly) {
      await auditBlockedExecution(this.store, mode, event.workspaceId, {
        action: "route",
        eventId: event.eventId,
        eventType: event.type,
      });
    }
    const since = startOfUtcDay(new Date()).toISOString();
    const usage = new Map<string, BudgetUsage>();
    const blockingSwitch = resolveKillSwitch(
      await this.store.killSwitches.listActive(),
      { workspaceId: event.workspaceId },
    );

    for (const pack of packs) {
      let estimates: ReturnType<typeof simulatePack> | undefined;
      const estimateCny = (workflowId: string): number => {
        estimates ??= simulatePack(pack);
        return (
          estimates.workflows.find((item) => item.id === workflowId)
            ?.totalCostCny ?? 0
        );
      };

      for (const workflow of pack.workflows) {
        if (!triggerMatches(workflow.trigger.event, event.type)) {
          continue;
        }

        const packName = pack.pack.metadata.name;
        if (blockingSwitch) {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: `kill switch ${blockingSwitch.scope}/${
              blockingSwitch.target || "*"
            }`,
          });
          continue;
        }
        if (readOnly) {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: "workspace is in read-only mode",
          });
          continue;
        }
        const busy = active.some(
          (run) =>
            run.workflowId === workflow.id &&
            (run.status === "running" || run.status === "paused"),
        );
        if (busy) {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: "workflow already active",
          });
          continue;
        }

        const budget = resolveEventBudget(workflow.trigger.budget);
        const estimate =
          budget?.dailyCostCny !== undefined ? estimateCny(workflow.id) : 0;
        let used: BudgetUsage | undefined;
        if (budget) {
          used = usage.get(workflow.id);
          if (!used) {
            used = await this.loadUsage(
              workflow.id,
              since,
              budget.dailyCostCny !== undefined,
            );
            usage.set(workflow.id, used);
          }
        }
        const overBudget = eventBudgetSkip(
          budget,
          used ?? { runs: 0, costCny: 0 },
          estimate,
        );
        if (overBudget) {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: overBudget,
          });
          continue;
        }

        try {
          const dedupeKey = `event:${this.workspaceId}:${event.eventId}:${workflow.id}`;
          const runId = dedupeRunId(dedupeKey);
          const selected = this.variantSelector
            ? await this.variantSelector.select(this.workspaceId, runId)
            : null;
          const started = await startJob(
            this.store,
            {
              kind: "packRun",
              packDir: selected ? selected.path : pack.dir,
              workflow: workflow.id,
              evidenceText: JSON.stringify({ event, payload: payload ?? null }),
              runId,
              dedupeKey,
              eventId: event.eventId,
              workspaceId: this.workspaceId,
              runMode:
                process.env.KIT_EVENT_RUN_MODE === "live" ? "LIVE" : "DRY_RUN",
              stub: process.env.KIT_MODEL_MODE === "stub",
              origin: {
                kind: "event",
                triggerId: `${packName}:${workflow.id}`,
                triggerRunId: event.eventId,
                actor: "trigger:event-router",
              },
              ...(selected
                ? {
                    variant: {
                      role: "canary" as const,
                      variantId: selected.variantId,
                      trafficPercent: selected.trafficPercent,
                    },
                  }
                : {}),
            },
            { repoRoot: this.repoRoot, allowPackOutsideRoot: true },
          );
          if (started.deduped) {
            result.skipped.push({
              pack: packName,
              workflow: workflow.id,
              reason: "duplicate event",
            });
            continue;
          }
          if (used) {
            used.runs += 1;
            used.costCny += estimate;
          }
          result.started.push({
            pack: packName,
            workflow: workflow.id,
            runId: started.jobId,
            ...(selected ? { variant: "canary" as const } : {}),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (error instanceof JobError && error.code === "budget_exceeded") {
            result.skipped.push({
              pack: packName,
              workflow: workflow.id,
              reason: message,
            });
          } else if (
            /already started|WorkflowExecutionAlreadyStarted/i.test(message)
          ) {
            result.skipped.push({
              pack: packName,
              workflow: workflow.id,
              reason: "duplicate event",
            });
          } else {
            result.errors.push(`${packName}/${workflow.id}: ${message}`);
          }
        }
      }
    }

    return result;
  }

  private async loadUsage(
    workflowId: string,
    sinceIso: string,
    withCost: boolean,
  ): Promise<BudgetUsage> {
    if (!withCost) {
      const [row] = await this.store.sql<Array<{ count: number | string }>>`
        SELECT COUNT(*) AS count FROM runs
        WHERE workflow_id = ${workflowId} AND created_at >= ${sinceIso}
      `;
      return { runs: Number(row?.count ?? 0), costCny: 0 };
    }
    const rows = await this.store.sql<Array<{ run_id: string }>>`
      SELECT run_id FROM runs
      WHERE workflow_id = ${workflowId} AND created_at >= ${sinceIso}
      ORDER BY created_at DESC
      LIMIT 500
    `;
    let costCny = 0;
    for (const row of rows) {
      costCny += await this.runCost(row.run_id);
    }
    return { runs: rows.length, costCny };
  }

  private async runCost(runId: string): Promise<number> {
    const artifacts = await this.store.artifactStore.listByRun(runId);
    let total = 0;
    for (const artifact of artifacts) {
      const manifest = await this.store.manifests.get(artifact.manifestId);
      total += manifest?.cost.amount ?? 0;
    }
    return total;
  }

  private async loadPacks(): Promise<LoadedPack[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) {
      return this.cache.packs;
    }
    const packsRoot = path.join(this.repoRoot, "packs");
    if (!existsSync(packsRoot)) {
      return [];
    }
    const entries = await readdir(packsRoot, { withFileTypes: true });
    const packs: LoadedPack[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(packsRoot, entry.name);
      if (!existsSync(path.join(dir, "team.yaml"))) {
        continue;
      }
      const loaded = await loadPack(dir);
      if (loaded.ok) {
        packs.push(loaded);
      }
    }
    this.cache = { at: Date.now(), packs };
    return packs;
  }
}

/**
 * Declarative `trigger.budget` wins per field; the environment provides the
 * fallback so an operator can cap event-driven runs without editing every Pack.
 */
export function resolveEventBudget(
  declared: EventBudget | undefined,
  env: Record<string, string | undefined> = process.env,
): EventBudget | undefined {
  const dailyRuns =
    declared?.dailyRuns ?? positiveInt(env.KIT_EVENT_DAILY_RUNS);
  const dailyCostCny =
    declared?.dailyCostCny ?? nonNegativeNumber(env.KIT_EVENT_DAILY_COST_CNY);
  if (dailyRuns === undefined && dailyCostCny === undefined) {
    return undefined;
  }
  return {
    ...(dailyRuns !== undefined ? { dailyRuns } : {}),
    ...(dailyCostCny !== undefined ? { dailyCostCny } : {}),
  };
}

export function eventBudgetSkip(
  budget: EventBudget | undefined,
  usage: BudgetUsage,
  estimateCny: number,
): string | null {
  if (!budget) {
    return null;
  }
  if (budget.dailyRuns !== undefined && usage.runs >= budget.dailyRuns) {
    return `daily run budget reached (${usage.runs}/${budget.dailyRuns})`;
  }
  if (budget.dailyCostCny !== undefined) {
    const projected = round4(usage.costCny + estimateCny);
    if (projected > budget.dailyCostCny) {
      return `daily cost budget would be exceeded (${projected} > ${budget.dailyCostCny} CNY)`;
    }
  }
  return null;
}

export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function nonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function triggerMatches(pattern: string, type: string): boolean {
  if (pattern === "*" || pattern === type) {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return false;
}
