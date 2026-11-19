import type {
  DegradationTrigger,
  ExitCriteria,
  LkgArtifactRef,
  Producer,
  QualityFloor,
} from "@kit/core";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

type Cost = { currency: "CNY"; amount: number; tokens: number };
type InputRef = { artifactId: string; version: number };

export const events = sqliteTable("events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  workspaceId: text("workspace_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  occurredAt: text("occurred_at").notNull(),
  receivedAt: text("received_at").notNull(),
  traceId: text("trace_id").notNull(),
  payloadRef: text("payload_ref").notNull(),
});

export const runs = sqliteTable("runs", {
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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull().default(0),
});

export const stages = sqliteTable("stages", {
  stageId: text("stage_id").primaryKey(),
  runId: text("run_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  checkpointId: text("checkpoint_id"),
  error: text("error"),
  version: integer("version").notNull().default(0),
});

export const manifests = sqliteTable("manifests", {
  manifestId: text("manifest_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  producer: text("producer", { mode: "json" }).$type<Producer>().notNull(),
  inputRefs: text("input_refs", { mode: "json" }).$type<InputRef[]>().notNull(),
  runId: text("run_id").notNull(),
  stageId: text("stage_id").notNull(),
  runMode: text("run_mode").notNull(),
  cost: text("cost", { mode: "json" }).$type<Cost>().notNull(),
  evalRefs: text("eval_refs", { mode: "json" }).$type<string[]>().notNull(),
  approvalRefs: text("approval_refs", { mode: "json" })
    .$type<string[]>()
    .notNull(),
  sensitivity: text("sensitivity").notNull(),
  retentionClass: text("retention_class").notNull(),
  createdAt: text("created_at").notNull(),
});

export const blobs = sqliteTable("blobs", {
  blobId: text("blob_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: text("created_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  artifactId: text("artifact_id").notNull(),
  version: integer("version").notNull(),
  workspaceId: text("workspace_id").notNull(),
  blobId: text("blob_id").notNull(),
  manifestId: text("manifest_id").notNull(),
  status: text("status").notNull(),
  supersedes: text("supersedes"),
  supersededBy: text("superseded_by"),
  createdAt: text("created_at").notNull(),
});

/** Lineage edge endpoints are always ArtifactVersions (30 §3.2). */
export const artifactEdges = sqliteTable(
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
    createdAt: text("created_at").notNull(),
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

export const runRequests = sqliteTable("run_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  kind: text("kind").notNull().default("pack_run"),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  claimedBy: text("claimed_by"),
  claimedAt: text("claimed_at"),
  heartbeatAt: text("heartbeat_at"),
  /** Fencing token; incremented on every claim. */
  leaseVersion: integer("lease_version").notNull().default(0),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Artifact-level last-known-good pins (61 §2). */
export const lastKnownGood = sqliteTable(
  "last_known_good",
  {
    lkgId: text("lkg_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    targetKey: text("target_key").notNull(),
    artifactRefs: text("artifact_refs", { mode: "json" })
      .$type<LkgArtifactRef[]>()
      .notNull(),
    verifiedAt: text("verified_at").notNull(),
    verifier: text("verifier").notNull(),
    status: text("status").notNull(),
    supersedes: text("supersedes"),
    supersededBy: text("superseded_by"),
    createdAt: text("created_at").notNull(),
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

export const degradationState = sqliteTable(
  "degradation_state",
  {
    scope: text("scope").notNull(),
    workspaceId: text("workspace_id").notNull(),
    modeId: text("mode_id").notNull(),
    kind: text("kind").notNull(),
    triggers: text("triggers", { mode: "json" })
      .$type<DegradationTrigger[]>()
      .notNull(),
    behavior: text("behavior").notNull(),
    qualityFloor: text("quality_floor", { mode: "json" })
      .$type<QualityFloor>()
      .notNull(),
    exitCriteria: text("exit_criteria", { mode: "json" })
      .$type<ExitCriteria>()
      .notNull(),
    status: text("status").notNull(),
    enteredAt: text("entered_at").notNull(),
    enteredBy: text("entered_by").notNull(),
    exitedAt: text("exited_at"),
    exitReason: text("exit_reason"),
  },
  (table) => [primaryKey({ columns: [table.scope, table.workspaceId] })],
);

export const degradationAudit = sqliteTable("degradation_audit", {
  auditId: text("audit_id").primaryKey(),
  occurredAt: text("occurred_at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  scope: text("scope").notNull(),
  workspaceId: text("workspace_id").notNull(),
  modeId: text("mode_id").notNull(),
  detail: text("detail", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
});

export const autopilotState = sqliteTable(
  "autopilot_state",
  {
    workspaceId: text("workspace_id").notNull(),
    packDir: text("pack_dir").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    lastTickAt: text("last_tick_at"),
    nextRuns: text("next_runs", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull(),
    day: text("day"),
    runsToday: integer("runs_today").notNull().default(0),
    spentToday: real("spent_today").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.packDir] })],
);

export const managerSessions = sqliteTable(
  "manager_sessions",
  {
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    windowStartedAt: text("window_started_at").notNull(),
    windowEndsAt: text("window_ends_at").notNull(),
    firstAt: text("first_at").notNull(),
    lastAt: text("last_at").notNull(),
    tokens: integer("tokens").notNull().default(0),
    costCny: real("cost_cny").notNull().default(0),
    exchanges: integer("exchanges").notNull().default(0),
    rejections: integer("rejections").notNull().default(0),
    lastRejectionReason: text("last_rejection_reason"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.sessionId] })],
);

export const killSwitches = sqliteTable(
  "kill_switches",
  {
    switchId: text("switch_id").primaryKey(),
    scope: text("scope").notNull(),
    target: text("target").notNull().default(""),
    workspaceId: text("workspace_id").notNull().default(""),
    state: text("state").notNull(),
    activatedBy: text("activated_by").notNull(),
    reason: text("reason").notNull(),
    activatedAt: text("activated_at").notNull(),
    releasedBy: text("released_by"),
    releasedAt: text("released_at"),
    releaseReason: text("release_reason"),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_kill_switches_identity").on(
      table.scope,
      table.target,
      table.workspaceId,
    ),
  ],
);
export const budgets = sqliteTable(
  "budgets",
  {
    budgetId: text("budget_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scope: text("scope").notNull(),
    targetKey: text("target_key").notNull(),
    period: text("period"),
    dayKey: text("day_key"),
    monthKey: text("month_key"),
    limitCnyMicro: integer("limit_cny_micro"),
    limitTokens: integer("limit_tokens"),
    spentCnyMicro: integer("spent_cny_micro").notNull().default(0),
    spentTokens: integer("spent_tokens").notNull().default(0),
    reservedCnyMicro: integer("reserved_cny_micro").notNull().default(0),
    reservedTokens: integer("reserved_tokens").notNull().default(0),
    hard: integer("hard", { mode: "boolean" }).notNull().default(true),
    alert80Cny: integer("alert80_cny", { mode: "boolean" })
      .notNull()
      .default(false),
    alert80Tokens: integer("alert80_tokens", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("budgets_scope_target_idx").on(
      table.workspaceId,
      table.scope,
      table.targetKey,
    ),
  ],
);

export const budgetReservations = sqliteTable("budget_reservations", {
  reservationId: text("reservation_id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  runId: text("run_id").notNull(),
  stageId: text("stage_id"),
  agentId: text("agent_id"),
  purpose: text("purpose").notNull(),
  budgetIds: text("budget_ids", { mode: "json" }).$type<string[]>().notNull(),
  amountCnyMicro: integer("amount_cny_micro").notNull(),
  amountTokens: integer("amount_tokens").notNull(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const budgetCharges = sqliteTable(
  "budget_charges",
  {
    chargeId: text("charge_id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    stageId: text("stage_id"),
    agentId: text("agent_id"),
    purpose: text("purpose").notNull(),
    costCnyMicro: integer("cost_cny_micro").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("budget_charges_reservation_idx").on(table.reservationId),
  ],
);

/** Per-call cost attribution (60 §2/§3.3). Amounts are micro-CNY. */
export const costRecords = sqliteTable(
  "cost_records",
  {
    recordId: text("record_id").primaryKey(),
    callId: text("call_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    stageId: text("stage_id"),
    agentId: text("agent_id"),
    source: text("source").notNull(),
    artifactId: text("artifact_id"),
    modelId: text("model_id").notNull(),
    provider: text("provider").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    unitPriceInMicro: integer("unit_price_in_micro").notNull().default(0),
    unitPriceOutMicro: integer("unit_price_out_micro").notNull().default(0),
    priceVersion: text("price_version").notNull(),
    currency: text("currency").notNull().default("CNY"),
    costCnyMicro: integer("cost_cny_micro").notNull().default(0),
    tracked: integer("tracked", { mode: "boolean" }).notNull().default(true),
    untrackedReason: text("untracked_reason"),
    dayKey: text("day_key").notNull(),
    ts: text("ts").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("cost_records_call_idx").on(table.workspaceId, table.callId),
    index("idx_cost_records_day").on(table.workspaceId, table.dayKey),
    index("idx_cost_records_run").on(table.workspaceId, table.runId, table.ts),
    index("idx_cost_records_artifact").on(table.workspaceId, table.artifactId),
  ],
);

export const priceTables = sqliteTable("price_tables", {
  version: text("version").primaryKey(),
  effectiveAt: text("effective_at").notNull(),
  currency: text("currency").notNull().default("CNY"),
  entries: text("entries", { mode: "json" }).$type<unknown[]>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const providerBills = sqliteTable(
  "provider_bills",
  {
    billId: text("bill_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    currency: text("currency").notNull().default("CNY"),
    amountCnyMicro: integer("amount_cny_micro").notNull(),
    source: text("source").notNull(),
    importedAt: text("imported_at").notNull(),
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
