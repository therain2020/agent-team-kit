import { z } from "zod";
import { newId } from "./ids";

export const dependencyKindSchema = z.enum([
  "provider",
  "event_bus",
  "artifact_store",
  "source_api",
  "delivery",
]);

export type DependencyKind = z.infer<typeof dependencyKindSchema>;

export const dependencyCriticalitySchema = z.enum(["critical", "degradable"]);

export type DependencyCriticality = z.infer<typeof dependencyCriticalitySchema>;

export const failureModeSchema = z.enum(["fail_open", "fail_closed"]);

export type FailureMode = z.infer<typeof failureModeSchema>;

export const dependencySchema = z.object({
  id: z.string().min(1),
  kind: dependencyKindSchema,
  criticality: dependencyCriticalitySchema,
  failureMode: failureModeSchema,
  description: z.string().min(1),
});

export type Dependency = z.infer<typeof dependencySchema>;

/**
 * Declared external dependencies (61 §3.1). A workspace failure must never
 * escalate to a global outage, so only security events may enter the global
 * scope. Delivery and artifact storage fail closed; ingestion and the event
 * bus fail open (queue / spool) as decided in 61 §6 D-38.
 */
export const DEFAULT_DEPENDENCIES: readonly Dependency[] = Object.freeze([
  {
    id: "model.provider",
    kind: "provider",
    criticality: "critical",
    failureMode: "fail_open",
    description:
      "Model provider outage: use an allowed fallback, otherwise pause the affected stage.",
  },
  {
    id: "event_bus",
    kind: "event_bus",
    criticality: "critical",
    failureMode: "fail_open",
    description: "Event bus outage: buffer locally and replay by event_id.",
  },
  {
    id: "artifact_store",
    kind: "artifact_store",
    criticality: "critical",
    failureMode: "fail_closed",
    description: "Artifact store outage: stop publishing and suspend the run.",
  },
  {
    id: "source_api",
    kind: "source_api",
    criticality: "degradable",
    failureMode: "fail_open",
    description:
      "Source outage: pause ingestion, keep the queue, note the gap.",
  },
  {
    id: "delivery",
    kind: "delivery",
    criticality: "critical",
    failureMode: "fail_closed",
    description: "Delivery must stop when the quality floor cannot be met.",
  },
]);

export function findDependency(
  dependencyId: string,
  dependencies: readonly Dependency[] = DEFAULT_DEPENDENCIES,
): Dependency | null {
  return dependencies.find((item) => item.id === dependencyId) ?? null;
}

/**
 * A stage may override the default per-dependency posture. When it does not,
 * stages fail open so that a degraded system can still serve through LKG.
 */
export function stageFailureMode(stage: {
  failureMode?: FailureMode;
}): FailureMode {
  return stage.failureMode ?? "fail_open";
}

export const qualityFloorSchema = z.object({
  minChars: z.number().int().nonnegative().default(0),
  forbiddenPatterns: z.array(z.string().min(1)).default(["TODO", "{{"]),
});

export type QualityFloor = z.infer<typeof qualityFloorSchema>;

export const DEFAULT_QUALITY_FLOOR: QualityFloor = {
  minChars: 0,
  forbiddenPatterns: ["TODO", "{{"],
};

export interface QualityFloorResult {
  pass: boolean;
  reasons: string[];
}

/**
 * Deterministic floor check: every externally visible output in a degraded
 * mode must clear it before delivery (61 §3.2, §5).
 */
export function evaluateQualityFloor(
  text: string,
  floor: QualityFloor = DEFAULT_QUALITY_FLOOR,
): QualityFloorResult {
  const trimmed = text.trim();
  const reasons: string[] = [];
  if (trimmed.length < floor.minChars) {
    reasons.push(
      `output shorter than ${floor.minChars} characters (got ${trimmed.length})`,
    );
  }
  const lowered = trimmed.toLowerCase();
  for (const pattern of floor.forbiddenPatterns) {
    if (lowered.includes(pattern.toLowerCase())) {
      reasons.push(`contains forbidden pattern "${pattern}"`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

export const degradationScopeSchema = z.enum(["workspace", "global"]);

export type DegradationScope = z.infer<typeof degradationScopeSchema>;

export const degradedModeKindSchema = z.enum(["degraded", "read_only"]);

export type DegradedModeKind = z.infer<typeof degradedModeKindSchema>;

export const degradationTriggerSchema = z.object({
  dependencyId: z.string().min(1),
  reason: z.string().min(1),
});

export type DegradationTrigger = z.infer<typeof degradationTriggerSchema>;

export const exitCriteriaSchema = z.object({
  minStableMinutes: z.number().int().nonnegative().default(0),
  requireQualityRecheck: z.boolean().default(true),
});

export type ExitCriteria = z.infer<typeof exitCriteriaSchema>;

export const degradedModeStatusSchema = z.enum(["active", "exited"]);

export type DegradedModeStatus = z.infer<typeof degradedModeStatusSchema>;

export const degradedModeSchema = z.object({
  modeId: z.string().min(1),
  scope: degradationScopeSchema,
  workspaceId: z.string().min(1),
  kind: degradedModeKindSchema,
  triggers: z.array(degradationTriggerSchema).min(1),
  behavior: z.string().min(1),
  qualityFloor: qualityFloorSchema,
  exitCriteria: exitCriteriaSchema,
  status: degradedModeStatusSchema,
  enteredAt: z.string().datetime(),
  enteredBy: z.string().min(1),
  exitedAt: z.string().datetime().optional(),
  exitReason: z.string().min(1).optional(),
});

export type DegradedMode = z.infer<typeof degradedModeSchema>;

export const degradationAuditActionSchema = z.enum([
  "enter",
  "exit",
  "blocked",
]);

export type DegradationAuditAction = z.infer<
  typeof degradationAuditActionSchema
>;

export const degradationAuditSchema = z.object({
  auditId: z.string().min(1),
  occurredAt: z.string().datetime(),
  actor: z.string().min(1),
  action: degradationAuditActionSchema,
  scope: degradationScopeSchema,
  workspaceId: z.string().min(1),
  modeId: z.string().min(1),
  detail: z.record(z.unknown()),
});

export type DegradationAudit = z.infer<typeof degradationAuditSchema>;

export class DegradationContractError extends Error {
  constructor(
    readonly code:
      | "unknown_dependency"
      | "global_requires_security_event"
      | "workspace_required",
    message: string,
  ) {
    super(message);
    this.name = "DegradationContractError";
  }
}

export const enterDegradedModeInputSchema = z.object({
  modeId: z.string().min(1).optional(),
  scope: degradationScopeSchema,
  workspaceId: z.string().min(1).optional(),
  kind: degradedModeKindSchema,
  triggers: z.array(degradationTriggerSchema).min(1),
  behavior: z.string().min(1),
  qualityFloor: qualityFloorSchema.optional(),
  exitCriteria: exitCriteriaSchema.optional(),
  securityEvent: z.boolean().default(false),
  actor: z.string().min(1),
  now: z.string().datetime().optional(),
});

export type EnterDegradedModeInput = z.input<
  typeof enterDegradedModeInputSchema
>;

/**
 * Explicit entry only: a degraded or read-only mode is never inferred
 * silently. Global scope is reserved for security events so that a single
 * workspace failure cannot trigger a global degradation (61 §2 contract).
 */
export function enterDegradedMode(
  input: EnterDegradedModeInput,
  dependencies: readonly Dependency[] = DEFAULT_DEPENDENCIES,
): DegradedMode {
  const parsed = enterDegradedModeInputSchema.parse(input);

  for (const trigger of parsed.triggers) {
    if (!findDependency(trigger.dependencyId, dependencies)) {
      throw new DegradationContractError(
        "unknown_dependency",
        `unknown dependency: ${trigger.dependencyId}`,
      );
    }
  }

  if (parsed.scope === "global" && !parsed.securityEvent) {
    throw new DegradationContractError(
      "global_requires_security_event",
      "global degradation requires a security event; isolate the workspace instead",
    );
  }

  if (parsed.scope === "workspace" && !parsed.workspaceId) {
    throw new DegradationContractError(
      "workspace_required",
      "workspace degradation requires a workspaceId",
    );
  }

  return degradedModeSchema.parse({
    modeId: parsed.modeId ?? newId("deg"),
    scope: parsed.scope,
    workspaceId:
      parsed.scope === "global" ? "*" : (parsed.workspaceId as string),
    kind: parsed.kind,
    triggers: parsed.triggers,
    behavior: parsed.behavior,
    qualityFloor: parsed.qualityFloor ?? DEFAULT_QUALITY_FLOOR,
    exitCriteria: parsed.exitCriteria ?? exitCriteriaSchema.parse({}),
    status: "active",
    enteredAt: parsed.now ?? new Date().toISOString(),
    enteredBy: parsed.actor,
  });
}

export interface ExitDegradedModeInput {
  actor: string;
  reason: string;
  now?: string;
  qualityRecheck?: { pass: boolean; summary?: string };
}

export interface ExitDegradedModeResult {
  ok: boolean;
  mode: DegradedMode;
  reasons: string[];
}

/**
 * Exiting requires both the stable window and an explicit quality recheck
 * (61 §2: quality is re-verified before leaving downgrade).
 */
export function exitDegradedMode(
  mode: DegradedMode,
  input: ExitDegradedModeInput,
): ExitDegradedModeResult {
  const reasons: string[] = [];
  if (mode.status !== "active") {
    reasons.push("mode is not active");
  }

  const now = input.now ?? new Date().toISOString();
  const elapsedMs = Date.parse(now) - Date.parse(mode.enteredAt);
  const requiredMs = mode.exitCriteria.minStableMinutes * 60_000;
  if (elapsedMs < requiredMs) {
    reasons.push(
      `stable window not met: ${Math.max(0, Math.floor(elapsedMs / 60_000))} of ${mode.exitCriteria.minStableMinutes} minutes`,
    );
  }

  if (
    mode.exitCriteria.requireQualityRecheck &&
    input.qualityRecheck?.pass !== true
  ) {
    reasons.push("quality recheck required before exiting");
  }

  if (reasons.length > 0) {
    return { ok: false, mode, reasons };
  }

  return {
    ok: true,
    mode: {
      ...mode,
      status: "exited",
      exitedAt: now,
      exitReason: input.reason,
    },
    reasons,
  };
}

export function activeModes(modes: readonly DegradedMode[]): DegradedMode[] {
  return modes.filter((mode) => mode.status === "active");
}

/**
 * Resolve the mode that governs a workspace. Global first, then the exact
 * workspace; another workspace's mode never leaks in.
 */
export function activeModeFor(
  modes: readonly DegradedMode[],
  workspaceId: string,
): DegradedMode | null {
  const active = activeModes(modes);
  return (
    active.find((mode) => mode.scope === "global") ??
    active.find(
      (mode) => mode.scope === "workspace" && mode.workspaceId === workspaceId,
    ) ??
    null
  );
}

export function isExecutionBlocked(
  mode: DegradedMode | null | undefined,
): boolean {
  return mode?.kind === "read_only";
}
