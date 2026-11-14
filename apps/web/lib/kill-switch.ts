import type { KillSwitch } from "@kit/core";
import { listKillSwitches } from "@kit/engine";
import { ensureStoreSchema, getStore } from "./store";

export interface KillSwitchState {
  active: KillSwitch[];
  recent: KillSwitch[];
}

export async function loadKillSwitchState(
  limit = 50,
): Promise<KillSwitchState> {
  await ensureStoreSchema();
  return listKillSwitches(getStore(), limit);
}
