import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentRole, AvatarSpec } from "@kit/core";
import { loadPack } from "@kit/pack";
import { type StudioAgent, loadStudioData } from "./pack-studio";
import { getPacksRoot } from "./paths";
import { loadArtifactContent } from "./runs";
import { getStore } from "./store";

export type OfficeStatus = "idle" | "working" | "blocked" | "error";

export type OfficeActivityKind =
  | "teamIdle"
  | "waitingDecision"
  | "supervising"
  | "mission"
  | "lastActive"
  | "assigned"
  | "waitingMission";

export interface OfficeAgentView {
  id: string;
  isManager: boolean;
  description: string;
  model: string;
  role: AgentRole;
  tools: string[];
  skills: string[];
  status: OfficeStatus;
  activity: string;
  activityKind: OfficeActivityKind;
  activityDetail?: string;
  runId?: string;
  lastArtifactId?: string;
  /** Custom sprite from the agent frontmatter; absent = seed sprite. */
  avatar?: AvatarSpec;
}

export type OfficeTaskPhase =
  | "demand"
  | "build"
  | "deliver"
  | "blocked"
  | "done";

export interface OfficeMissionView {
  runId: string;
  workflowId: string;
  status: string;
  phase: OfficeTaskPhase;
  createdAt: string;
  costCny: number;
  goal: string;
  acceptance?: string;
  manager: string;
  sellers: string[];
  builders: string[];
  specialists: string[];
  agents: string[];
  latestAgent?: string;
}

export interface OfficePackOption {
  dirName: string;
  name: string;
  agentCount: number;
}

export interface OfficeActivePack {
  dirName: string;
  name: string;
  description: string;
  agents: OfficeAgentView[];
  workflows: Array<{ id: string; stages: number }>;
  missions: OfficeMissionView[];
  managerFile: string;
  roleRules: {
    requireSeller: boolean;
    requireBuilder: boolean;
    allowCombined: boolean;
  };
}

export interface OfficeData {
  packs: OfficePackOption[];
  active: OfficeActivePack | null;
}

export async function loadOfficeData(packParam?: string): Promise<OfficeData> {
  const root = getPacksRoot();
  const packs: OfficePackOption[] = [];
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
      if (!loaded.ok) {
        continue;
      }
      packs.push({
        dirName: entry.name,
        name: loaded.pack.metadata.name,
        agentCount: loaded.pack.agents.length,
      });
    }
  }
  packs.sort(
    (a, b) => b.agentCount - a.agentCount || a.name.localeCompare(b.name),
  );
  const activeDir =
    packs.find((pack) => pack.dirName === packParam)?.dirName ??
    packs[0]?.dirName;
  if (!activeDir) {
    return { packs, active: null };
  }

  const studio = await loadStudioData(activeDir);
  const loaded = await loadPack(path.join(root, activeDir));
  if (!studio || !loaded.ok) {
    return { packs, active: null };
  }

  const roleById = new Map(
    studio.agents.map((agent) => [agent.id, agent.role] as const),
  );
  const store = await getStore();
  const recentRuns = await store.runs.listRecent(30);
  const workflowIds = new Set(loaded.workflows.map((workflow) => workflow.id));
  const typedRuns = recentRuns.filter((run) => workflowIds.has(run.workflowId));
  const runsWithData = await Promise.all(
    typedRuns.slice(0, 12).map(async (run) => {
      const artifacts = await store.artifactStore.listByRun(run.runId);
      let costCny = 0;
      let latestAgent: string | undefined;
      let latestArtifactId: string | undefined;
      let latestAt = "";
      let mission:
        | {
            goal?: string;
            acceptance?: string;
            manager?: string;
            sellers?: string[];
            builders?: string[];
            specialists?: string[];
            agents?: string[];
          }
        | undefined;
      let lastRole: AgentRole | undefined;
      let builderArtifacts = 0;

      const producents = new Map<string, string>();
      for (const artifact of artifacts) {
        const manifest = await store.manifests.get(artifact.manifestId);
        if (!manifest) {
          continue;
        }
        costCny += manifest.cost.amount;
        const agentId = manifest.producer.agentId;
        if (agentId && agentId !== "workflow" && agentId !== "manager") {
          producents.set(agentId, artifact.createdAt);
        }
        const role = roleById.get(agentId);
        if (role) {
          lastRole = role;
          if (role === "builder" || role === "specialist") {
            builderArtifacts += 1;
          }
        }
        if (artifact.createdAt > latestAt) {
          latestAt = artifact.createdAt;
          latestAgent = agentId;
          latestArtifactId = artifact.artifactId;
        }
        if (manifest.stageId.endsWith(":mission-assignment")) {
          const content = await loadArtifactContent(artifact, store, 20_000);
          if (!content.unavailable) {
            try {
              mission = JSON.parse(content.text) as typeof mission;
            } catch {
              // ignore malformed mission assignment
            }
          }
        }
      }

      return {
        run,
        costCny,
        latestAgent,
        latestArtifactId,
        producents,
        mission,
        phase: taskPhase(run.status, lastRole, builderArtifacts),
      };
    }),
  );

  const agents: OfficeAgentView[] = studio.agents.map((agent) => {
    const latest = latestAgentActivity(agent, runsWithData);
    return {
      id: agent.id,
      isManager: agent.isManager,
      description: agent.description,
      model: agent.model,
      role: agent.role,
      tools: agent.tools,
      skills: agent.skills,
      status: latest.status,
      activity: latest.activity,
      activityKind: latest.activityKind,
      activityDetail: latest.activityDetail,
      runId: latest.runId,
      lastArtifactId: latest.artifactId,
      avatar: agent.avatar,
    };
  });

  const missions: OfficeMissionView[] = runsWithData.map((item) => {
    const agents = item.mission?.agents ?? [];
    const sellers = item.mission?.sellers?.length
      ? item.mission.sellers
      : agents.filter((id) => roleById.get(id) === "seller");
    const builders = item.mission?.builders?.length
      ? item.mission.builders
      : agents.filter((id) => roleById.get(id) === "builder");
    const specialists = item.mission?.specialists?.length
      ? item.mission.specialists
      : agents.filter((id) => roleById.get(id) === "specialist");
    return {
      runId: item.run.runId,
      workflowId: item.run.workflowId,
      status: item.run.status,
      phase: item.phase,
      createdAt: item.run.createdAt,
      costCny: item.costCny,
      goal:
        item.mission?.goal ??
        `${item.run.workflowId} · ${item.run.runId.slice(-6)}`,
      acceptance: item.mission?.acceptance,
      manager: item.mission?.manager ?? "manager",
      sellers,
      builders,
      specialists,
      agents,
      latestAgent: item.latestAgent,
    };
  });

  return {
    packs,
    active: {
      dirName: activeDir,
      name: loaded.pack.metadata.name,
      description: loaded.pack.metadata.description ?? "",
      agents,
      workflows: loaded.workflows.map((workflow) => ({
        id: workflow.id,
        stages: workflow.stages.length,
      })),
      missions,
      managerFile: loaded.pack.manager?.agent ?? "agents/manager.md",
      roleRules: loaded.roleRules,
    },
  };
}

function taskPhase(
  status: string,
  lastRole: AgentRole | undefined,
  builderArtifacts: number,
): OfficeTaskPhase {
  if (status === "paused" || status === "failed") {
    return "blocked";
  }
  if (status === "succeeded") {
    return "done";
  }
  if (lastRole === "seller") {
    return builderArtifacts > 0 ? "deliver" : "demand";
  }
  if (builderArtifacts > 0) {
    return "build";
  }
  return "demand";
}

export async function loadOfficeChatHistory(packDir: string) {
  const { loadManagerExchanges } = await import("./manager");
  return loadManagerExchanges(officeThreadId(packDir));
}

export function officeThreadId(packDir: string): string {
  const safe = packDir.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `office-${safe}`;
}

function latestAgentActivity(
  agent: StudioAgent,
  items: Array<{
    run: {
      runId: string;
      workflowId: string;
      status: string;
      createdAt: string;
    };
    producents: Map<string, string>;
    mission?: { goal?: string };
  }>,
): {
  status: OfficeStatus;
  activity: string;
  activityKind: OfficeActivityKind;
  activityDetail?: string;
  runId?: string;
  artifactId?: string;
} {
  if (agent.isManager) {
    const active = items.find(
      (item) => item.run.status === "running" || item.run.status === "paused",
    );
    if (active) {
      return active.run.status === "paused"
        ? {
            status: "blocked",
            activity: "Waiting for a human decision",
            activityKind: "waitingDecision",
            runId: active.run.runId,
          }
        : {
            status: "working",
            activity: `Supervising ${active.run.workflowId}`,
            activityKind: "supervising",
            activityDetail: active.run.workflowId,
            runId: active.run.runId,
          };
    }
    return items[0]
      ? {
          status: "idle",
          activity: "Team is idle",
          activityKind: "teamIdle",
        }
      : {
          status: "idle",
          activity: "No missions yet",
          activityKind: "teamIdle",
        };
  }

  for (const item of items) {
    const producedAt = item.producents.get(agent.id);
    if (!producedAt) {
      continue;
    }
    const status: OfficeStatus =
      item.run.status === "paused"
        ? "blocked"
        : item.run.status === "failed"
          ? "error"
          : item.run.status === "running"
            ? "working"
            : "idle";
    return {
      status,
      activity: item.mission?.goal
        ? truncate(item.mission.goal, 48)
        : `Last active in ${item.run.workflowId}`,
      activityKind: item.mission?.goal ? "mission" : "lastActive",
      activityDetail: item.mission?.goal ?? item.run.workflowId,
      runId: item.run.runId,
    };
  }

  const active = items.find((item) => item.run.status === "running");
  if (active) {
    return {
      status: "working",
      activity: `Assigned to ${active.run.workflowId}`,
      activityKind: "assigned",
      activityDetail: active.run.workflowId,
      runId: active.run.runId,
    };
  }
  return {
    status: "idle",
    activity: "Waiting for a mission",
    activityKind: "waitingMission",
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
