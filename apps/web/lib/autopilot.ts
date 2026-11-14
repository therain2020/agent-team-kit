import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { nextCronOccurrence } from "@kit/autopilot";
import type { AutopilotConfig } from "@kit/core";
import { loadPack } from "@kit/pack";
import { getPacksRoot } from "./paths";
import { loadArtifactContent } from "./runs";
import { ensureStoreSchema, getStore } from "./store";

export interface AutopilotPackView {
  dirName: string;
  name: string;
  enabled: boolean;
  config: AutopilotConfig;
  state: {
    lastTickAt: string | null;
    runsToday: number;
    spentToday: number;
    lastError: string | null;
  };
  schedules: Array<{
    id: string;
    workflow: string;
    cron: string;
    mode: string;
    nextRun: string | null;
    dailyRuns?: number;
    dailyCostCny?: number;
  }>;
  autoApprove: {
    enabled: boolean;
    maxRisk: string;
    maxRunCostCny?: number;
    onTimeout: string;
  } | null;
  evolution: {
    enabled: boolean;
    cadence: string;
    autoApply: boolean;
  } | null;
}

export interface AutoDecisionView {
  runId: string;
  decision: string;
  actor: string;
  stageName: string;
  rationale: string;
  createdAt: string;
}

export interface AutopilotOverview {
  heartbeat: string | null;
  online: boolean;
  packs: AutopilotPackView[];
  decisions: AutoDecisionView[];
}

export async function loadAutopilotOverview(): Promise<AutopilotOverview> {
  await ensureStoreSchema();
  const store = getStore();
  const states = await store.autopilotState.list("default");
  const stateByPack = new Map(states.map((state) => [state.packDir, state]));

  const root = getPacksRoot();
  const packs: AutopilotPackView[] = [];
  if (existsSync(root)) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(root, entry.name);
      if (!existsSync(path.join(dir, "team.yaml"))) {
        continue;
      }
      const loaded = await loadPack(dir);
      if (!loaded.ok || !loaded.autopilot) {
        continue;
      }
      const state = stateByPack.get(entry.name);
      const enabled = state?.enabled ?? loaded.autopilot.enabled;
      packs.push({
        dirName: entry.name,
        name: loaded.pack.metadata.name,
        enabled,
        config: loaded.autopilot,
        state: {
          lastTickAt: state?.lastTickAt ?? null,
          runsToday: state?.runsToday ?? 0,
          spentToday: state?.spentToday ?? 0,
          lastError: state?.lastError ?? null,
        },
        schedules: loaded.autopilot.schedules.map((schedule) => {
          let nextRun = state?.nextRuns[schedule.id] ?? null;
          if (!nextRun) {
            try {
              nextRun = nextCronOccurrence(
                schedule.cron,
                new Date(),
                loaded.autopilot?.timezone ?? "UTC",
              ).toISOString();
            } catch {
              nextRun = null;
            }
          }
          return {
            id: schedule.id,
            workflow: schedule.workflow,
            cron: schedule.cron,
            mode: schedule.mode,
            nextRun,
            dailyRuns: schedule.budget?.dailyRuns,
            dailyCostCny: schedule.budget?.dailyCostCny,
          };
        }),
        autoApprove: loaded.autopilot.approval?.autoApprove
          ? {
              enabled: loaded.autopilot.approval.autoApprove.enabled,
              maxRisk: loaded.autopilot.approval.autoApprove.maxRisk,
              maxRunCostCny:
                loaded.autopilot.approval.autoApprove.maxRunCostCny,
              onTimeout: loaded.autopilot.approval.autoApprove.onTimeout,
            }
          : null,
        evolution: loaded.autopilot.evolution
          ? {
              enabled: loaded.autopilot.evolution.enabled,
              cadence: loaded.autopilot.evolution.cadence,
              autoApply: loaded.autopilot.evolution.autoApply,
            }
          : null,
      });
    }
  }

  packs.sort((a, b) => a.name.localeCompare(b.name));
  const heartbeat =
    states
      .map((state) => state.lastTickAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const online = Boolean(
    heartbeat && Date.now() - new Date(heartbeat).getTime() < 120_000,
  );

  return {
    heartbeat,
    online,
    packs,
    decisions: await loadAutoDecisions(),
  };
}

async function loadAutoDecisions(): Promise<AutoDecisionView[]> {
  const store = await getStore();
  const artifacts = await store.artifactStore.listRecent("default", 60);
  const decisions: AutoDecisionView[] = [];
  for (const artifact of artifacts) {
    const manifest = await store.manifests.get(artifact.manifestId);
    if (!manifest?.stageId.includes(":manager-decision-auto-")) {
      continue;
    }
    const content = await loadArtifactContent(artifact, store, 20_000);
    if (content.unavailable) {
      continue;
    }
    try {
      const parsed = JSON.parse(content.text) as Record<string, unknown>;
      decisions.push({
        runId: String(parsed.runId ?? manifest.runId),
        decision: String(parsed.decision ?? "approve"),
        actor: String(parsed.actor ?? "policy"),
        stageName: String(parsed.stageName ?? ""),
        rationale: String(parsed.rationale ?? ""),
        createdAt:
          typeof parsed.createdAt === "string"
            ? parsed.createdAt
            : artifact.createdAt,
      });
    } catch {
      // ignore malformed decisions
    }
  }
  return decisions.slice(0, 10);
}
