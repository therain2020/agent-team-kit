import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { type EventEnvelope, priorityClassFor } from "@kit/core";
import {
  type CanaryState,
  type EvolutionRepository,
  selectRunVariant,
} from "@kit/evolution";
import { dedupeRunId } from "@kit/job";
import { type LoadedPack, loadPack } from "@kit/pack";
import type { initStore } from "@kit/store";
import {
  type EventRoute,
  type Trigger,
  type TriggerBudget,
  type TriggerResult,
  eventRouteSchema,
  fireTrigger,
  resolveTriggerBudget,
  triggerSchema,
} from "@kit/trigger";

export {
  startOfUtcDay,
  triggerBudgetSkip as eventBudgetSkip,
} from "@kit/trigger";

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
    /** Injectable clock keeps night-mode gates deterministic in tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async route(event: EventEnvelope, payload: unknown): Promise<RouteResult> {
    const result: RouteResult = { started: [], skipped: [], errors: [] };
    const packs = await this.loadPacks();
    const now = this.now();
    const runMode =
      process.env.KIT_EVENT_RUN_MODE === "live" ? "LIVE" : "DRY_RUN";
    const priority = priorityClassFor({
      priority: eventPriorityOf(payload),
      runMode,
    });

    for (const pack of packs) {
      for (const workflow of pack.workflows) {
        if (!triggerMatches(workflow.trigger.event, event.type)) {
          continue;
        }

        const packName = pack.pack.metadata.name;
        const triggerId = `${packName}:${workflow.id}`;
        const dedupeKey = `event:${this.workspaceId}:${event.eventId}:${workflow.id}`;
        const runId = dedupeRunId(dedupeKey);
        const selected = this.variantSelector
          ? await this.variantSelector.select(this.workspaceId, runId)
          : null;
        const trigger = buildEventTrigger({
          triggerId,
          eventType: event.type,
          enabled: true,
        });
        const route = buildEventRoute({
          routeId: `event:${triggerId}`,
          triggerRef: triggerId,
          packDir: selected ? selected.path : pack.dir,
          workflow: workflow.id,
          runMode,
          ...(workflow.trigger.budget
            ? { budget: workflow.trigger.budget }
            : {}),
        });

        const fired: TriggerResult | null = await fireTrigger(
          {
            triggerId,
            dedupeKey,
            payloadRef: event.payloadRef,
            trigger,
            route,
            runId,
            eventId: event.eventId,
            evidenceText: JSON.stringify({ event, payload: payload ?? null }),
            priority,
            originKind: "event",
            actor: "trigger:event-router",
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
          {
            store: this.store,
            repoRoot: this.repoRoot,
            workspaceId: this.workspaceId,
            now,
          },
        ).catch((error: unknown) => {
          result.errors.push(
            `${packName}/${workflow.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        });
        if (!fired) {
          continue;
        }

        if (fired.dispatch === "STARTED" && fired.jobId) {
          result.started.push({
            pack: packName,
            workflow: workflow.id,
            runId: fired.jobId,
            ...(selected ? { variant: "canary" as const } : {}),
          });
          continue;
        }
        if (fired.dispatch === "USE_EXISTING") {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: "duplicate event",
          });
          continue;
        }
        if (fired.dispatch === "SKIPPED") {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: fired.reason ?? "skipped by dispatch gate",
          });
          continue;
        }
        const message = fired.reason ?? "dispatch failed";
        if (
          fired.gate === "budget-ledger" ||
          /budget|exceeded/i.test(message)
        ) {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: message,
          });
          continue;
        }
        if (/already started|AlreadyStarted/i.test(message)) {
          result.skipped.push({
            pack: packName,
            workflow: workflow.id,
            reason: "duplicate event",
          });
          continue;
        }
        result.errors.push(`${packName}/${workflow.id}: ${message}`);
      }
    }

    return result;
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
): TriggerBudget | undefined {
  return resolveTriggerBudget({ budget: declared }, "event", env);
}

function buildEventTrigger(input: {
  triggerId: string;
  eventType: string;
  enabled: boolean;
}): Trigger {
  return triggerSchema.parse({
    triggerId: input.triggerId,
    kind: "event",
    source: "runtime",
    enabled: input.enabled,
    filter: { eventType: input.eventType },
    routeRef: `event:${input.triggerId}`,
    actor: "trigger:event-router",
  });
}

function buildEventRoute(input: {
  routeId: string;
  triggerRef: string;
  packDir: string;
  workflow: string;
  runMode: "DRY_RUN" | "LIVE";
  budget?: TriggerBudget;
}): EventRoute {
  return eventRouteSchema.parse({
    ...input,
    jobKind: "packRun",
    // The runtime resolves packs (and canary variants) to absolute paths.
    allowPackOutsideRoot: true,
  });
}

/**
 * Reads the priority hint carried by an event payload (rule 10 contract). The
 * envelope itself has no priority field, so this stays defensive.
 */
export function eventPriorityOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["priority", "priorityClass", "tier"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
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
