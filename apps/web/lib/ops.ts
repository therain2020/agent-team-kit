import {
  type AlertInput,
  type AlertRecord,
  type AlertStatus,
  type AlertTier,
  type AutonomyLevel,
  type AutonomyPresetRecord,
  DEFAULT_WORKSPACE_ID,
  type OnCallPolicy,
  type OpsGate,
  ackAlert,
  emitAlert,
  getActiveAutonomyPreset,
  getOpsGate,
  getOpsPolicy,
  listAlerts,
  saveOpsPolicy,
} from "@kit/ops";
import { ensureStoreSchema, getStore } from "./store";

export interface OpsAutonomyView {
  level: AutonomyLevel;
  preset: AutonomyPresetRecord | null;
  liveAllowed: boolean;
}

export interface OpsConsoleData {
  policy: OnCallPolicy;
  gate: OpsGate;
  alerts: AlertRecord[];
  autonomy: OpsAutonomyView;
}

export async function loadOpsConsole(): Promise<OpsConsoleData> {
  await ensureStoreSchema();
  const store = getStore();
  const [policy, gate, alerts, preset] = await Promise.all([
    getOpsPolicy(store, DEFAULT_WORKSPACE_ID),
    getOpsGate(store, new Date(), DEFAULT_WORKSPACE_ID),
    listAlerts(store, { workspaceId: DEFAULT_WORKSPACE_ID, limit: 50 }),
    getActiveAutonomyPreset(store, DEFAULT_WORKSPACE_ID),
  ]);
  return {
    policy,
    gate,
    alerts,
    autonomy: {
      level: preset ? preset.level : "manual",
      preset,
      liveAllowed: process.env.KIT_UI_ALLOW_LIVE === "1" || preset !== null,
    },
  };
}

export async function loadOpsAlerts(filter: {
  status?: AlertStatus;
  tier?: AlertTier;
  limit?: number;
}): Promise<AlertRecord[]> {
  await ensureStoreSchema();
  return await listAlerts(getStore(), {
    workspaceId: DEFAULT_WORKSPACE_ID,
    ...filter,
  });
}

export async function saveOpsConsolePolicy(patch: unknown): Promise<{
  policy: OnCallPolicy;
  gate: OpsGate;
}> {
  await ensureStoreSchema();
  const store = getStore();
  const policy = await saveOpsPolicy(store, DEFAULT_WORKSPACE_ID, patch);
  const gate = await getOpsGate(store, new Date(), DEFAULT_WORKSPACE_ID);
  return { policy, gate };
}

export async function ackOpsAlert(
  alertId: string,
  actor: string,
): Promise<AlertRecord | null> {
  await ensureStoreSchema();
  return await ackAlert(getStore(), alertId, actor);
}

export async function emitOpsAlert(input: AlertInput) {
  await ensureStoreSchema();
  return await emitAlert(getStore(), input);
}
