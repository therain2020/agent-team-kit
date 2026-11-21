import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Automatic reaction signals (98 §3.3, §5.2 G2, issue #259).
 *
 * Every terminal reaction decision is appended to `<signals>/reactions.jsonl`
 * at the same point that writes the reaction op-log entry, so the file is a
 * projection of real reactions rather than a human-curated sampling file. The
 * human usefulness judgement keeps its own record shape in the same file
 * (docs/gate-report.md#reaction-sampling); `kind` tells them apart.
 *
 * Identity: `signalId` is a deterministic hash of the reaction slot
 * (workspace, event, rule, trigger run) plus the outcome family. Retries that
 * land on the same slot therefore resolve to the same id and are not appended
 * twice — `fired` and the replay view `existing` share one family, and a
 * failed launch sharing the trigger run id of a later successful retry keeps
 * its own family so recovery remains visible.
 *
 * The file stays an adapter layer (D-52): the durable audit copy of every
 * reaction is the `reaction.*` op-log row written in the same call.
 */
export type ReactionSignalOutcome =
  | "fired"
  | "existing"
  | "failed"
  | "skipped"
  | "budget-exhausted"
  | "cap-reached";

export interface ReactionSignalRecord {
  kind: "reaction.outcome";
  /** Deterministic id; identical completions resolve to the same value. */
  signalId: string;
  at: string;
  workspaceId: string;
  eventId: string;
  ruleId: string;
  ruleVersion: number;
  triggerRunId: string | null;
  jobId: string | null;
  outcome: ReactionSignalOutcome;
  /** Dispatch gate the reaction stopped at, or `write-back` when it started. */
  gate: string | null;
  reason: string | null;
  /** Reaction identity: `eventId:ruleId` (same key `fireTrigger` dedupes on). */
  dedupeKey: string;
}

export interface ReactionSignalFile {
  path: string;
  signals: ReactionSignalRecord[];
  /** Per-line problems (unparseable or schema-invalid records). */
  corrupt: number;
}

const SIGNAL_OUTCOMES = new Set<ReactionSignalOutcome>([
  "fired",
  "existing",
  "failed",
  "skipped",
  "budget-exhausted",
  "cap-reached",
]);

/**
 * Signals live next to the other JSONL signal files. `KIT_SIGNALS_ROOT`
 * wins; otherwise `KIT_HOME/signals`, otherwise `~/.agent-team-kit/signals`,
 * so the gate-report default (`<KIT_HOME>/signals`) and the producer agree.
 */
export function reactionSignalsRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.KIT_SIGNALS_ROOT ??
    (env.KIT_HOME
      ? path.join(env.KIT_HOME, "signals")
      : path.join(os.homedir(), ".agent-team-kit", "signals"))
  );
}

export function defaultReactionsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(reactionSignalsRoot(env), "reactions.jsonl");
}

/**
 * `fired` and `existing` describe the same physical reaction (the second is
 * the dedupe replay view), so they share a family and only the first signal
 * is written. Every other outcome keeps its own identity.
 */
function outcomeFamily(outcome: ReactionSignalOutcome): string {
  return outcome === "fired" || outcome === "existing" ? "launched" : outcome;
}

export function reactionSignalId(input: {
  workspaceId: string;
  eventId: string;
  ruleId: string;
  triggerRunId: string | null;
  outcome: ReactionSignalOutcome;
}): string {
  const key = [
    input.workspaceId,
    input.eventId,
    input.ruleId,
    input.triggerRunId ?? "",
    outcomeFamily(input.outcome),
  ].join("|");
  return `rsg_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function isReactionSignalRecord(
  value: unknown,
): value is ReactionSignalRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === "reaction.outcome" &&
    typeof record.signalId === "string" &&
    record.signalId.length > 0 &&
    typeof record.at === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.eventId === "string" &&
    record.eventId.length > 0 &&
    typeof record.ruleId === "string" &&
    record.ruleId.length > 0 &&
    typeof record.ruleVersion === "number" &&
    Number.isFinite(record.ruleVersion) &&
    (record.triggerRunId === null || typeof record.triggerRunId === "string") &&
    (record.jobId === null || typeof record.jobId === "string") &&
    typeof record.outcome === "string" &&
    SIGNAL_OUTCOMES.has(record.outcome as ReactionSignalOutcome) &&
    (record.gate === null || typeof record.gate === "string") &&
    (record.reason === null || typeof record.reason === "string") &&
    typeof record.dedupeKey === "string" &&
    record.dedupeKey.length > 0
  );
}

/**
 * Append one signal unless an identical one is already on disk. The scan is a
 * plain substring test for the deterministic id: the file is append-only and
 * bounded by the reaction budget, and a partial trailing line from a crashed
 * append must not prevent the next write (the collector collapses duplicate
 * ids defensively anyway).
 *
 * Returns false when the signal already existed. IO errors propagate so the
 * caller can surface them without failing the dispatch that already happened.
 */
export async function appendReactionSignal(
  record: ReactionSignalRecord,
  options: { file?: string } = {},
): Promise<boolean> {
  const file = options.file ?? defaultReactionsPath();
  const line = `${JSON.stringify(record)}\n`;
  if (await hasSignalId(file, record.signalId)) {
    return false;
  }
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await appendFile(file, line, "utf8");
  return true;
}

/** Reads the automatic signals from a reactions file (defensively). */
export async function readReactionSignals(
  file: string = defaultReactionsPath(),
): Promise<ReactionSignalFile> {
  if (!existsSync(file)) {
    return { path: file, signals: [], corrupt: 0 };
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { path: file, signals: [], corrupt: 0 };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const signals: ReactionSignalRecord[] = [];
  const seen = new Set<string>();
  let corrupt = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!isReactionSignalRecord(parsed)) {
      // Human usefulness samples share the file; they are not corrupt.
      if (isHumanReactionSample(parsed)) {
        continue;
      }
      corrupt += 1;
      continue;
    }
    if (seen.has(parsed.signalId)) {
      continue;
    }
    seen.add(parsed.signalId);
    signals.push(parsed);
  }
  return { path: file, signals, corrupt };
}

function isHumanReactionSample(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === "string" &&
    typeof record.eventId === "string" &&
    typeof record.useful === "boolean"
  );
}

async function hasSignalId(file: string, signalId: string): Promise<boolean> {
  try {
    const text = await readFile(file, "utf8");
    return text.includes(signalId);
  } catch {
    return false;
  }
}
