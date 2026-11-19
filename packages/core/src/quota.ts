import { z } from "zod";

/**
 * Capacity contracts for issue #21 / 60 §2, §3.4, §3.5.
 *
 * Two contracts live here:
 * - PriorityClass P0–P3, mapped to queue weight and preemption. `tenant_id` in
 *   the plan reads as `workspace_id` (D-28–D-34).
 * - Quota per workspace × provider/model with rpm/tpm/concurrency and a
 *   configurable overflow policy (`queue` or `reject`).
 *
 * The contracts are pure data; enforcement lives in `@kit/model`
 * (ResilientModelGateway / QuotaTracker) and `@kit/engine` (fair queue).
 */

export const priorityClassSchema = z.enum(["P0", "P1", "P2", "P3"]);

export type PriorityClass = z.infer<typeof priorityClassSchema>;

export interface PriorityProfile {
  /** Relative queue weight; higher classes are served first within a workspace. */
  weight: number;
  /** P0/P1 may not be preempted by lower classes. */
  preemptible: boolean;
  /** P3 may be dropped at the admission gate under pressure. */
  queueable: boolean;
}

export const PRIORITY_PROFILES: Readonly<
  Record<PriorityClass, PriorityProfile>
> = Object.freeze({
  P0: { weight: 8, preemptible: false, queueable: false },
  P1: { weight: 4, preemptible: false, queueable: true },
  P2: { weight: 2, preemptible: true, queueable: true },
  P3: { weight: 1, preemptible: true, queueable: true },
});

/** 0 (P0) is highest priority; used for stable sorting. */
export function priorityRank(priority: PriorityClass): number {
  switch (priority) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
  }
}

export function priorityWeight(priority: PriorityClass): number {
  return PRIORITY_PROFILES[priority].weight;
}

export interface PriorityClassInput {
  priority?: unknown;
  /** Alert tier (P0–P3) when linking rule 10 event priority. */
  tier?: unknown;
  /** Run mode; non-LIVE (DRY_RUN etc.) is treated as background work. */
  runMode?: unknown;
}

/**
 * Rule 10 event priority → PriorityClass (60 §2 "与 10 的事件优先级联动").
 *
 * Explicit P0–P3 (from an event payload or an alert tier) wins; DRY_RUN /
 * SHADOW / REPLAY / FORK / BACKFILL are background (P3); everything else is
 * normal business traffic (P2).
 */
export function priorityClassFor(input: PriorityClassInput): PriorityClass {
  const declared = normalizePriority(input.priority ?? input.tier);
  if (declared) {
    return declared;
  }
  const runMode = typeof input.runMode === "string" ? input.runMode : "";
  if (runMode && runMode !== "LIVE") {
    return "P3";
  }
  return "P2";
}

export function normalizePriority(value: unknown): PriorityClass | null {
  if (typeof value !== "string") {
    return null;
  }
  const upper = value.trim().toUpperCase();
  return (priorityClassSchema.options as readonly string[]).includes(upper)
    ? (upper as PriorityClass)
    : null;
}

export const quotaOverflowSchema = z.enum(["queue", "reject"]);

export type QuotaOverflow = z.infer<typeof quotaOverflowSchema>;

const limit = z.number().int().positive().optional();

export const quotaSchema = z
  .object({
    /** `*` matches every workspace. */
    workspaceId: z.string().min(1).default("*"),
    /** `*` matches every provider. */
    provider: z.string().min(1).default("*"),
    /** `*` matches every model alias. */
    model: z.string().min(1).default("*"),
    rpm: limit,
    tpm: limit,
    concurrency: limit,
    overflow: quotaOverflowSchema.default("queue"),
    queueTimeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .superRefine((value, ctx) => {
    if (
      value.rpm === undefined &&
      value.tpm === undefined &&
      value.concurrency === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quota requires at least one of rpm, tpm or concurrency",
        path: ["rpm"],
      });
    }
  });

export type Quota = z.infer<typeof quotaSchema>;

export interface QuotaRequest {
  workspaceId: string;
  provider: string;
  model: string;
}

function matchesPattern(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === value;
}

export function quotaMatches(quota: Quota, request: QuotaRequest): boolean {
  return (
    matchesPattern(quota.workspaceId, request.workspaceId) &&
    matchesPattern(quota.provider, request.provider) &&
    matchesPattern(quota.model, request.model)
  );
}

/**
 * Most specific quota wins: exact workspace > exact provider > exact model.
 * Ties keep the earlier declaration so operator config order stays meaningful.
 */
export function resolveQuota(
  quotas: readonly Quota[],
  request: QuotaRequest,
): Quota | null {
  let best: Quota | null = null;
  let bestScore = -1;
  for (const quota of quotas) {
    if (!quotaMatches(quota, request)) {
      continue;
    }
    const score =
      (quota.workspaceId === request.workspaceId ? 4 : 0) +
      (quota.provider === request.provider ? 2 : 0) +
      (quota.model === request.model ? 1 : 0);
    if (score > bestScore) {
      best = quota;
      bestScore = score;
    }
  }
  return best;
}

export const DEFAULT_QUOTA_RPM = 60;
export const DEFAULT_QUOTA_TPM = 200_000;
export const DEFAULT_QUOTA_CONCURRENCY = 4;
export const DEFAULT_QUOTA_QUEUE_TIMEOUT_MS = 30_000;

function positiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

/**
 * Default operator quota from environment. `KIT_QUOTA_ENABLED=0` disables it;
 * otherwise rpm/tpm/concurrency default to the conservative local-first values
 * above so a single workspace cannot exhaust the provider.
 */
export function loadQuotaPolicies(
  env: Record<string, string | undefined> = process.env,
): Quota[] {
  if (env.KIT_QUOTA_ENABLED === "0" || env.KIT_QUOTA_ENABLED === "false") {
    return [];
  }
  const overflow = quotaOverflowSchema.safeParse(env.KIT_QUOTA_OVERFLOW);
  const queueTimeoutMs =
    positiveIntEnv(env.KIT_QUOTA_QUEUE_TIMEOUT_MS) ??
    DEFAULT_QUOTA_QUEUE_TIMEOUT_MS;
  return [
    quotaSchema.parse({
      workspaceId: env.KIT_QUOTA_WORKSPACE_ID ?? "*",
      provider: env.KIT_QUOTA_PROVIDER ?? "*",
      model: env.KIT_QUOTA_MODEL ?? "*",
      rpm: positiveIntEnv(env.KIT_QUOTA_RPM) ?? DEFAULT_QUOTA_RPM,
      tpm: positiveIntEnv(env.KIT_QUOTA_TPM) ?? DEFAULT_QUOTA_TPM,
      concurrency:
        positiveIntEnv(env.KIT_QUOTA_CONCURRENCY) ?? DEFAULT_QUOTA_CONCURRENCY,
      overflow: overflow.success ? overflow.data : "queue",
      queueTimeoutMs,
    }),
  ];
}

export interface QuotaUsage {
  rpm: number;
  tpm: number;
  concurrency: number;
  quota: Quota | null;
}

/** Utilization as a 0–1 fraction per dimension, or null when unlimited. */
export function quotaUtilization(usage: QuotaUsage): {
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
} {
  const ratio = (used: number, cap: number | undefined): number | null =>
    cap === undefined || cap <= 0
      ? null
      : Math.round((used / cap) * 1000) / 1000;
  return {
    rpm: ratio(usage.rpm, usage.quota?.rpm),
    tpm: ratio(usage.tpm, usage.quota?.tpm),
    concurrency: ratio(usage.concurrency, usage.quota?.concurrency),
  };
}
