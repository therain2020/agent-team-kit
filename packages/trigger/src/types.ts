import type { PriorityClass } from "@kit/core";
import type {
  JobKind,
  JobOriginKind,
  JobRunMode,
  StartJobResult,
} from "@kit/job";
import { z } from "zod";

/** Structural twin of `PackRunVariant`, kept local to avoid a workflow dep. */
export interface TriggerRunVariant {
  role: "canary";
  variantId: string;
  trafficPercent: number;
}

/**
 * Trigger plane contract (96 §3.1, 20 §2.5). Adapters only produce firings;
 * the dispatch pipeline owns every gate and the single `startJob` write.
 */
export const triggerKindSchema = z.enum([
  "schedule",
  "event",
  "manual",
  "information",
]);

export type TriggerKind = z.infer<typeof triggerKindSchema>;

export const triggerScheduleSchema = z.object({
  cron: z.string().min(1),
  timezone: z.string().min(1).default("UTC"),
});

export const triggerBudgetSchema = z.object({
  dailyRuns: z.number().int().positive().optional(),
  dailyCostCny: z.number().nonnegative().optional(),
});

export type TriggerBudget = z.infer<typeof triggerBudgetSchema>;

export const triggerSchema = z.object({
  triggerId: z.string().min(1),
  kind: triggerKindSchema,
  /** Where the declaration came from (`autopilot.yaml`, `runtime`, `manual`). */
  source: z.string().min(1).default("config"),
  enabled: z.boolean().default(true),
  schedule: triggerScheduleSchema.optional(),
  filter: z.object({ eventType: z.string().min(1) }).optional(),
  routeRef: z.string().min(1),
  reactionRuleRef: z.string().min(1).optional(),
  /** Actor recorded on the job origin; policy actors are not operators. */
  actor: z.string().min(1).default("trigger:dispatch"),
});

export type Trigger = z.infer<typeof triggerSchema>;

export const eventRouteJobKindSchema = z.enum([
  "packRun",
  "iteration",
  "evolution",
]);

export type EventRouteJobKind = z.infer<typeof eventRouteJobKindSchema>;

/**
 * One trigger → one job shape. Replaces the three competing semantics that
 * used to live loose inside `autopilot.yaml`.
 */
export const eventRouteSchema = z
  .object({
    routeId: z.string().min(1),
    triggerRef: z.string().min(1),
    /** Pack directory name relative to `packs/`, or an absolute variant path. */
    packDir: z.string().min(1),
    jobKind: eventRouteJobKindSchema.default("packRun"),
    workflow: z.string().min(1).optional(),
    goal: z.string().min(1).optional(),
    acceptance: z.string().min(1).optional(),
    maxTasks: z.number().int().min(1).max(20).optional(),
    maxRepair: z.number().int().min(0).max(5).optional(),
    coder: z.enum(["dsh", "codex", "opencode", "command"]).optional(),
    runMode: z.enum(["DRY_RUN", "LIVE"]).default("DRY_RUN"),
    applyMode: z.enum(["none", "low", "low-medium"]).optional(),
    inputFile: z.string().min(1).optional(),
    budget: triggerBudgetSchema.optional(),
    riskCeiling: z.enum(["low", "medium", "high"]).optional(),
    /** Canary variants live outside `packs/`; only trusted adapters set this. */
    allowPackOutsideRoot: z.boolean().default(false),
    /** Evolution route metadata; executable from #95 (T4) onwards. */
    evolution: z
      .object({
        cadence: z.enum(["daily", "weekly"]).default("weekly"),
        agent: z.string().min(1).optional(),
        evidenceFile: z.string().min(1).optional(),
        autoApply: z.boolean().default(false),
        budgetCny: z.number().nonnegative().optional(),
      })
      .optional(),
  })
  .superRefine((route, ctx) => {
    if (route.jobKind === "packRun" && !route.workflow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workflow is required for a packRun route",
        path: ["workflow"],
      });
    }
    if (route.jobKind === "iteration" && !route.goal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "goal is required for an iteration route",
        path: ["goal"],
      });
    }
  });

export type EventRoute = z.infer<typeof eventRouteSchema>;

export interface TriggerRoute {
  trigger: Trigger;
  route: EventRoute;
}

/** Resolves configured triggers (`autopilot.yaml` mapping, runtime registry). */
export interface TriggerRegistry {
  resolve(triggerId: string): Promise<TriggerRoute | null>;
  list(): Promise<TriggerRoute[]>;
}

export const triggerRunStatuses = ["started", "existing", "failed"] as const;

export type TriggerRunStatus = (typeof triggerRunStatuses)[number];

/** Persisted firing record: one row per firing, one job id at most. */
export const triggerRunSchema = z.object({
  triggerRunId: z.string().min(1),
  workspaceId: z.string().min(1),
  triggerId: z.string().min(1),
  kind: triggerKindSchema,
  routeId: z.string().min(1),
  jobKind: eventRouteJobKindSchema,
  dedupeKey: z.string().min(1),
  jobId: z.string().min(1).nullable(),
  status: z.enum(["started", "existing", "failed"]),
  launchedAt: z.string().datetime(),
  estimateCny: z.number().nonnegative().default(0),
  payloadRef: z.string().min(1).nullable().default(null),
  lastError: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type TriggerRun = z.infer<typeof triggerRunSchema>;

/**
 * Fixed D-66 gate order, extended by 96 §4. Every trigger kind walks this
 * exact sequence; adding a guard means inserting it here and updating tests.
 */
export const DISPATCH_GATES = [
  "kill-switch",
  "degraded",
  "dedupe",
  "trigger-budget",
  "budget-ledger",
  "start-job",
  "write-back",
] as const;

export type DispatchGate = (typeof DISPATCH_GATES)[number];
export type BlockingGate = Extract<
  DispatchGate,
  "kill-switch" | "degraded" | "dedupe" | "trigger-budget" | "budget-ledger"
>;

export const USE_EXISTING = "USE_EXISTING" as const;

export type TriggerDispatchOutcome =
  | "STARTED"
  | typeof USE_EXISTING
  | "SKIPPED"
  | "FAILED";

/**
 * The only dispatch entry input. Adapters may supply an ephemeral trigger and
 * route (event matching, ad-hoc manual firing); configured triggers resolve
 * them through the registry by `triggerId`.
 */
export interface FireTriggerInput {
  triggerId: string;
  dedupeKey: string;
  payloadRef?: string;
  trigger?: Trigger;
  route?: EventRoute;
  /** Stable TriggerRun id when a caller already owns a firing identity. */
  triggerRunId?: string;
  runId?: string;
  eventId?: string;
  evidenceText?: string;
  priority?: PriorityClass;
  variant?: TriggerRunVariant;
  /** Overrides the recorded origin kind (manual firing of a scheduled trigger). */
  originKind?: JobOriginKind;
  actor?: string;
}

export interface TriggerResult {
  dispatch: TriggerDispatchOutcome;
  status: "started" | "existing" | "skipped" | "failed";
  triggerId: string;
  triggerRunId: string | null;
  jobId: string | null;
  kind: JobKind | null;
  gate: DispatchGate | null;
  reason: string | null;
  estimateCny: number;
  /** Gate trail observed in this call, in order (contract tests assert it). */
  gates: DispatchGate[];
  job?: StartJobResult;
  runMode?: JobRunMode;
}

export interface TriggerUsage {
  runs: number;
  costCny: number;
}
