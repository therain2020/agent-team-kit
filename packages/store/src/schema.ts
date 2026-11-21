import type {
  DegradationTrigger,
  DrillOutcome,
  ExitCriteria,
  IncidentSeverity,
  IncidentStatus,
  IncidentTimelineEntry,
  LkgArtifactRef,
  Postmortem,
  Producer,
  QualityFloor,
  RunbookStatus,
  RunbookStep,
  RunbookVerification,
} from "@kit/core";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

type Cost = { currency: "CNY"; amount: number; tokens: number };
type InputRef = { artifactId: string; version: number };

export const events = pgTable("events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  workspaceId: text("workspace_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  occurredAt: timestamp("occurred_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  receivedAt: timestamp("received_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  traceId: text("trace_id").notNull(),
  payloadRef: text("payload_ref").notNull(),
});

export const runs = pgTable("runs", {
  runId: text("run_id").primaryKey(),
  eventId: text("event_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  workflowVersion: text("workflow_version").notNull(),
  runMode: text("run_mode").notNull(),
  status: text("status").notNull(),
  originKind: text("origin_kind"),
  triggerId: text("trigger_id"),
  triggerRunId: text("trigger_run_id"),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  version: integer("version").notNull().default(0),
});

export const stages = pgTable("stages", {
  stageId: text("stage_id").primaryKey(),
  runId: text("run_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  checkpointId: text("checkpoint_id"),
  error: text("error"),
  version: integer("version").notNull().default(0),
});

export const manifests = pgTable("manifests", {
  manifestId: text("manifest_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  producer: jsonb("producer").$type<Producer>().notNull(),
  inputRefs: jsonb("input_refs").$type<InputRef[]>().notNull(),
  runId: text("run_id").notNull(),
  stageId: text("stage_id").notNull(),
  runMode: text("run_mode").notNull(),
  cost: jsonb("cost").$type<Cost>().notNull(),
  evalRefs: jsonb("eval_refs").$type<string[]>().notNull(),
  approvalRefs: jsonb("approval_refs").$type<string[]>().notNull(),
  sensitivity: text("sensitivity").notNull(),
  retentionClass: text("retention_class").notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const blobs = pgTable("blobs", {
  blobId: text("blob_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  sha256: text("sha256").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const artifacts = pgTable("artifacts", {
  artifactId: text("artifact_id").notNull(),
  version: integer("version").notNull(),
  workspaceId: text("workspace_id").notNull(),
  blobId: text("blob_id").notNull(),
  manifestId: text("manifest_id").notNull(),
  status: text("status").notNull(),
  supersedes: text("supersedes"),
  supersededBy: text("superseded_by"),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

/** Lineage edge endpoints are always ArtifactVersions (30 §3.2). */
export const artifactEdges = pgTable(
  "artifact_edges",
  {
    edgeId: text("edge_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    fromKind: text("from_kind").notNull().default("artifact"),
    fromId: text("from_id").notNull(),
    fromVersion: integer("from_version").notNull(),
    toKind: text("to_kind").notNull().default("artifact"),
    toId: text("to_id").notNull(),
    toVersion: integer("to_version").notNull(),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("uq_artifact_edges_identity").on(
      table.fromKind,
      table.fromId,
      table.fromVersion,
      table.toKind,
      table.toId,
      table.toVersion,
      table.relation,
    ),
  ],
);

export const runRequests = pgTable("run_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  kind: text("kind").notNull().default("pack_run"),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  claimedBy: text("claimed_by"),
  claimedAt: timestamp("claimed_at", {
    withTimezone: true,
    mode: "string",
  }),
  heartbeatAt: timestamp("heartbeat_at", {
    withTimezone: true,
    mode: "string",
  }),
  /** Fencing token; incremented on every claim. */
  leaseVersion: integer("lease_version").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

/** Artifact-level last-known-good pins (61 §2). */
export const lastKnownGood = pgTable(
  "last_known_good",
  {
    lkgId: text("lkg_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    targetKey: text("target_key").notNull(),
    artifactRefs: jsonb("artifact_refs").$type<LkgArtifactRef[]>().notNull(),
    verifiedAt: timestamp("verified_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    verifier: text("verifier").notNull(),
    status: text("status").notNull(),
    supersedes: text("supersedes"),
    supersededBy: text("superseded_by"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    index("idx_lkg_active").on(
      table.workspaceId,
      table.targetKey,
      table.status,
    ),
    index("idx_lkg_verified").on(table.verifiedAt),
  ],
);

export const degradationState = pgTable(
  "degradation_state",
  {
    scope: text("scope").notNull(),
    workspaceId: text("workspace_id").notNull(),
    modeId: text("mode_id").notNull(),
    kind: text("kind").notNull(),
    triggers: jsonb("triggers").$type<DegradationTrigger[]>().notNull(),
    behavior: text("behavior").notNull(),
    qualityFloor: jsonb("quality_floor").$type<QualityFloor>().notNull(),
    exitCriteria: jsonb("exit_criteria").$type<ExitCriteria>().notNull(),
    status: text("status").notNull(),
    enteredAt: timestamp("entered_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    enteredBy: text("entered_by").notNull(),
    exitedAt: timestamp("exited_at", { withTimezone: true, mode: "string" }),
    exitReason: text("exit_reason"),
  },
  (table) => [primaryKey({ columns: [table.scope, table.workspaceId] })],
);

export const degradationAudit = pgTable("degradation_audit", {
  auditId: text("audit_id").primaryKey(),
  occurredAt: timestamp("occurred_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  scope: text("scope").notNull(),
  workspaceId: text("workspace_id").notNull(),
  modeId: text("mode_id").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
});

export const autopilotState = pgTable(
  "autopilot_state",
  {
    workspaceId: text("workspace_id").notNull(),
    packDir: text("pack_dir").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    lastTickAt: timestamp("last_tick_at", {
      withTimezone: true,
      mode: "string",
    }),
    nextRuns: jsonb("next_runs")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    day: date("day", { mode: "string" }),
    runsToday: integer("runs_today").notNull().default(0),
    spentToday: numeric("spent_today").notNull().default("0"),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.packDir] })],
);

export const managerSessions = pgTable(
  "manager_sessions",
  {
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    windowEndsAt: timestamp("window_ends_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    firstAt: timestamp("first_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    lastAt: timestamp("last_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    tokens: integer("tokens").notNull().default(0),
    costCny: numeric("cost_cny").notNull().default("0"),
    exchanges: integer("exchanges").notNull().default(0),
    rejections: integer("rejections").notNull().default(0),
    lastRejectionReason: text("last_rejection_reason"),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.sessionId] })],
);

export const killSwitches = pgTable(
  "kill_switches",
  {
    switchId: text("switch_id").primaryKey(),
    scope: text("scope").notNull(),
    target: text("target").notNull().default(""),
    workspaceId: text("workspace_id").notNull().default(""),
    state: text("state").notNull(),
    activatedBy: text("activated_by").notNull(),
    reason: text("reason").notNull(),
    activatedAt: timestamp("activated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    releasedBy: text("released_by"),
    releasedAt: timestamp("released_at", {
      withTimezone: true,
      mode: "string",
    }),
    releaseReason: text("release_reason"),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("uq_kill_switches_identity").on(
      table.scope,
      table.target,
      table.workspaceId,
    ),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    budgetId: text("budget_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scope: text("scope").notNull(),
    targetKey: text("target_key").notNull(),
    period: text("period"),
    dayKey: text("day_key"),
    monthKey: text("month_key"),
    limitCnyMicro: bigint("limit_cny_micro", { mode: "number" }),
    limitTokens: bigint("limit_tokens", { mode: "number" }),
    spentCnyMicro: bigint("spent_cny_micro", { mode: "number" })
      .notNull()
      .default(0),
    spentTokens: bigint("spent_tokens", { mode: "number" })
      .notNull()
      .default(0),
    reservedCnyMicro: bigint("reserved_cny_micro", { mode: "number" })
      .notNull()
      .default(0),
    reservedTokens: bigint("reserved_tokens", { mode: "number" })
      .notNull()
      .default(0),
    hard: boolean("hard").notNull().default(true),
    alert80Cny: boolean("alert80_cny").notNull().default(false),
    alert80Tokens: boolean("alert80_tokens").notNull().default(false),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("budgets_scope_target_idx").on(
      table.workspaceId,
      table.scope,
      table.targetKey,
    ),
  ],
);

export const budgetReservations = pgTable("budget_reservations", {
  reservationId: text("reservation_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  runId: text("run_id").notNull(),
  stageId: text("stage_id"),
  agentId: text("agent_id"),
  purpose: text("purpose").notNull(),
  budgetIds: jsonb("budget_ids").$type<string[]>().notNull(),
  amountCnyMicro: bigint("amount_cny_micro", { mode: "number" }).notNull(),
  amountTokens: bigint("amount_tokens", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const budgetCharges = pgTable(
  "budget_charges",
  {
    chargeId: text("charge_id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    stageId: text("stage_id"),
    agentId: text("agent_id"),
    purpose: text("purpose").notNull(),
    costCnyMicro: bigint("cost_cny_micro", { mode: "number" })
      .notNull()
      .default(0),
    tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("budget_charges_reservation_idx").on(table.reservationId),
  ],
);

/** Per-call cost attribution (60 §2/§3.3). Amounts are micro-CNY. */
export const costRecords = pgTable(
  "cost_records",
  {
    recordId: text("record_id").primaryKey(),
    callId: text("call_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    scopeKind: text("scope_kind").notNull().default("run"),
    scopeId: text("scope_id"),
    jobId: text("job_id"),
    changeId: text("change_id"),
    managerSessionId: text("manager_session_id"),
    stageId: text("stage_id"),
    agentId: text("agent_id"),
    source: text("source").notNull(),
    artifactId: text("artifact_id"),
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    unitPriceInMicro: bigint("unit_price_in_micro", { mode: "number" })
      .notNull()
      .default(0),
    unitPriceOutMicro: bigint("unit_price_out_micro", { mode: "number" })
      .notNull()
      .default(0),
    priceVersion: text("price_version").notNull(),
    currency: text("currency").notNull().default("CNY"),
    costCnyMicro: bigint("cost_cny_micro", { mode: "number" })
      .notNull()
      .default(0),
    tracked: boolean("tracked").notNull().default(true),
    untrackedReason: text("untracked_reason"),
    dayKey: text("day_key").notNull(),
    ts: timestamp("ts", { withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("cost_records_call_idx").on(table.workspaceId, table.callId),
    index("idx_cost_records_day").on(table.workspaceId, table.dayKey),
    index("idx_cost_records_run").on(table.workspaceId, table.runId, table.ts),
    index("idx_cost_records_artifact").on(table.workspaceId, table.artifactId),
    index("idx_cost_records_scope").on(
      table.workspaceId,
      table.scopeKind,
      table.ts,
    ),
    index("idx_cost_records_job").on(table.workspaceId, table.jobId),
    index("idx_cost_records_change").on(table.workspaceId, table.changeId),
    index("idx_cost_records_manager_session").on(
      table.workspaceId,
      table.managerSessionId,
    ),
  ],
);

export const priceTables = pgTable("price_tables", {
  version: text("version").primaryKey(),
  effectiveAt: timestamp("effective_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  currency: text("currency").notNull().default("CNY"),
  entries: jsonb("entries").$type<unknown[]>().notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
});

export const providerBills = pgTable(
  "provider_bills",
  {
    billId: text("bill_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    currency: text("currency").notNull().default("CNY"),
    amountCnyMicro: bigint("amount_cny_micro", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    importedAt: timestamp("imported_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("provider_bills_identity_idx").on(
      table.workspaceId,
      table.provider,
      table.periodStart,
      table.periodEnd,
      table.source,
    ),
    index("idx_provider_bills_period").on(
      table.workspaceId,
      table.provider,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);

/** Incident records (61 §2, §3.4). */
export const incidents = pgTable(
  "incidents",
  {
    incidentId: text("incident_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    severity: text("severity").$type<IncidentSeverity>().notNull(),
    detectedAt: timestamp("detected_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: text("status").$type<IncidentStatus>().notNull(),
    owner: text("owner").notNull(),
    timeline: jsonb("timeline")
      .$type<IncidentTimelineEntry[]>()
      .notNull()
      .default([]),
    postmortem: jsonb("postmortem").$type<Postmortem>().notNull(),
    degradationModeId: text("degradation_mode_id"),
    regressionCaseRef: text("regression_case_ref"),
    evolutionSignalRef: text("evolution_signal_ref"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    index("idx_incidents_workspace").on(table.workspaceId, table.detectedAt),
    index("idx_incidents_status").on(table.workspaceId, table.status),
  ],
);

/** Runbooks, one per degradation mode (61 §3.2). */
export const runbooks = pgTable(
  "runbooks",
  {
    runbookId: text("runbook_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    modeId: text("mode_id").notNull(),
    trigger: text("trigger").notNull(),
    steps: jsonb("steps").$type<RunbookStep[]>().notNull(),
    owner: text("owner").notNull(),
    verification: jsonb("verification")
      .$type<RunbookVerification[]>()
      .notNull()
      .default([]),
    status: text("status").$type<RunbookStatus>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [index("idx_runbooks_mode").on(table.workspaceId, table.modeId)],
);

/** Per-runbook drill records (61 §5). */
export const runbookDrills = pgTable(
  "runbook_drills",
  {
    drillId: text("drill_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    runbookId: text("runbook_id").notNull(),
    modeId: text("mode_id").notNull(),
    executedAt: timestamp("executed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    executedBy: text("executed_by").notNull(),
    outcome: text("outcome").$type<DrillOutcome>().notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("idx_runbook_drills_runbook").on(table.runbookId, table.executedAt),
    index("idx_runbook_drills_workspace").on(
      table.workspaceId,
      table.executedAt,
    ),
  ],
);

/** RTO/RPO recovery drills reusing `smoke:recovery` + kitd rollback (D-38). */
export const recoveryDrills = pgTable(
  "recovery_drills",
  {
    drillId: text("drill_id").primaryKey(),
    executedAt: timestamp("executed_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    executedBy: text("executed_by").notNull(),
    script: text("script").notNull(),
    rtoTargetMinutes: integer("rto_target_minutes").notNull(),
    rpoTargetMinutes: integer("rpo_target_minutes").notNull(),
    measuredRtoMinutes: integer("measured_rto_minutes"),
    measuredRpoMinutes: integer("measured_rpo_minutes"),
    kitdRollbackRef: text("kitd_rollback_ref"),
    integrityPass: boolean("integrity_pass").notNull().default(false),
    outcome: text("outcome").$type<DrillOutcome>().notNull(),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [index("idx_recovery_drills_executed").on(table.executedAt)],
);
