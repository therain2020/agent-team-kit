import {
  DEFAULT_WORKSPACE_ID,
  type NightModeAction,
  type OnCallPolicy,
} from "./models";
import { type OpsStore, getOpsPolicy } from "./repo";
import { isNightMode } from "./time";

export interface OpsGate {
  readOnly: boolean;
  nightMode: boolean;
  reason: string | null;
  timezone: string | null;
  action: NightModeAction | null;
}

export async function getOpsGate(
  store: OpsStore,
  now: Date = new Date(),
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<OpsGate> {
  try {
    return evaluateGate(await getOpsPolicy(store, workspaceId), now);
  } catch {
    return {
      readOnly: false,
      nightMode: false,
      reason: null,
      timezone: null,
      action: null,
    };
  }
}

export function evaluateGate(policy: OnCallPolicy, now: Date): OpsGate {
  if (!isNightMode(now, policy)) {
    return {
      readOnly: false,
      nightMode: false,
      reason: null,
      timezone: policy.nightMode.timezone,
      action: policy.nightMode.action,
    };
  }
  return {
    readOnly: true,
    nightMode: true,
    reason: `night mode ${policy.nightMode.start}-${policy.nightMode.end} ${policy.nightMode.timezone}`,
    timezone: policy.nightMode.timezone,
    action: policy.nightMode.action,
  };
}
