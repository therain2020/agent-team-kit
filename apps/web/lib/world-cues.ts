import type { AgentState, RunProjection } from "@kit/store";
import type { WorldSnapshot } from "./world-state";

/**
 * World delta → motion cues (89 §3.2, 97 §3.2/§3.5, issue #156).
 *
 * The office floor animates only things the shared world stream (`useWorld`)
 * actually reports: an artifact crate when a run's artifact count grows, a
 * tool bubble when an agent's `currentTool` changes, a gate stamp when a run
 * crosses the approval/failure gate, a belt reverse when a run is cancelled or
 * fails, and a flow cue with the token/cost delta. Everything is derived by
 * diffing two consecutive snapshots, so a quiet workspace produces no cues and
 * a replayed/duplicated delta produces none either (idempotent by value).
 */

/** Crate accent shared with `PixelCrate`'s `CrateTone`. */
export type WorldCueTone = "low" | "medium" | "high" | "bad";

export interface WorldCrate {
  runId: string;
  label: string;
  tone: WorldCueTone;
}

export type WorldCue =
  | ({ type: "crate" } & WorldCrate)
  | { type: "tool"; agentId: string; tool: string }
  | { type: "stamp"; outcome: "passed" | "failed" }
  | { type: "reverse"; runId: string }
  | { type: "flow"; tokens: number; costCny: number };

/** Crates kept on the office belt; older crates fall off the far end. */
export const MAX_BELT_CRATES = 8;

/** Paused runs need a human, failed runs are scrap: both read "hot". */
export function crateTone(status: string): WorldCueTone {
  if (status === "failed" || status === "cancelled") {
    return "bad";
  }
  if (status === "paused") {
    return "high";
  }
  if (status === "running" || status === "queued" || status === "pending") {
    return "low";
  }
  return "medium";
}

/** Short belt label: the current stage when known, else the run tail. */
export function crateLabel(run: RunProjection): string {
  const stage = run.currentStage;
  if (stage && stage.length > 0) {
    const parts = stage.split(":");
    const name = parts[parts.length - 1] ?? stage;
    return name.length <= 10 ? name : name.slice(-10);
  }
  return run.runId.slice(-6);
}

export function crateForRun(run: RunProjection): WorldCrate {
  return {
    runId: run.runId,
    label: crateLabel(run),
    tone: crateTone(run.status),
  };
}

/**
 * Seeds the belt from the first snapshot so the floor reflects work already in
 * flight instead of starting empty. Runs arrive newest-first from the server.
 */
export function seedBeltCrates(
  runs: readonly RunProjection[],
  limit = MAX_BELT_CRATES,
): WorldCrate[] {
  const active = runs.filter(
    (run) =>
      run.status === "running" ||
      run.status === "paused" ||
      run.status === "queued",
  );
  const source = active.length > 0 ? active : runs;
  return source.slice(0, Math.max(0, limit)).map(crateForRun);
}

/**
 * Appends a crate, replacing the previous crate of the same run in place so a
 * busy run does not flood the belt. Bounded by `limit`.
 */
export function appendCrate(
  crates: readonly WorldCrate[],
  crate: WorldCrate,
  limit = MAX_BELT_CRATES,
): WorldCrate[] {
  const without = crates.filter((entry) => entry.runId !== crate.runId);
  const next = [...without, crate];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Diffs two world snapshots. `previous` is `null` on first load (seeding is the
 * caller's job), and identical snapshots yield no cues — animation is strictly
 * data-driven.
 */
export function diffWorldCues(
  previous: WorldSnapshot | null,
  next: WorldSnapshot | null,
): WorldCue[] {
  if (!previous || !next) {
    return [];
  }

  const cues: WorldCue[] = [];
  const previousRuns = new Map(previous.runs.map((run) => [run.runId, run]));
  let tokens = 0;
  let costCny = 0;
  let failed = 0;
  let passed = 0;
  let reversedRun: string | null = null;

  for (const run of next.runs) {
    const before = previousRuns.get(run.runId);
    if (!before) {
      continue;
    }
    if (run.artifactCount > before.artifactCount) {
      cues.push({ type: "crate", ...crateForRun(run) });
    }
    const tokenDelta = run.tokens - before.tokens;
    if (tokenDelta > 0) {
      tokens += tokenDelta;
    }
    const costDelta = run.costCny - before.costCny;
    if (costDelta > 0) {
      costCny += costDelta;
    }
    if (run.status === before.status) {
      continue;
    }
    if (run.status === "failed") {
      failed += 1;
      reversedRun ??= run.runId;
    } else if (run.status === "cancelled") {
      reversedRun ??= run.runId;
    } else if (run.status === "succeeded") {
      passed += 1;
    } else if (
      before.status === "paused" &&
      (run.status === "running" || run.status === "queued")
    ) {
      passed += 1;
    }
  }

  if (tokens > 0 || costCny > 0) {
    cues.push({ type: "flow", tokens, costCny });
  }
  if (passed > 0) {
    cues.push({ type: "stamp", outcome: "passed" });
  }
  if (failed > 0) {
    cues.push({ type: "stamp", outcome: "failed" });
  }
  if (reversedRun) {
    cues.push({ type: "reverse", runId: reversedRun });
  }

  const previousAgents = new Map(
    previous.agents.map((agent) => [agent.agentId, agent]),
  );
  for (const agent of next.agents) {
    const tool = toolChange(previousAgents.get(agent.agentId), agent);
    if (tool) {
      cues.push({ type: "tool", agentId: agent.agentId, tool });
    }
  }

  return cues;
}

function toolChange(
  before: AgentState | undefined,
  after: AgentState,
): string | null {
  const tool = after.currentTool;
  if (!tool) {
    return null;
  }
  return before?.currentTool === tool ? null : tool;
}
