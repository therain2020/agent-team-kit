import { z } from "zod";
import { DEFAULT_DEPENDENCIES } from "./degradation";
import { newId } from "./ids";

/**
 * Incident and Runbook contracts (61 §2, §3.4, §5). Every incident carries an
 * owner and a postmortem; runbooks cover each declared degradation mode and
 * are drilled. Recovery drills track RTO/RPO against D-38 and reuse the
 * existing `smoke:recovery` script + kitd rollback instead of re-implementing
 * recovery.
 */

// ---------------------------------------------------------------------------
// Cadence and budget constants (61 §3.4, §6 D-38)
// ---------------------------------------------------------------------------

/** Postmortem draft is due 24h after detection (61 §3.4). */
export const POSTMORTEM_DRAFT_HOURS = 24;

/** Postmortem final is due 48h after detection (61 §3.4). */
export const POSTMORTEM_FINAL_HOURS = 48;

/** RTO target: recover within 4 hours (D-38). */
export const RTO_TARGET_MINUTES = 4 * 60;

/** RPO target: lose at most 6 hours of data (D-38). */
export const RPO_TARGET_MINUTES = 6 * 60;

/** Recovery drills run quarterly (D-38); 90 days is the gating approximation. */
export const DRILL_INTERVAL_DAYS = 90;

export const DRILL_INTERVAL_MS = DRILL_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

/** The recovery drill must reuse this existing script (T4). */
export const RECOVERY_DRILL_SCRIPT = "smoke:recovery";

/** Runbook coverage is measured against the declared degradation modes. */
export const DEGRADATION_MODE_IDS: readonly string[] = Object.freeze(
  DEFAULT_DEPENDENCIES.map((dependency) => dependency.id),
);

// ---------------------------------------------------------------------------
// Incident
// ---------------------------------------------------------------------------

export const incidentSeveritySchema = z.enum(["sev1", "sev2", "sev3", "sev4"]);

export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  sev1: 1,
  sev2: 2,
  sev3: 3,
  sev4: 4,
};

/** Lower rank is more severe. */
export function severityRank(severity: IncidentSeverity): number {
  return SEVERITY_RANK[severity];
}

export const incidentStatusSchema = z.enum(["open", "mitigated", "resolved"]);

export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const incidentTimelineKindSchema = z.enum([
  "detected",
  "mitigation",
  "rollback",
  "resolved",
  "note",
]);

export type IncidentTimelineKind = z.infer<typeof incidentTimelineKindSchema>;

export const incidentTimelineEntrySchema = z.object({
  at: z.string().datetime(),
  kind: incidentTimelineKindSchema,
  actor: z.string().trim().min(1),
  note: z.string().default(""),
});

export type IncidentTimelineEntry = z.infer<typeof incidentTimelineEntrySchema>;

export const postmortemStatusSchema = z.enum(["none", "draft", "final"]);

export type PostmortemStatus = z.infer<typeof postmortemStatusSchema>;

/**
 * The postmortem stub is created with the incident so the 24h/48h deadlines
 * are never lost. Content is filled in as the write-up progresses.
 */
export const postmortemSchema = z.object({
  status: postmortemStatusSchema,
  draftDueAt: z.string().datetime(),
  finalDueAt: z.string().datetime(),
  content: z.string().default(""),
  author: z.string().trim().min(1).nullable().default(null),
  updatedAt: z.string().datetime().nullable().default(null),
});

export type Postmortem = z.infer<typeof postmortemSchema>;

export const incidentSchema = z.object({
  incidentId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().trim().min(1),
  severity: incidentSeveritySchema,
  detectedAt: z.string().datetime(),
  status: incidentStatusSchema,
  owner: z.string().trim().min(1),
  timeline: z.array(incidentTimelineEntrySchema),
  postmortem: postmortemSchema,
  /** Degradation mode / dependency id this incident is attributed to. */
  degradationModeId: z.string().trim().min(1).nullable().default(null),
  /** Populated when handed off to plan 40 (RegressionCase). */
  regressionCaseRef: z.string().trim().min(1).nullable().default(null),
  /** Populated when handed off to plan 70 (evolution signal). */
  evolutionSignalRef: z.string().trim().min(1).nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().nonnegative().default(0),
});

export type Incident = z.infer<typeof incidentSchema>;

export interface PostmortemDeadlines {
  draftDueAt: string;
  finalDueAt: string;
}

/** Adds the 24h draft / 48h final deadlines to a detection time. */
export function postmortemDeadlines(detectedAt: string): PostmortemDeadlines {
  const detectedMs = Date.parse(detectedAt);
  if (!Number.isFinite(detectedMs)) {
    throw new Error(`invalid detectedAt: ${detectedAt}`);
  }
  return {
    draftDueAt: new Date(
      detectedMs + POSTMORTEM_DRAFT_HOURS * 60 * 60 * 1000,
    ).toISOString(),
    finalDueAt: new Date(
      detectedMs + POSTMORTEM_FINAL_HOURS * 60 * 60 * 1000,
    ).toISOString(),
  };
}

export const newIncidentInputSchema = z.object({
  incidentId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  title: z.string().trim().min(1),
  severity: incidentSeveritySchema,
  owner: z.string().trim().min(1),
  detectedAt: z.string().datetime().optional(),
  /** Actor recorded on the seeded `detected` timeline entry. */
  reportedBy: z.string().trim().min(1).optional(),
  degradationModeId: z.string().trim().min(1).nullable().optional(),
  now: z.string().datetime().optional(),
});

export type NewIncidentInput = z.input<typeof newIncidentInputSchema>;

export class IncidentContractError extends Error {
  constructor(
    readonly code: "missing_owner" | "invalid_mode" | "not_open",
    message: string,
  ) {
    super(message);
    this.name = "IncidentContractError";
  }
}

/**
 * Builds an open incident with a seeded timeline and the postmortem deadlines
 * fixed at detection time. Owner is mandatory (61 §3.4 responsibility).
 */
export function newIncident(input: NewIncidentInput): Incident {
  const parsed = newIncidentInputSchema.parse(input);
  if (parsed.owner.trim().length === 0) {
    throw new IncidentContractError(
      "missing_owner",
      "incident requires an owner",
    );
  }
  const now = parsed.now ?? new Date().toISOString();
  const detectedAt = parsed.detectedAt ?? now;
  const deadlines = postmortemDeadlines(detectedAt);

  return incidentSchema.parse({
    incidentId: parsed.incidentId ?? newId("inc"),
    workspaceId: parsed.workspaceId,
    title: parsed.title,
    severity: parsed.severity,
    detectedAt,
    status: "open",
    owner: parsed.owner,
    timeline: [
      {
        at: detectedAt,
        kind: "detected",
        actor: parsed.reportedBy ?? parsed.owner,
        note: "incident detected",
      },
    ],
    postmortem: {
      status: "none",
      draftDueAt: deadlines.draftDueAt,
      finalDueAt: deadlines.finalDueAt,
      content: "",
      author: null,
      updatedAt: null,
    },
    degradationModeId: parsed.degradationModeId ?? null,
    regressionCaseRef: null,
    evolutionSignalRef: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
}

export const appendTimelineInputSchema = z.object({
  kind: incidentTimelineKindSchema,
  actor: z.string().trim().min(1),
  note: z.string().default(""),
  at: z.string().datetime().optional(),
});

export type AppendTimelineInput = z.input<typeof appendTimelineInputSchema>;

/** Appends a timeline entry; a `resolved` entry closes the incident. */
export function appendIncidentTimeline(
  incident: Incident,
  input: AppendTimelineInput,
): Incident {
  const parsed = appendTimelineInputSchema.parse(input);
  const at = parsed.at ?? new Date().toISOString();
  const nextStatus: IncidentStatus =
    parsed.kind === "resolved" ? "resolved" : incident.status;
  return {
    ...incident,
    status: nextStatus,
    timeline: [
      ...incident.timeline,
      { at, kind: parsed.kind, actor: parsed.actor, note: parsed.note },
    ],
    updatedAt: at,
  };
}

export const updatePostmortemInputSchema = z.object({
  status: postmortemStatusSchema.optional(),
  content: z.string().optional(),
  author: z.string().trim().min(1).nullable().optional(),
  now: z.string().datetime().optional(),
});

export type UpdatePostmortemInput = z.input<typeof updatePostmortemInputSchema>;

/**
 * Advances the postmortem. A draft defaults the first write to `draft`, and
 * the caller explicitly marks `final`.
 */
export function updateIncidentPostmortem(
  incident: Incident,
  input: UpdatePostmortemInput,
): Incident {
  const parsed = updatePostmortemInputSchema.parse(input);
  const now = parsed.now ?? new Date().toISOString();
  const status =
    parsed.status ??
    (incident.postmortem.status === "final" ? "final" : "draft");
  return {
    ...incident,
    postmortem: {
      ...incident.postmortem,
      status,
      content: parsed.content ?? incident.postmortem.content,
      author: parsed.author ?? incident.postmortem.author,
      updatedAt: now,
    },
    updatedAt: now,
  };
}

export interface PostmortemState {
  status: PostmortemStatus;
  draftDueAt: string;
  finalDueAt: string;
  draftOverdue: boolean;
  finalOverdue: boolean;
  /** `final` once written, so overdue is only meaningful before that. */
  overdue: boolean;
}

/** Evaluates the 24h/48h cadence against `now` (defaults to current time). */
export function postmortemState(
  incident: Pick<Incident, "detectedAt" | "postmortem">,
  now: string = new Date().toISOString(),
): PostmortemState {
  const nowMs = Date.parse(now);
  const deadlines = postmortemDeadlines(incident.detectedAt);
  if (!Number.isFinite(nowMs)) {
    return {
      status: incident.postmortem.status,
      draftDueAt: deadlines.draftDueAt,
      finalDueAt: deadlines.finalDueAt,
      draftOverdue: false,
      finalOverdue: false,
      overdue: false,
    };
  }
  const draftOverdue =
    incident.postmortem.status === "none" &&
    nowMs > Date.parse(deadlines.draftDueAt);
  const finalOverdue =
    incident.postmortem.status !== "final" &&
    nowMs > Date.parse(deadlines.finalDueAt);
  return {
    status: incident.postmortem.status,
    draftDueAt: deadlines.draftDueAt,
    finalDueAt: deadlines.finalDueAt,
    draftOverdue,
    finalOverdue,
    overdue: draftOverdue || finalOverdue,
  };
}

// ---------------------------------------------------------------------------
// Runbook
// ---------------------------------------------------------------------------

export const runbookStepSchema = z.object({
  order: z.number().int().nonnegative(),
  action: z.string().trim().min(1),
  expected: z.string().default(""),
});

export type RunbookStep = z.infer<typeof runbookStepSchema>;

export const runbookVerificationSchema = z.object({
  check: z.string().trim().min(1),
  expected: z.string().default(""),
});

export type RunbookVerification = z.infer<typeof runbookVerificationSchema>;

export const runbookStatusSchema = z.enum(["active", "draft", "retired"]);

export type RunbookStatus = z.infer<typeof runbookStatusSchema>;

export const runbookSchema = z.object({
  runbookId: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Degradation mode / dependency id this runbook covers (61 §3.2). */
  modeId: z.string().trim().min(1),
  trigger: z.string().trim().min(1),
  steps: z.array(runbookStepSchema).min(1),
  owner: z.string().trim().min(1),
  verification: z.array(runbookVerificationSchema),
  status: runbookStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().nonnegative().default(0),
});

export type Runbook = z.infer<typeof runbookSchema>;

export const newRunbookInputSchema = z.object({
  runbookId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  modeId: z.string().trim().min(1),
  trigger: z.string().trim().min(1),
  steps: z.array(runbookStepSchema).min(1),
  owner: z.string().trim().min(1),
  verification: z.array(runbookVerificationSchema).default([]),
  status: runbookStatusSchema.default("active"),
  now: z.string().datetime().optional(),
});

export type NewRunbookInput = z.input<typeof newRunbookInputSchema>;

/**
 * Builds a runbook for a declared degradation mode. Unknown modes are
 * rejected so coverage cannot silently drift from the #61.1 mode list.
 */
export function newRunbook(input: NewRunbookInput): Runbook {
  const parsed = newRunbookInputSchema.parse(input);
  if (!DEGRADATION_MODE_IDS.includes(parsed.modeId)) {
    throw new IncidentContractError(
      "invalid_mode",
      `unknown degradation mode: ${parsed.modeId} (expected one of ${DEGRADATION_MODE_IDS.join(", ")})`,
    );
  }
  const now = parsed.now ?? new Date().toISOString();
  return runbookSchema.parse({
    runbookId: parsed.runbookId ?? newId("rbk"),
    workspaceId: parsed.workspaceId,
    modeId: parsed.modeId,
    trigger: parsed.trigger,
    steps: [...parsed.steps].sort((left, right) => left.order - right.order),
    owner: parsed.owner,
    verification: parsed.verification,
    status: parsed.status,
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
}

// ---------------------------------------------------------------------------
// Drills
// ---------------------------------------------------------------------------

export const drillOutcomeSchema = z.enum(["pass", "fail"]);

export type DrillOutcome = z.infer<typeof drillOutcomeSchema>;

export const runbookDrillSchema = z.object({
  drillId: z.string().min(1),
  workspaceId: z.string().min(1),
  runbookId: z.string().min(1),
  modeId: z.string().trim().min(1),
  executedAt: z.string().datetime(),
  executedBy: z.string().trim().min(1),
  outcome: drillOutcomeSchema,
  notes: z.string().default(""),
  createdAt: z.string().datetime(),
});

export type RunbookDrill = z.infer<typeof runbookDrillSchema>;

export const newRunbookDrillInputSchema = z.object({
  drillId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  runbookId: z.string().min(1),
  modeId: z.string().trim().min(1),
  executedBy: z.string().trim().min(1),
  outcome: drillOutcomeSchema,
  notes: z.string().default(""),
  now: z.string().datetime().optional(),
});

export type NewRunbookDrillInput = z.input<typeof newRunbookDrillInputSchema>;

export function newRunbookDrill(input: NewRunbookDrillInput): RunbookDrill {
  const parsed = newRunbookDrillInputSchema.parse(input);
  const now = parsed.now ?? new Date().toISOString();
  return runbookDrillSchema.parse({
    drillId: parsed.drillId ?? newId("drd"),
    workspaceId: parsed.workspaceId,
    runbookId: parsed.runbookId,
    modeId: parsed.modeId,
    executedAt: now,
    executedBy: parsed.executedBy,
    outcome: parsed.outcome,
    notes: parsed.notes,
    createdAt: now,
  });
}

export const recoveryDrillSchema = z.object({
  drillId: z.string().min(1),
  executedAt: z.string().datetime(),
  executedBy: z.string().trim().min(1),
  /** The reused recovery script, e.g. `smoke:recovery`. */
  script: z.string().trim().min(1),
  rtoTargetMinutes: z.number().int().positive(),
  rpoTargetMinutes: z.number().int().positive(),
  /** Measured recovery time for this drill, null when not measured. */
  measuredRtoMinutes: z.number().int().nonnegative().nullable(),
  /** Measured data-loss window for this drill, null when not measured. */
  measuredRpoMinutes: z.number().int().nonnegative().nullable(),
  /** Reference to the kitd rollback (audit id / commit) exercised, if any. */
  kitdRollbackRef: z.string().trim().min(1).nullable(),
  integrityPass: z.boolean(),
  outcome: drillOutcomeSchema,
  notes: z.string().default(""),
  createdAt: z.string().datetime(),
});

export type RecoveryDrill = z.infer<typeof recoveryDrillSchema>;

export const newRecoveryDrillInputSchema = z.object({
  drillId: z.string().min(1).optional(),
  executedBy: z.string().trim().min(1),
  script: z.string().trim().min(1).default(RECOVERY_DRILL_SCRIPT),
  rtoTargetMinutes: z.number().int().positive().default(RTO_TARGET_MINUTES),
  rpoTargetMinutes: z.number().int().positive().default(RPO_TARGET_MINUTES),
  measuredRtoMinutes: z.number().int().nonnegative().nullable().default(null),
  measuredRpoMinutes: z.number().int().nonnegative().nullable().default(null),
  kitdRollbackRef: z.string().trim().min(1).nullable().default(null),
  integrityPass: z.boolean().default(false),
  notes: z.string().default(""),
  now: z.string().datetime().optional(),
});

export type NewRecoveryDrillInput = z.input<
  typeof newRecoveryDrillInputSchema
>;

export interface RecoveryDrillEvaluation {
  pass: boolean;
  reasons: string[];
}

/**
 * A recovery drill passes only when RTO and RPO stay inside the D-38 budget and
 * the post-recovery artifact integrity check succeeded.
 */
export function evaluateRecoveryDrill(input: {
  measuredRtoMinutes: number | null;
  measuredRpoMinutes: number | null;
  integrityPass: boolean;
  rtoTargetMinutes?: number;
  rpoTargetMinutes?: number;
}): RecoveryDrillEvaluation {
  const reasons: string[] = [];
  const rtoTarget = input.rtoTargetMinutes ?? RTO_TARGET_MINUTES;
  const rpoTarget = input.rpoTargetMinutes ?? RPO_TARGET_MINUTES;
  if (input.measuredRtoMinutes === null) {
    reasons.push("recovery time (RTO) was not measured");
  } else if (input.measuredRtoMinutes > rtoTarget) {
    reasons.push(
      `RTO ${input.measuredRtoMinutes}m exceeds target ${rtoTarget}m`,
    );
  }
  if (input.measuredRpoMinutes === null) {
    reasons.push("data-loss window (RPO) was not measured");
  } else if (input.measuredRpoMinutes > rpoTarget) {
    reasons.push(
      `RPO ${input.measuredRpoMinutes}m exceeds target ${rpoTarget}m`,
    );
  }
  if (!input.integrityPass) {
    reasons.push("post-recovery artifact integrity check failed");
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * Builds and records the outcome of a recovery drill. If `outcome` is not
 * supplied it is derived from the D-38 evaluation.
 */
export function newRecoveryDrill(
  input: NewRecoveryDrillInput & { outcome?: DrillOutcome },
): RecoveryDrill {
  const parsed = newRecoveryDrillInputSchema.parse(input);
  const evaluation = evaluateRecoveryDrill(parsed);
  const now = parsed.now ?? new Date().toISOString();
  return recoveryDrillSchema.parse({
    drillId: parsed.drillId ?? newId("rdr"),
    executedAt: now,
    executedBy: parsed.executedBy,
    script: parsed.script,
    rtoTargetMinutes: parsed.rtoTargetMinutes,
    rpoTargetMinutes: parsed.rpoTargetMinutes,
    measuredRtoMinutes: parsed.measuredRtoMinutes,
    measuredRpoMinutes: parsed.measuredRpoMinutes,
    kitdRollbackRef: parsed.kitdRollbackRef,
    integrityPass: parsed.integrityPass,
    outcome: input.outcome ?? (evaluation.pass ? "pass" : "fail"),
    notes: parsed.notes,
    createdAt: now,
  });
}

/** True when no drill has run, or the last one is older than the cadence. */
export function isRecoveryDrillDue(
  lastExecutedAt: string | null | undefined,
  now: string = new Date().toISOString(),
): boolean {
  if (!lastExecutedAt) {
    return true;
  }
  const lastMs = Date.parse(lastExecutedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return true;
  }
  return nowMs - lastMs > DRILL_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface RunbookCoverage {
  requiredModes: string[];
  /** Modes with an active runbook AND at least one drill record. */
  coveredModes: string[];
  /** Modes with an active runbook but no drill recorded yet. */
  undrilledModes: string[];
  missingModes: string[];
  drilledModes: string[];
}

/**
 * Coverage requires both a runbook and a drill record per degradation mode
 * (61 §5: "每种降级模式有 runbook 且演练记录 100% 留存").
 */
export function runbookCoverage(
  runbooks: readonly Runbook[],
  drills: readonly RunbookDrill[],
): RunbookCoverage {
  const active = runbooks.filter((runbook) => runbook.status === "active");
  const activeModes = new Set(active.map((runbook) => runbook.modeId));
  const drilledRunbookIds = new Set(drills.map((drill) => drill.runbookId));
  const drilledModes = new Set(
    active
      .filter((runbook) => drilledRunbookIds.has(runbook.runbookId))
      .map((runbook) => runbook.modeId),
  );
  const drilledModeSet = new Set(drills.map((drill) => drill.modeId));

  const coveredModes = DEGRADATION_MODE_IDS.filter((mode) =>
    drilledModes.has(mode),
  );
  const undrilledModes = DEGRADATION_MODE_IDS.filter(
    (mode) => activeModes.has(mode) && !drilledModes.has(mode),
  );
  const missingModes = DEGRADATION_MODE_IDS.filter(
    (mode) => !activeModes.has(mode),
  );

  return {
    requiredModes: [...DEGRADATION_MODE_IDS],
    coveredModes,
    undrilledModes,
    missingModes,
    drilledModes: [...drilledModeSet],
  };
}

// ---------------------------------------------------------------------------
// Handoff integration points (plan 40 RegressionCase, plan 70 evolution signal)
// ---------------------------------------------------------------------------

export interface IncidentRegressionCaseHandoff {
  caseId: string;
  incidentId: string;
  workspaceId: string;
  title: string;
  severity: IncidentSeverity;
  detectedAt: string;
  reproduction: string;
  expectedBehavior: string;
  source: "incident";
  sourceRef: { kind: "incident"; id: string };
}

/**
 * Durable draft of the RegressionCase (plan 40) an incident must become.
 * Plan 40 owns the RegressionCase store; until it lands this is the documented
 * handoff shape, materialised from the incident timeline.
 */
export function incidentToRegressionCase(
  incident: Incident,
): IncidentRegressionCaseHandoff {
  const reproduction = incident.timeline
    .filter((entry) => entry.kind === "detected" || entry.kind === "note")
    .map((entry) => `${entry.at} ${entry.kind}: ${entry.note}`)
    .join("\n");
  return {
    caseId: `reg_${incident.incidentId}`,
    incidentId: incident.incidentId,
    workspaceId: incident.workspaceId,
    title: incident.title,
    severity: incident.severity,
    detectedAt: incident.detectedAt,
    reproduction: reproduction || incident.title,
    expectedBehavior: incident.postmortem.content.trim() || "no regression",
    source: "incident",
    sourceRef: { kind: "incident", id: incident.incidentId },
  };
}

export interface IncidentEvolutionSignalHandoff {
  signalId: string;
  /** Plan 70 SignalSourceKind currently has no `incident` source; use `manual`
   * until plan 70 extends the enum, keeping the ref fields stable. */
  source: "manual";
  signal: string;
  incidentId: string;
  workspaceId: string;
  severity: IncidentSeverity;
  detectedAt: string;
}

/**
 * Durable draft of the evolution signal (plan 70) an incident emits. Plan 70
 * reads EvolutionSignalRef `{ signalId, source, signal, ... }`; this carries
 * the extra incident identifiers so plan 70 can attribute the signal.
 */
export function incidentToEvolutionSignal(
  incident: Incident,
): IncidentEvolutionSignalHandoff {
  return {
    signalId: `sig_inc_${incident.incidentId}`,
    source: "manual",
    signal: `${incident.severity} ${incident.title} (${incident.workspaceId})`,
    incidentId: incident.incidentId,
    workspaceId: incident.workspaceId,
    severity: incident.severity,
    detectedAt: incident.detectedAt,
  };
}
