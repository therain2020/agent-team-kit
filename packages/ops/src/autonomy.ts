import { appendActivity } from "@kit/activity";
import { newId } from "@kit/core";
import { z } from "zod";
import { DEFAULT_WORKSPACE_ID } from "./models";
import type { OpsStore } from "./repo";

export const AUTONOMY_LEVELS = ["manual", "self-hosted-live"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_PRESET_STATUSES = [
  "active",
  "superseded",
  "rolled_back",
] as const;
export type AutonomyPresetStatus = (typeof AUTONOMY_PRESET_STATUSES)[number];

export const autonomyPresetConfigSchema = z.object({
  applyMode: z.enum(["low", "low-medium"]).default("low-medium"),
  dailyCostCny: z.number().nonnegative().default(5),
  dailyRuns: z.number().int().positive().default(2),
  maxTasks: z.number().int().min(1).max(10).default(2),
  allowNight: z.boolean().default(true),
});

export type AutonomyPresetConfig = z.infer<typeof autonomyPresetConfigSchema>;
export type AutonomyPresetConfigInput = z.input<
  typeof autonomyPresetConfigSchema
>;

export interface AutonomyPresetRecord {
  presetId: string;
  workspaceId: string;
  level: Extract<AutonomyLevel, "self-hosted-live">;
  status: AutonomyPresetStatus;
  config: AutonomyPresetConfig;
  appliedBy: string;
  appliedAt: string;
  rolledBackBy: string | null;
  rolledBackAt: string | null;
  rollbackReason: string | null;
  updatedAt: string;
}

export const DEFAULT_AUTONOMY_PRESET_CONFIG: AutonomyPresetConfig =
  autonomyPresetConfigSchema.parse({});

export function parseAutonomyPresetConfig(
  input: unknown,
): AutonomyPresetConfig {
  return autonomyPresetConfigSchema.parse(input ?? {});
}

interface PresetRow {
  preset_id: string;
  workspace_id: string;
  level: string;
  status: string;
  config: unknown;
  applied_by: string;
  applied_at: string | Date;
  rolled_back_by: string | null;
  rolled_back_at: string | Date | null;
  rollback_reason: string | null;
  updated_at: string | Date;
}

export async function getActiveAutonomyPreset(
  store: OpsStore,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<AutonomyPresetRecord | null> {
  try {
    const rows = await store.sql<PresetRow[]>`
      SELECT * FROM ops_autonomy_presets
      WHERE workspace_id = ${workspaceId} AND status = 'active'
      ORDER BY applied_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    return row ? mapPreset(row) : null;
  } catch {
    // A missing table means the preset was never used: stay at the factory
    // default instead of failing every gate evaluation.
    return null;
  }
}

export async function enableAutonomyPreset(
  store: OpsStore,
  input: {
    config?: AutonomyPresetConfigInput;
    actor?: string;
    reason?: string;
    workspaceId?: string;
    now?: Date;
  } = {},
): Promise<AutonomyPresetRecord> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const config = parseAutonomyPresetConfig(input.config);
  const actor = input.actor ?? "operator:cli";
  const presetId = newId("aps");
  const previous = await getActiveAutonomyPreset(store, workspaceId);

  await store.sql.begin(async (tx) => {
    await tx`
      UPDATE ops_autonomy_presets
      SET status = ${"superseded"}, updated_at = ${nowIso}
      WHERE workspace_id = ${workspaceId} AND status = 'active'
    `;
    await tx`
      INSERT INTO ops_autonomy_presets (
        preset_id, workspace_id, level, status, config, applied_by,
        applied_at, rolled_back_by, rolled_back_at, rollback_reason, updated_at
      ) VALUES (
        ${presetId}, ${workspaceId}, ${"self-hosted-live"}, ${"active"},
        ${JSON.stringify(config)}, ${actor}, ${nowIso}, ${null}, ${null},
        ${null}, ${nowIso}
      )
    `;
  });

  const preset = await getPreset(store, presetId);
  if (!preset) {
    throw new Error(`failed to persist autonomy preset ${presetId}`);
  }

  await appendActivity(store, {
    workspaceId,
    agentId: "ops",
    kind: "ops.autonomy.enabled",
    status: "active",
    summary: `enabled ${presetId}: LIVE ${config.applyMode}, ${config.dailyCostCny} CNY/day`,
    payload: {
      presetId,
      level: preset.level,
      config,
      reason: input.reason ?? null,
      previousPresetId: previous?.presetId ?? null,
    },
    createdAt: nowIso,
  });

  return preset;
}

export async function rollbackAutonomyPreset(
  store: OpsStore,
  input: {
    actor?: string;
    reason?: string;
    workspaceId?: string;
    now?: Date;
  } = {},
): Promise<AutonomyPresetRecord | null> {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = input.actor ?? "operator:cli";
  const active = await getActiveAutonomyPreset(store, workspaceId);
  if (!active) {
    return null;
  }

  await store.sql`
    UPDATE ops_autonomy_presets SET
      status = ${"rolled_back"},
      rolled_back_by = ${actor},
      rolled_back_at = ${nowIso},
      rollback_reason = ${input.reason ?? null},
      updated_at = ${nowIso}
    WHERE preset_id = ${active.presetId} AND status = 'active'
  `;

  const rolledBack = await getPreset(store, active.presetId);
  if (!rolledBack) {
    throw new Error(`failed to roll back autonomy preset ${active.presetId}`);
  }

  await appendActivity(store, {
    workspaceId,
    agentId: "ops",
    kind: "ops.autonomy.rolled_back",
    status: "rolled_back",
    summary: `rolled back ${active.presetId}: restored factory defaults`,
    payload: {
      presetId: active.presetId,
      level: active.level,
      config: active.config,
      reason: input.reason ?? null,
    },
    createdAt: nowIso,
  });

  return rolledBack;
}

async function getPreset(
  store: OpsStore,
  presetId: string,
): Promise<AutonomyPresetRecord | null> {
  const rows = await store.sql<PresetRow[]>`
    SELECT * FROM ops_autonomy_presets WHERE preset_id = ${presetId} LIMIT 1
  `;
  const row = rows[0];
  return row ? mapPreset(row) : null;
}

function mapPreset(row: PresetRow): AutonomyPresetRecord {
  const parsed = autonomyPresetConfigSchema.safeParse(parseJson(row.config));
  return {
    presetId: row.preset_id,
    workspaceId: row.workspace_id,
    level: "self-hosted-live",
    status: parseStatus(row.status),
    config: parsed.success ? parsed.data : DEFAULT_AUTONOMY_PRESET_CONFIG,
    appliedBy: row.applied_by,
    appliedAt: toIso(row.applied_at),
    rolledBackBy: row.rolled_back_by,
    rolledBackAt: row.rolled_back_at ? toIso(row.rolled_back_at) : null,
    rollbackReason: row.rollback_reason,
    updatedAt: toIso(row.updated_at),
  };
}

function parseStatus(value: string): AutonomyPresetStatus {
  return AUTONOMY_PRESET_STATUSES.includes(value as AutonomyPresetStatus)
    ? (value as AutonomyPresetStatus)
    : "active";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
