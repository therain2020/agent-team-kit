import type { AutopilotStateRecord, AutopilotStateStore } from "@kit/store";

export type AutopilotState = AutopilotStateRecord;

export async function ensureState(
  store: AutopilotStateStore,
  workspaceId: string,
  packDir: string,
  defaultEnabled: boolean,
  now: Date = new Date(),
): Promise<AutopilotState> {
  const existing = await store.get(workspaceId, packDir);
  if (existing) {
    return resetDaily(existing, now);
  }

  await store.insertIfMissing({
    workspaceId,
    packDir,
    enabled: defaultEnabled,
    lastTickAt: null,
    nextRuns: {},
    day: null,
    runsToday: 0,
    spentToday: 0,
    lastError: null,
    updatedAt: now.toISOString(),
  });

  const created = await store.get(workspaceId, packDir);
  if (!created) {
    throw new Error("failed to create autopilot state");
  }
  return resetDaily(created, now);
}

export function getState(
  store: AutopilotStateStore,
  workspaceId: string,
  packDir: string,
): Promise<AutopilotState | null> {
  return store.get(workspaceId, packDir);
}

export function listStates(
  store: AutopilotStateStore,
  workspaceId: string,
): Promise<AutopilotState[]> {
  return store.list(workspaceId);
}

export async function saveState(
  store: AutopilotStateStore,
  state: AutopilotState,
): Promise<void> {
  await store.update(state);
}

export function resetDaily(
  state: AutopilotState,
  now: Date = new Date(),
): AutopilotState {
  const today = now.toISOString().slice(0, 10);
  if (state.day === today) {
    return state;
  }
  return {
    ...state,
    day: today,
    runsToday: 0,
    spentToday: 0,
  };
}
