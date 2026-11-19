import type { RunProjection } from "@kit/store";
import type {
  OfficeActivityKind,
  OfficeAgentView,
  OfficeMissionView,
  OfficeTaskPhase,
} from "./office";
import {
  type Presence,
  type WorldSnapshot,
  managerPresence,
  presenceFromAgentState,
} from "./world-state";

/**
 * Projects the world read model onto the office floor (97 §3.2).
 *
 * The server loader still supplies pack and mission metadata; this module
 * overlays the live per-agent presence, stage and progress so the floor does
 * not depend on transport-level refreshes. Optimistic missions started from
 * the office are kept until the projection (the stream) acknowledges the run.
 */

export type LiveStatus = "idle" | "working" | "blocked" | "waiting" | "error";

export type LiveActivityKind =
  | OfficeActivityKind
  | "liveTool"
  | "liveStage"
  | "waitingApproval";

export interface LiveAgent
  extends Omit<OfficeAgentView, "status" | "activityKind"> {
  status: LiveStatus;
  activityKind: LiveActivityKind;
  /** ISO timestamp of when the current state began. */
  since?: string;
  stageId?: string | null;
  progress?: number;
  currentTool?: string | null;
  /** `true` when the values come from the world projection. */
  live: boolean;
}

export interface LiveMission extends Omit<OfficeMissionView, "phase"> {
  phase: OfficeTaskPhase;
  progress?: number;
  currentStage?: string | null;
  live: boolean;
  optimistic: boolean;
}

export interface OptimisticMission {
  runId: string;
  workflowId: string;
  goal: string;
  acceptance?: string;
  createdAt: string;
  manager: string;
  sellers: string[];
  builders: string[];
  specialists: string[];
  agents: string[];
}

export function mapPresenceStatus(status: Presence["status"]): LiveStatus {
  return status === "waiting-approval" ? "waiting" : status;
}

/** Run ids the office knows about, used to scope the manager projection. */
export function missionRunIds(
  missions: readonly OfficeMissionView[],
  optimistic: readonly OptimisticMission[] = [],
): Set<string> {
  return new Set([
    ...missions.map((mission) => mission.runId),
    ...optimistic.map((mission) => mission.runId),
  ]);
}

export function deriveLiveAgents(
  base: readonly OfficeAgentView[],
  world: WorldSnapshot | null,
  missions: readonly OfficeMissionView[],
  optimistic: readonly OptimisticMission[] = [],
): LiveAgent[] {
  const runById = new Map((world?.runs ?? []).map((run) => [run.runId, run]));
  const agentStateById = new Map(
    (world?.agents ?? []).map((agent) => [agent.agentId, agent]),
  );
  const scopedRunIds = missionRunIds(missions, optimistic);
  const pendingByAgent = new Map<string, OptimisticMission>();
  for (const mission of optimistic) {
    for (const agentId of mission.agents) {
      if (!pendingByAgent.has(agentId)) {
        pendingByAgent.set(agentId, mission);
      }
    }
  }

  return base.map((agent) => {
    const presence = presenceFromAgentState(agentStateById.get(agent.id));
    if (presence) {
      return applyPresence(agent, presence, runById);
    }

    const pending = pendingByAgent.get(agent.id);
    if (pending) {
      return applyPresence(
        agent,
        {
          status: "working",
          since: pending.createdAt,
          runId: pending.runId,
          currentTool: null,
        },
        runById,
      );
    }

    if (agent.isManager) {
      const manager = managerPresence(world, scopedRunIds);
      if (manager) {
        return applyPresence(agent, manager, runById);
      }
    }

    return { ...agent, live: false };
  });
}

function applyPresence(
  agent: OfficeAgentView,
  presence: Presence,
  runById: Map<string, RunProjection>,
): LiveAgent {
  const run = presence.runId ? runById.get(presence.runId) : undefined;
  const status = mapPresenceStatus(presence.status);
  let activityKind: LiveActivityKind = agent.activityKind;
  let activityDetail = agent.activityDetail;
  if (status === "waiting") {
    activityKind = "waitingApproval";
    activityDetail = run?.waitReason ?? agent.activityDetail;
  } else if (presence.currentTool) {
    activityKind = "liveTool";
    activityDetail = presence.currentTool;
  } else if (presence.status === "working" && run?.currentStage) {
    activityKind = "liveStage";
    activityDetail = run.currentStage;
  }

  return {
    ...agent,
    status,
    activityKind,
    activityDetail,
    runId: presence.runId ?? agent.runId,
    since: presence.since,
    stageId: run?.currentStage ?? null,
    progress: run?.progress,
    currentTool: presence.currentTool,
    live: true,
  };
}

export function deriveLiveMissions(
  base: readonly OfficeMissionView[],
  world: WorldSnapshot | null,
  optimistic: readonly OptimisticMission[] = [],
): LiveMission[] {
  const runById = new Map((world?.runs ?? []).map((run) => [run.runId, run]));
  const known = new Set(base.map((mission) => mission.runId));

  const live: LiveMission[] = base.map((mission) => {
    const run = runById.get(mission.runId);
    if (!run) {
      return { ...mission, live: false, optimistic: false };
    }
    return {
      ...mission,
      status: run.status,
      phase: livePhase(run.status, mission.phase),
      costCny: roundCost(run.costCny),
      progress: run.progress,
      currentStage: run.currentStage,
      live: true,
      optimistic: false,
    };
  });

  for (const mission of optimistic) {
    if (known.has(mission.runId)) {
      continue;
    }
    known.add(mission.runId);
    live.unshift({
      runId: mission.runId,
      workflowId: mission.workflowId,
      status: "pending",
      phase: "demand",
      createdAt: mission.createdAt,
      costCny: 0,
      goal: mission.goal,
      acceptance: mission.acceptance,
      manager: mission.manager,
      sellers: mission.sellers,
      builders: mission.builders,
      specialists: mission.specialists,
      agents: mission.agents,
      progress: 0,
      currentStage: null,
      live: false,
      optimistic: true,
    });
  }

  return live;
}

function livePhase(status: string, fallback: OfficeTaskPhase): OfficeTaskPhase {
  switch (status) {
    case "paused":
    case "failed":
    case "cancelled":
      return "blocked";
    case "succeeded":
      return "done";
    case "running":
    case "pending":
      // A run that just left the pause gate no longer belongs in "blocked".
      return fallback === "blocked" || fallback === "done" ? "build" : fallback;
    default:
      return fallback;
  }
}

function roundCost(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}
