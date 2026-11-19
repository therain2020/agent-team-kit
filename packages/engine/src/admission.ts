import { PRIORITY_PROFILES, type PriorityClass } from "@kit/core";

/**
 * Admission control for queued work (60 §3.4; issue #21).
 *
 * Ordering is deliberate: budget and kill switch are evaluated *before* the
 * queue — a stalled queue must never delay a hard stop. Only then does
 * priority decide between admitting, merging or dropping low-value work.
 */

export type AdmissionBlockReason =
  | { kind: "budget"; detail: string }
  | { kind: "kill-switch"; detail: string };

export type AdmissionAction = "admit" | "queue" | "drop" | "merge" | "reject";

export interface AdmissionInput {
  priority: PriorityClass;
  /** Budget/kill-switch verdict computed ahead of the queue. */
  blockedBy?: AdmissionBlockReason | null;
  /** Same idempotency key/run already queued: fold the event (rule 10). */
  duplicate?: boolean;
  queueDepth: number;
  maxQueueDepth: number;
}

export interface AdmissionDecision {
  action: AdmissionAction;
  reason: string;
}

export const DEFAULT_MAX_QUEUE_DEPTH = 100;

export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  if (input.blockedBy) {
    return {
      action: "reject",
      reason: `${input.blockedBy.kind}: ${input.blockedBy.detail}`,
    };
  }
  if (input.duplicate) {
    return {
      action: "merge",
      reason: "duplicate event merged into queued item",
    };
  }
  if (input.priority === "P0") {
    return { action: "admit", reason: "P0 bypasses queue rotation" };
  }
  const full = input.queueDepth >= Math.max(0, input.maxQueueDepth);
  if (full && !PRIORITY_PROFILES[input.priority].queueable) {
    return { action: "drop", reason: `${input.priority} is not queueable` };
  }
  if (full && input.priority === "P3") {
    return {
      action: "drop",
      reason: `queue full (${input.queueDepth}/${input.maxQueueDepth}); P3 dropped`,
    };
  }
  return {
    action: "queue",
    reason: full
      ? `queue full; ${input.priority} waits for a slot`
      : `${input.priority} queued`,
  };
}

/** Operator knobs for the admission gate. */
export interface AdmissionPolicy {
  maxQueueDepth: number;
}

export function loadAdmissionPolicy(
  env: Record<string, string | undefined> = process.env,
): AdmissionPolicy {
  const raw = env.KIT_ADMISSION_MAX_QUEUE_DEPTH;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return {
    maxQueueDepth:
      Number.isFinite(parsed) && parsed >= 0
        ? Math.trunc(parsed)
        : DEFAULT_MAX_QUEUE_DEPTH,
  };
}
