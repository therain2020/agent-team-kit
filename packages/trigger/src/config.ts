import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { type AutopilotConfig, autopilotSchema } from "@kit/core";
import { type LoadedPack, loadPack } from "@kit/pack";
import { parse } from "yaml";
import {
  type EventRoute,
  type Trigger,
  type TriggerRegistry,
  type TriggerRoute,
  eventRouteSchema,
  triggerSchema,
} from "./types";

const KNOWN_AUTOPILOT_KEYS = new Set([
  "version",
  "enabled",
  "timezone",
  "schedules",
  "iterations",
  "approval",
  "evolution",
]);

const MIGRATION_HINT =
  "autopilot.yaml is invalid; keep `version: 1` and declare triggers under schedules/iterations/evolution (see docs/triggers.md)";

export interface TriggerPlanePack {
  dirName: string;
  dir: string;
  loaded: LoadedPack;
  config: AutopilotConfig;
  triggers: Trigger[];
  routes: EventRoute[];
}

export interface TriggerPlane {
  packs: TriggerPlanePack[];
  triggers: Trigger[];
  routes: EventRoute[];
  /** Fatal config errors; the daemon refuses to schedule those packs. */
  errors: string[];
}

export interface LoadTriggerPlaneOptions {
  /** Runtime overlay (autonomy preset) applied before the one-time mapping. */
  transformConfig?: (config: AutopilotConfig) => AutopilotConfig;
}

/**
 * `autopilot.yaml` stays the authoring syntax (96 §5.4). The mapping happens
 * here, once at load time, so the runtime never carries both semantics.
 */
export async function loadTriggerPlane(
  repoRoot: string,
  options: LoadTriggerPlaneOptions = {},
): Promise<TriggerPlane> {
  const packsRoot = path.join(repoRoot, "packs");
  const plane: TriggerPlane = {
    packs: [],
    triggers: [],
    routes: [],
    errors: [],
  };
  if (!existsSync(packsRoot)) {
    return plane;
  }

  const entries = await readdir(packsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(packsRoot, entry.name);
    if (!existsSync(path.join(dir, "team.yaml"))) {
      continue;
    }
    const configPath = path.join(dir, "autopilot.yaml");
    if (!existsSync(configPath)) {
      continue;
    }

    const loaded = await loadPack(dir);
    if (!loaded.ok) {
      const autopilotErrors = loaded.errors.filter((error) =>
        error.includes("autopilot.yaml"),
      );
      if (autopilotErrors.length > 0) {
        plane.errors.push(
          ...autopilotErrors.map(
            (error) => `${entry.name}: ${error} (${MIGRATION_HINT})`,
          ),
        );
      } else {
        plane.errors.push(
          ...loaded.errors.map((error) => `${entry.name}: ${error}`),
        );
      }
      continue;
    }

    const parsed = await readAutopilotConfig(entry.name, configPath);
    if (!parsed.ok) {
      plane.errors.push(parsed.error);
      continue;
    }

    const config = options.transformConfig
      ? options.transformConfig(parsed.config)
      : parsed.config;
    const mapped = mapAutopilotConfig({
      packName: entry.name,
      dirName: entry.name,
      config,
    });
    plane.errors.push(...mapped.errors);
    if (mapped.errors.length > 0) {
      continue;
    }

    plane.packs.push({
      dirName: entry.name,
      dir,
      loaded,
      config,
      triggers: mapped.triggers,
      routes: mapped.routes,
    });
    plane.triggers.push(...mapped.triggers);
    plane.routes.push(...mapped.routes);
  }

  return plane;
}

export function mapAutopilotConfig(input: {
  packName: string;
  dirName: string;
  config: AutopilotConfig;
}): { triggers: Trigger[]; routes: EventRoute[]; errors: string[] } {
  const { packName, dirName, config } = input;
  const triggers: Trigger[] = [];
  const routes: EventRoute[] = [];
  const errors: string[] = [];

  for (const schedule of config.schedules) {
    const routeId = `${packName}:${schedule.id}`;
    const trigger = buildTrigger({
      triggerId: schedule.id,
      kind: "schedule",
      schedule: { cron: schedule.cron, timezone: config.timezone },
      routeRef: routeId,
      enabled: config.enabled,
    });
    const route = buildRoute({
      routeId,
      triggerRef: schedule.id,
      packDir: dirName,
      jobKind: "packRun",
      workflow: schedule.workflow,
      runMode: schedule.mode,
      ...(schedule.inputFile ? { inputFile: schedule.inputFile } : {}),
      ...(schedule.budget ? { budget: schedule.budget } : {}),
    });
    push(triggers, routes, errors, schedule.id, trigger, route);
  }

  for (const iteration of config.iterations) {
    const routeId = `${packName}:${iteration.id}:iteration`;
    const trigger = buildTrigger({
      triggerId: iteration.id,
      kind: "schedule",
      schedule: { cron: iteration.cron, timezone: config.timezone },
      routeRef: routeId,
      enabled: config.enabled,
    });
    const route = buildRoute({
      routeId,
      triggerRef: iteration.id,
      packDir: dirName,
      jobKind: "iteration",
      goal: iteration.goal,
      ...(iteration.acceptance ? { acceptance: iteration.acceptance } : {}),
      maxTasks: iteration.maxTasks,
      maxRepair: iteration.maxRepair,
      ...(iteration.coder ? { coder: iteration.coder } : {}),
      runMode: iteration.mode,
      applyMode: iteration.applyMode,
      ...(iteration.budget ? { budget: iteration.budget } : {}),
    });
    push(triggers, routes, errors, iteration.id, trigger, route);
  }

  if (config.evolution) {
    const triggerId = `${packName}:evolution`;
    const routeId = `${packName}:evolution:cycle`;
    const trigger = buildTrigger({
      triggerId,
      kind: "schedule",
      schedule: {
        cron: config.evolution.cadence === "weekly" ? "0 0 * * 1" : "0 0 * * *",
        timezone: config.timezone,
      },
      routeRef: routeId,
      enabled: config.enabled && config.evolution.enabled,
    });
    const route = buildRoute({
      routeId,
      triggerRef: triggerId,
      packDir: dirName,
      jobKind: "evolution",
      evolution: config.evolution,
    });
    push(triggers, routes, errors, triggerId, trigger, route);
  }

  return { triggers, routes, errors };
}

export function createTriggerRegistry(
  routes: readonly TriggerRoute[],
): TriggerRegistry {
  const byId = new Map(routes.map((item) => [item.trigger.triggerId, item]));
  return {
    async resolve(triggerId: string): Promise<TriggerRoute | null> {
      return byId.get(triggerId) ?? null;
    },
    async list(): Promise<TriggerRoute[]> {
      return [...byId.values()];
    },
  };
}

export function registryFromPlane(plane: TriggerPlane): TriggerRegistry {
  return createTriggerRegistry(
    plane.packs.flatMap((pack) =>
      pack.triggers.flatMap((trigger) => {
        const route = pack.routes.find(
          (item) => item.routeId === trigger.routeRef,
        );
        return route ? [{ trigger, route }] : [];
      }),
    ),
  );
}

function buildTrigger(input: {
  triggerId: string;
  kind: Trigger["kind"];
  schedule?: { cron: string; timezone: string };
  routeRef: string;
  enabled: boolean;
}): Trigger {
  return triggerSchema.parse({
    triggerId: input.triggerId,
    kind: input.kind,
    source: "autopilot.yaml",
    enabled: input.enabled,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    routeRef: input.routeRef,
    actor: "policy:autopilot",
  });
}

function buildRoute(input: Record<string, unknown>): EventRoute {
  return eventRouteSchema.parse(input);
}

function push(
  triggers: Trigger[],
  routes: EventRoute[],
  errors: string[],
  triggerId: string,
  trigger: Trigger,
  route: EventRoute,
): void {
  if (triggers.some((item) => item.triggerId === triggerId)) {
    errors.push(`duplicate trigger id "${triggerId}"`);
    return;
  }
  triggers.push(trigger);
  routes.push(route);
}

async function readAutopilotConfig(
  packName: string,
  configPath: string,
): Promise<
  { ok: true; config: AutopilotConfig } | { ok: false; error: string }
> {
  let doc: unknown;
  try {
    doc = parse(await readFile(configPath, "utf8"));
  } catch (error) {
    return fail(
      packName,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return fail(packName, "config must be a mapping");
  }
  const unknown = Object.keys(doc as Record<string, unknown>).filter(
    (key) => !KNOWN_AUTOPILOT_KEYS.has(key),
  );
  if (unknown.length > 0) {
    return fail(packName, `unknown key(s): ${unknown.join(", ")}`);
  }
  const parsed = autopilotSchema.safeParse(doc);
  if (!parsed.success) {
    return fail(
      packName,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; "),
    );
  }
  return { ok: true, config: parsed.data };
}

function fail(packName: string, message: string): { ok: false; error: string } {
  return { ok: false, error: `${packName}: ${message} (${MIGRATION_HINT})` };
}
