import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { EventEnvelope } from "@kit/core";
import { type LoadedPack, buildPackRun, loadPack } from "@kit/pack";
import type { initStore } from "@kit/store";
import { type createTemporalClient, taskQueue } from "@kit/workflow";

type Store = Awaited<ReturnType<typeof initStore>>;
type Temporal = Awaited<ReturnType<typeof createTemporalClient>>;

export interface RouteResult {
  started: Array<{ pack: string; workflow: string; runId: string }>;
  skipped: Array<{ pack: string; workflow: string; reason: string }>;
  errors: string[];
}

export class EventRouter {
  private cache?: { at: number; packs: LoadedPack[] };

  constructor(
    private readonly store: Store,
    private readonly temporal: Temporal,
    private readonly repoRoot: string,
  ) {}

  async route(event: EventEnvelope, payload: unknown): Promise<RouteResult> {
    const result: RouteResult = { started: [], skipped: [], errors: [] };
    const packs = await this.loadPacks();
    const active = await this.store.runs.list({ limit: 200 });

    for (const pack of packs) {
      for (const workflow of pack.workflows) {
        if (!triggerMatches(workflow.trigger.event, event.type)) {
          continue;
        }

        const packName = pack.pack.metadata.name;
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

        try {
          const built = await buildPackRun(pack, {
            workflow: workflow.id,
            input: JSON.stringify({ event, payload: payload ?? null }),
            runMode:
              process.env.KIT_EVENT_RUN_MODE === "live" ? "LIVE" : "DRY_RUN",
            stub: process.env.KIT_MODEL_MODE === "stub",
          });
          built.input.eventId = event.eventId;

          await this.temporal.client.workflow.start("packWorkflow", {
            taskQueue,
            workflowId: `pack-event-${event.eventId}-${workflow.id}`,
            args: [built.input],
          });
          result.started.push({
            pack: packName,
            workflow: workflow.id,
            runId: built.input.runId,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
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

export function triggerMatches(pattern: string, type: string): boolean {
  if (pattern === "*" || pattern === type) {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return false;
}
