import type { ActivityEvent } from "@kit/activity";

/**
 * Data → motion mapping for the pixel surfaces (89 §3.2, 97 §3.2).
 *
 * Everything the primitives animate is derived here from activity events, so
 * a quiet workspace produces no cues at all: no ambient loops, no decorative
 * timers. The mapping is pure and unit-tested; components only render cues.
 */

export type PixelAgentState = "idle" | "working" | "blocked" | "waiting";
export type StampOutcome = "passed" | "failed";

export type PixelCue =
  | {
      type: "agent";
      agentId: string;
      state: PixelAgentState;
      seq: number;
    }
  | {
      type: "tool";
      agentId: string;
      tool: string;
      seq: number;
    }
  | {
      type: "crate";
      runId: string;
      label: string;
      bad: boolean;
      seq: number;
    }
  | { type: "stamp"; outcome: StampOutcome; seq: number }
  | { type: "reverse"; seq: number };

/** Belt crates kept in memory; older crates fall off the far end. */
export const MAX_BELT_CRATES = 12;
/** Per-agent state switches are rate limited (97 §3.2). */
export const PRESENCE_MIN_INTERVAL_MS = 500;
export const PIXEL_MOTION_STORAGE_KEY = "kit.pixel.motion";

const WORKING_KINDS = new Set([
  "run.started",
  "stage.started",
  "stage.finished",
  "stage.reused",
  "model.turn",
  "coder.started",
  "coder.finished",
  "iteration.run.started",
  "iteration.plan",
  "iteration.coder.turn",
  "iteration.coder.tool",
  "iteration.coder.started",
  "iteration.coder.finished",
  "iteration.repair",
  "iteration.verify",
  "iteration.risk",
  "iteration.apply",
]);

const FAILED_KINDS = new Set([
  "run.failed",
  "stage.failed",
  "iteration.run.failed",
  "budget.exceeded",
  "ops.side_effect.blocked",
]);

const APPROVED_STATUSES = new Set([
  "approve",
  "approved",
  "allow",
  "allowed",
  "resume",
  "resumed",
  "pass",
  "passed",
]);

const REJECTED_STATUSES = new Set([
  "abort",
  "aborted",
  "reject",
  "rejected",
  "deny",
  "denied",
  "cancel",
  "cancelled",
  "canceled",
]);

/** Synthetic actors should not become pixel agents. */
const NON_AGENT_IDS = new Set(["operator", "workflow"]);

export function cueFromActivity(event: ActivityEvent): PixelCue[] {
  const seq = event.eventId;
  const kind = event.kind;
  const lowered = kind.toLowerCase();
  const status = (event.status ?? "").toLowerCase();
  const agentId =
    event.agentId && !NON_AGENT_IDS.has(event.agentId) ? event.agentId : null;

  let agentState: PixelAgentState | null = null;
  let tool: string | null = null;
  let crate: Extract<PixelCue, { type: "crate" }> | null = null;
  let stamp: StampOutcome | null = null;
  let reverse = false;

  const state = (next: PixelAgentState) => {
    agentState = next;
  };

  if (lowered.includes("rollback") || lowered.includes("revert")) {
    reverse = true;
  }

  switch (kind) {
    case "tool.call":
      state("working");
      tool = event.tool ?? event.summary ?? "tool";
      break;
    case "tool.result":
      state("working");
      break;
    case "artifact.published":
      state("working");
      if (event.runId) {
        crate = {
          type: "crate",
          runId: event.runId,
          label: crateLabel(event),
          bad: false,
          seq,
        };
      }
      break;
    case "gate.evaluated":
    case "gate.failed": {
      const failed = kind === "gate.failed" || status === "failed";
      stamp = failed ? "failed" : "passed";
      reverse = failed;
      state("working");
      break;
    }
    case "approval.requested":
      state("blocked");
      break;
    case "approval.decided": {
      if (REJECTED_STATUSES.has(status)) {
        stamp = "failed";
        reverse = true;
        state("idle");
      } else {
        stamp = "passed";
        state(APPROVED_STATUSES.has(status) ? "working" : "idle");
      }
      break;
    }
    case "run.finished":
    case "iteration.run.finished":
      state("idle");
      break;
    default:
      if (WORKING_KINDS.has(kind)) {
        state("working");
      } else if (FAILED_KINDS.has(kind)) {
        state("blocked");
      }
      break;
  }

  if (status === "paused" && agentState === null) {
    state("blocked");
  }

  const cues: PixelCue[] = [];
  if (agentId && agentState) {
    cues.push({ type: "agent", agentId, state: agentState, seq });
  }
  if (agentId && tool) {
    cues.push({ type: "tool", agentId, tool, seq });
  }
  if (crate) {
    cues.push(crate);
  }
  if (stamp) {
    cues.push({ type: "stamp", outcome: stamp, seq });
  }
  if (reverse) {
    cues.push({ type: "reverse", seq });
  }
  return cues;
}

function crateLabel(event: ActivityEvent): string {
  const raw = event.summary ?? event.runId ?? "artifact";
  return raw.length <= 10 ? raw : raw.slice(-10);
}

/**
 * Appends a crate cue to the belt. Re-publishing the same run replaces its
 * crate in place; the belt keeps at most `MAX_BELT_CRATES` entries so a busy
 * workspace cannot grow the DOM without bound.
 */
export function pushCrate(
  crates: PixelCue[],
  cue: PixelCue,
  limit = MAX_BELT_CRATES,
): PixelCue[] {
  if (cue.type !== "crate") {
    return crates;
  }
  const without = crates.filter(
    (entry) => entry.type !== "crate" || entry.runId !== cue.runId,
  );
  const next = [...without, cue];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export interface PresenceEntry {
  state: PixelAgentState;
  at: number;
}

export type PresenceMap = Record<string, PresenceEntry>;

/**
 * Applies an agent state cue with a per-agent debounce: a switch requested
 * less than `minInterval` after the previous one is dropped, so a burst of
 * tokens/tools cannot strobe the sprite.
 */
export function applyPresence(
  current: PresenceMap,
  agentId: string,
  state: PixelAgentState,
  nowMs: number,
  minInterval = PRESENCE_MIN_INTERVAL_MS,
): PresenceMap {
  const previous = current[agentId];
  if (previous) {
    if (previous.state === state) {
      return current;
    }
    if (nowMs - previous.at < minInterval) {
      return current;
    }
  }
  return { ...current, [agentId]: { state, at: nowMs } };
}

/** Pixel sprite state for an office roster status (error stays blocked+red). */
export function pixelStateFromStatus(status: string): PixelAgentState {
  switch (status) {
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "blocked":
    case "error":
      return "blocked";
    default:
      return "idle";
  }
}

/** Collapses a pixel state back onto the roster vocabulary used by labels. */
export function statusFromPixelState(state: PixelAgentState): string {
  return state === "waiting" ? "idle" : state;
}

/** Motion is off when the user turned it off or the OS asks to reduce it. */
export function resolveMotionEnabled(
  preference: boolean,
  reduced: boolean,
): boolean {
  return preference && !reduced;
}
