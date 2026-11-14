import { getActiveAutonomyPreset } from "./autonomy";
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
  nightException: boolean;
  reason: string | null;
  timezone: string | null;
  action: NightModeAction | null;
}

export async function getOpsGate(
  store: OpsStore,
  now: Date = new Date(),
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<OpsGate> {
  let policy: OnCallPolicy;
  try {
    policy = await getOpsPolicy(store, workspaceId);
  } catch {
    return {
      readOnly: false,
      nightMode: false,
      nightException: false,
      reason: null,
      timezone: null,
      action: null,
    };
  }
  const preset = await getActiveAutonomyPreset(store, workspaceId);
  return evaluateGate(policy, now, {
    nightException: preset?.config.allowNight ?? false,
  });
}

export function evaluateGate(
  policy: OnCallPolicy,
  now: Date,
  options: { nightException?: boolean } = {},
): OpsGate {
  const nightException = options.nightException === true;
  if (!isNightMode(now, policy)) {
    return {
      readOnly: false,
      nightMode: false,
      nightException,
      reason: null,
      timezone: policy.nightMode.timezone,
      action: policy.nightMode.action,
    };
  }
  const reason = `night mode ${policy.nightMode.start}-${policy.nightMode.end} ${policy.nightMode.timezone}`;
  if (nightException) {
    return {
      readOnly: false,
      nightMode: true,
      nightException: true,
      reason: `${reason} (autonomy preset exception)`,
      timezone: policy.nightMode.timezone,
      action: policy.nightMode.action,
    };
  }
  return {
    readOnly: true,
    nightMode: true,
    nightException: false,
    reason,
    timezone: policy.nightMode.timezone,
    action: policy.nightMode.action,
  };
}
