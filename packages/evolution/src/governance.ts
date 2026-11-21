import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "@kit/core";

/**
 * Divergence and drift events raised by the Goodhart/drift guards (70 §3.4,
 * §3.5). An event explains why evolution paused, alerted or demanded a full
 * champion re-evaluation, so the reason survives even after the freeze switch
 * is lifted.
 *
 * The event log is an adapter for the CLI and console. The durable copy lives
 * on the cycle record (`divergence`/`drift`) and in the freeze state; the
 * event log never becomes the source of truth (D-52).
 */
export type EvolutionGovernanceKind = "divergence" | "drift";

export type EvolutionGovernanceAction = "paused" | "alert" | "reevaluate";

export interface EvolutionGovernanceEvent {
  eventId: string;
  workspaceId: string;
  kind: EvolutionGovernanceKind;
  action: EvolutionGovernanceAction;
  reason: string;
  /** Cycles that produced the evidence behind this event. */
  cycleIds: string[];
  details?: Record<string, unknown>;
  createdAt: string;
}

export function defaultGovernancePath(variantsRoot = "variants"): string {
  return path.join(variantsRoot, "governance.jsonl");
}

export async function appendGovernanceEvent(
  input: Omit<EvolutionGovernanceEvent, "eventId" | "createdAt"> & {
    createdAt?: string;
  },
  file: string = defaultGovernancePath(),
): Promise<EvolutionGovernanceEvent> {
  const event: EvolutionGovernanceEvent = {
    eventId: newId("gve"),
    workspaceId: input.workspaceId,
    kind: input.kind,
    action: input.action,
    reason: input.reason,
    cycleIds: [...input.cycleIds],
    ...(input.details ? { details: input.details } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

/**
 * Reads the event log newest-first. Missing or corrupt lines are skipped: an
 * unreadable log must not break status reporting, and the cycle/freeze state
 * still carries the authoritative reason.
 */
export async function loadGovernanceEvents(
  file: string = defaultGovernancePath(),
  limit = 20,
): Promise<EvolutionGovernanceEvent[]> {
  if (!existsSync(file)) {
    return [];
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const events: EvolutionGovernanceEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isGovernanceEvent(parsed)) {
      events.push(parsed);
    }
  }
  return events
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function isGovernanceEvent(
  value: unknown,
): value is EvolutionGovernanceEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" &&
    typeof record.workspaceId === "string" &&
    (record.kind === "divergence" || record.kind === "drift") &&
    (record.action === "paused" ||
      record.action === "alert" ||
      record.action === "reevaluate") &&
    typeof record.reason === "string" &&
    Array.isArray(record.cycleIds) &&
    record.cycleIds.every((id) => typeof id === "string") &&
    typeof record.createdAt === "string"
  );
}
