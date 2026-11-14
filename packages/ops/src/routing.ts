import {
  ALERT_CHANNELS,
  type AlertChannel,
  type AlertInput,
  type AlertRecord,
  type AlertTier,
  type OnCallPolicy,
} from "./models";
import { isNightMode, isQuietWindow } from "./time";

export type SuppressionReason =
  | "night_mode"
  | "quiet_window"
  | "monthly_budget";

export interface AlertRouting {
  channels: AlertChannel[];
  suppressed: boolean;
  reason: SuppressionReason | null;
}

export function dedupeKeyFor(
  input: Pick<
    AlertInput,
    "tier" | "kind" | "dedupeKey" | "runId" | "stageId" | "requestId"
  >,
): string {
  if (input.dedupeKey?.trim()) {
    return input.dedupeKey.trim();
  }
  return [
    input.tier,
    input.kind,
    input.runId ?? "",
    input.stageId ?? "",
    input.requestId ?? "",
  ].join("|");
}

export function aggregationWindowMs(
  tier: AlertTier,
  policy: OnCallPolicy,
): number {
  return policy.aggregationMinutes[tier] * 60_000;
}

export function resolveAlertRouting(input: {
  tier: AlertTier;
  policy: OnCallPolicy;
  now: Date;
  monthlyCount?: number;
}): AlertRouting {
  const channels = input.policy.channels[input.tier].filter((channel) =>
    ALERT_CHANNELS.includes(channel),
  );

  if (isNightMode(input.now, input.policy)) {
    if (input.tier === "P0") {
      return {
        channels: channels.includes("im") ? ["im"] : [],
        suppressed: false,
        reason: null,
      };
    }
    return { channels: [], suppressed: true, reason: "night_mode" };
  }

  if (isQuietWindow(input.now, input.policy) && input.tier !== "P0") {
    return { channels: [], suppressed: true, reason: "quiet_window" };
  }

  const budget = input.policy.monthlyBudget;
  if (
    budget !== null &&
    input.monthlyCount !== undefined &&
    input.monthlyCount >= budget &&
    (input.tier === "P2" || input.tier === "P3")
  ) {
    return { channels: [], suppressed: true, reason: "monthly_budget" };
  }

  return { channels, suppressed: false, reason: null };
}

export function isAckOverdue(
  alert: Pick<AlertRecord, "status" | "firstSeenAt" | "tier">,
  policy: OnCallPolicy,
  now: Date = new Date(),
): boolean {
  if (alert.status !== "open") {
    return false;
  }
  const slaMs = policy.ackSlaMinutes[alert.tier] * 60_000;
  const firstSeen = new Date(alert.firstSeenAt).getTime();
  if (!Number.isFinite(firstSeen)) {
    return false;
  }
  return now.getTime() - firstSeen > slaMs;
}
