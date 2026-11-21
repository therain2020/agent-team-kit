import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { bootstrapHome } from "./paths";

/**
 * Zero-config time-to-first-value (TTHW) ledger (plan 91 §3.2/§5, 98 §5.2 S12).
 *
 * The clock starts on the first zero-config command (`kit up`, `kit bootstrap`
 * or `kit demo`) and stops at the furthest milestone reached:
 *
 * - `profile`: the model key was accepted and the bootstrap profile written.
 * - `demo`: the built-in demo team and static plan were produced.
 *
 * Model probe latency is excluded because plan 91 measures TTHW "不含模型延迟".
 * Both the start and the milestones are recorded on disk; the gate collector
 * only reads the persisted number and reports a GAP when it is absent.
 */
export const COLD_START_TTHW_API_VERSION = "agentteam/v1";
export const COLD_START_TTHW_KIND = "ZeroConfigTthw";

export type ColdStartMilestone = "profile" | "demo";

export interface ColdStartMilestoneRecord {
  at: string;
  flow: string;
  modelLatencyMs: number | null;
}

export interface ColdStartTthwRecord {
  apiVersion: typeof COLD_START_TTHW_API_VERSION;
  kind: typeof COLD_START_TTHW_KIND;
  startedAt: string | null;
  updatedAt: string;
  readyAt: string | null;
  milestones: Partial<Record<ColdStartMilestone, ColdStartMilestoneRecord>>;
  /** Total model-probe latency excluded from both milestones. */
  modelLatencyMs: number;
  tthwMinutes: number | null;
  measure: ColdStartMilestone | null;
  mode: string | null;
}

export interface ColdStartTthwEnv {
  [key: string]: string | undefined;
}

export function coldStartTthwPath(
  env: ColdStartTthwEnv = process.env,
): string {
  return path.join(bootstrapHome(env), "cold-start-tthw.json");
}

/** Reads the ledger without throwing; malformed files read as absent. */
export function readColdStartTthwSync(
  env: ColdStartTthwEnv = process.env,
): ColdStartTthwRecord | null {
  try {
    const parsed = JSON.parse(
      readFileSync(coldStartTthwPath(env), "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const raw = parsed as Record<string, unknown>;
    if (
      raw.apiVersion !== COLD_START_TTHW_API_VERSION ||
      raw.kind !== COLD_START_TTHW_KIND
    ) {
      return null;
    }
    const startedAt = stringOrNull(raw.startedAt);
    const readyAt = stringOrNull(raw.readyAt);
    const tthwMinutes = numberOrNull(raw.tthwMinutes);
    const measure =
      raw.measure === "profile" || raw.measure === "demo" ? raw.measure : null;
    const milestones: ColdStartTthwRecord["milestones"] = {};
    const rawMilestones =
      raw.milestones && typeof raw.milestones === "object"
        ? (raw.milestones as Record<string, unknown>)
        : {};
    for (const key of ["profile", "demo"] as const) {
      const entry = rawMilestones[key];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const item = entry as Record<string, unknown>;
      const at = stringOrNull(item.at);
      const flow = typeof item.flow === "string" ? item.flow : "";
      if (!at || !flow) {
        continue;
      }
      milestones[key] = {
        at,
        flow,
        modelLatencyMs: numberOrNull(item.modelLatencyMs),
      };
    }
    return {
      apiVersion: COLD_START_TTHW_API_VERSION,
      kind: COLD_START_TTHW_KIND,
      startedAt,
      updatedAt: stringOrNull(raw.updatedAt) ?? startedAt ?? "",
      readyAt,
      milestones,
      modelLatencyMs: numberOrNull(raw.modelLatencyMs) ?? 0,
      tthwMinutes,
      measure,
      mode: stringOrNull(raw.mode),
    };
  } catch {
    return null;
  }
}

export interface MarkColdStartStartedOptions {
  env?: ColdStartTthwEnv;
  now?: Date;
  mode?: string | null;
}

/**
 * Records the first zero-config invocation. Idempotent: an existing start is
 * never moved, and a ledger that already has a milestone but lost its start is
 * left alone so a fabricated near-zero TTHW cannot be produced.
 */
export async function markColdStartStarted(
  options: MarkColdStartStartedOptions = {},
): Promise<ColdStartTthwRecord> {
  const env = options.env ?? process.env;
  const now = (options.now ?? new Date()).toISOString();
  const existing = readColdStartTthwSync(env);
  if (existing) {
    if (existing.startedAt || Object.keys(existing.milestones).length > 0) {
      return existing;
    }
    existing.startedAt = now;
    existing.mode = options.mode ?? existing.mode;
    existing.updatedAt = now;
    computeTthw(existing);
    await writeColdStartTthw(existing, env);
    return existing;
  }
  const record = emptyRecord(now, options.mode ?? null);
  record.startedAt = now;
  computeTthw(record);
  await writeColdStartTthw(record, env);
  return record;
}

export interface RecordColdStartMilestoneOptions {
  env?: ColdStartTthwEnv;
  now?: Date;
  flow: string;
  mode?: string | null;
  /** Model probe latency to exclude; only meaningful for the profile step. */
  modelLatencyMs?: number | null;
}

/**
 * Records a first-value milestone and recomputes TTHW from the persisted start.
 * Without a start marker the measurement stays `null`; it is never invented.
 *
 * Milestones are kept on first occurrence: re-running `kit demo` or
 * re-entering a key must not move the "first value" timestamp and inflate or
 * shrink an already measured install.
 */
export async function recordColdStartMilestone(
  milestone: ColdStartMilestone,
  options: RecordColdStartMilestoneOptions,
): Promise<ColdStartTthwRecord> {
  const env = options.env ?? process.env;
  const now = (options.now ?? new Date()).toISOString();
  const record = readColdStartTthwSync(env) ?? emptyRecord(now, null);
  if (record.milestones[milestone]) {
    return record;
  }
  const latency =
    milestone === "profile" &&
    typeof options.modelLatencyMs === "number" &&
    Number.isFinite(options.modelLatencyMs) &&
    options.modelLatencyMs >= 0
      ? Math.trunc(options.modelLatencyMs)
      : null;
  record.milestones[milestone] = {
    at: now,
    flow: options.flow,
    modelLatencyMs: latency,
  };
  record.mode = options.mode ?? record.mode;
  record.updatedAt = now;
  computeTthw(record);
  await writeColdStartTthw(record, env);
  return record;
}

function emptyRecord(now: string, mode: string | null): ColdStartTthwRecord {
  return {
    apiVersion: COLD_START_TTHW_API_VERSION,
    kind: COLD_START_TTHW_KIND,
    startedAt: null,
    updatedAt: now,
    readyAt: null,
    milestones: {},
    modelLatencyMs: 0,
    tthwMinutes: null,
    measure: null,
    mode,
  };
}

function computeTthw(record: ColdStartTthwRecord): void {
  const demo = record.milestones.demo;
  const profile = record.milestones.profile;
  const chosen = demo ?? profile ?? null;
  record.readyAt = chosen?.at ?? null;
  record.measure = demo ? "demo" : profile ? "profile" : null;
  record.modelLatencyMs = profile?.modelLatencyMs ?? 0;
  if (!record.startedAt || !chosen) {
    record.tthwMinutes = null;
    return;
  }
  const elapsedMs =
    Date.parse(chosen.at) -
    Date.parse(record.startedAt) -
    record.modelLatencyMs;
  if (!Number.isFinite(elapsedMs)) {
    record.tthwMinutes = null;
    return;
  }
  record.tthwMinutes = Math.max(0, Math.round(elapsedMs / 60) / 1000);
}

async function writeColdStartTthw(
  record: ColdStartTthwRecord,
  env: ColdStartTthwEnv,
): Promise<void> {
  const file = coldStartTthwPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temp, file);
  } catch {
    // Windows can refuse a rename over an open handle; fall back to a direct
    // write so a measurement is never lost to a transient sharing violation.
    await writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Re-exported so callers can check for a ledger without duplicating paths. */
export function coldStartTthwExists(
  env: ColdStartTthwEnv = process.env,
): boolean {
  return existsSync(coldStartTthwPath(env));
}
