import { z } from "zod";

export const ALERT_TIERS = ["P0", "P1", "P2", "P3"] as const;
export type AlertTier = (typeof ALERT_TIERS)[number];

export const ALERT_CHANNELS = ["im", "email"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const NOTIFY_STATES = [
  "sent",
  "suppressed_duplicate",
  "suppressed_quiet",
  "suppressed_night",
  "suppressed_budget",
  "failed",
  "none",
] as const;
export type NotifyState = (typeof NOTIFY_STATES)[number];

export type NightModeAction = "read_only" | "pause_side_effects";

export interface QuietWindow {
  start: string;
  end: string;
  timezone: string;
}

export interface NightModePolicy {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  action: NightModeAction;
}

export type TierChannels = Record<AlertTier, AlertChannel[]>;
export type TierMinutes = Record<AlertTier, number>;

export interface OnCallPolicy {
  channels: TierChannels;
  quietWindow: QuietWindow | null;
  nightMode: NightModePolicy;
  aggregationMinutes: TierMinutes;
  ackSlaMinutes: TierMinutes;
  monthlyBudget: number | null;
}

export interface AlertInput {
  workspaceId?: string;
  tier: AlertTier;
  kind: string;
  title: string;
  body?: string;
  dedupeKey?: string;
  runId?: string;
  stageId?: string;
  requestId?: string;
  source?: string;
  runbookUrl?: string;
  meta?: Record<string, unknown>;
}

export interface AlertRecord {
  alertId: string;
  workspaceId: string;
  tier: AlertTier;
  kind: string;
  status: AlertStatus;
  dedupeKey: string;
  title: string;
  body: string;
  runId: string | null;
  stageId: string | null;
  requestId: string | null;
  source: string | null;
  runbookUrl: string | null;
  notifyState: NotifyState;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_WORKSPACE_ID = "default";

export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const timeOfDaySchema = z
  .string()
  .regex(TIME_OF_DAY_PATTERN, "expected HH:MM in 24-hour time");

const alertTierSchema = z.enum(ALERT_TIERS);
const alertChannelSchema = z.enum(ALERT_CHANNELS);

const quietWindowSchema = z.object({
  start: timeOfDaySchema,
  end: timeOfDaySchema,
  timezone: z.string().min(1),
});

const policyPatchSchema = z.object({
  channels: z
    .object({
      P0: z.array(alertChannelSchema).optional(),
      P1: z.array(alertChannelSchema).optional(),
      P2: z.array(alertChannelSchema).optional(),
      P3: z.array(alertChannelSchema).optional(),
    })
    .partial()
    .optional(),
  quietWindow: quietWindowSchema.nullable().optional(),
  nightMode: z
    .object({
      enabled: z.boolean().optional(),
      start: timeOfDaySchema.optional(),
      end: timeOfDaySchema.optional(),
      timezone: z.string().min(1).optional(),
      action: z.enum(["read_only", "pause_side_effects"]).optional(),
    })
    .partial()
    .optional(),
  aggregationMinutes: z
    .object({
      P0: z.number().int().min(0).optional(),
      P1: z.number().int().min(0).optional(),
      P2: z.number().int().min(0).optional(),
      P3: z.number().int().min(0).optional(),
    })
    .partial()
    .optional(),
  ackSlaMinutes: z
    .object({
      P0: z.number().int().min(1).optional(),
      P1: z.number().int().min(1).optional(),
      P2: z.number().int().min(1).optional(),
      P3: z.number().int().min(1).optional(),
    })
    .partial()
    .optional(),
  monthlyBudget: z.number().int().min(1).nullable().optional(),
});

export type OnCallPolicyPatch = z.infer<typeof policyPatchSchema>;

export function defaultTimezone(): string {
  const configured = process.env.KIT_OPS_TIMEZONE?.trim();
  if (configured) {
    return configured;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function defaultOnCallPolicy(
  timezone: string = defaultTimezone(),
): OnCallPolicy {
  return {
    channels: {
      P0: ["im", "email"],
      P1: ["im"],
      P2: ["email"],
      P3: [],
    },
    quietWindow: null,
    nightMode: {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone,
      action: "read_only",
    },
    aggregationMinutes: {
      P0: 0,
      P1: 10,
      P2: 60,
      P3: 1440,
    },
    ackSlaMinutes: {
      P0: 30,
      P1: 120,
      P2: 1440,
      P3: 10080,
    },
    monthlyBudget: null,
  };
}

export const DEFAULT_ON_CALL_POLICY: OnCallPolicy = defaultOnCallPolicy();

export function mergeOnCallPolicy(
  base: OnCallPolicy,
  patch: OnCallPolicyPatch,
): OnCallPolicy {
  return normalizeOnCallPolicy({
    channels: {
      P0: patch.channels?.P0 ?? base.channels.P0,
      P1: patch.channels?.P1 ?? base.channels.P1,
      P2: patch.channels?.P2 ?? base.channels.P2,
      P3: patch.channels?.P3 ?? base.channels.P3,
    },
    quietWindow:
      patch.quietWindow === undefined ? base.quietWindow : patch.quietWindow,
    nightMode: { ...base.nightMode, ...patch.nightMode },
    aggregationMinutes: {
      ...base.aggregationMinutes,
      ...patch.aggregationMinutes,
    },
    ackSlaMinutes: { ...base.ackSlaMinutes, ...patch.ackSlaMinutes },
    monthlyBudget:
      patch.monthlyBudget === undefined
        ? base.monthlyBudget
        : patch.monthlyBudget,
  });
}

export function parseOnCallPolicyPatch(input: unknown): OnCallPolicyPatch {
  return policyPatchSchema.parse(input ?? {});
}

export function parseOnCallPolicy(input: unknown): OnCallPolicy {
  return mergeOnCallPolicy(
    defaultOnCallPolicy(),
    parseOnCallPolicyPatch(input),
  );
}

export function safeParseOnCallPolicy(input: unknown): OnCallPolicy {
  try {
    return parseOnCallPolicy(input);
  } catch {
    return DEFAULT_ON_CALL_POLICY;
  }
}

export function normalizeOnCallPolicy(policy: OnCallPolicy): OnCallPolicy {
  return {
    channels: {
      P0: uniqueChannels(policy.channels.P0),
      P1: uniqueChannels(policy.channels.P1),
      P2: uniqueChannels(policy.channels.P2),
      P3: uniqueChannels(policy.channels.P3),
    },
    quietWindow: policy.quietWindow,
    nightMode: policy.nightMode,
    aggregationMinutes: policy.aggregationMinutes,
    ackSlaMinutes: policy.ackSlaMinutes,
    monthlyBudget: policy.monthlyBudget,
  };
}

export function parseAlertTier(value: unknown): AlertTier | null {
  const parsed = alertTierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function uniqueChannels(channels: AlertChannel[]): AlertChannel[] {
  return ALERT_CHANNELS.filter((channel) => channels.includes(channel));
}
