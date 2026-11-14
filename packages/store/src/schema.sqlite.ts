import type {
  DegradationTrigger,
  ExitCriteria,
  Producer,
  QualityFloor,
} from "@kit/core";
import {
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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
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

export const runRequests = sqliteTable("run_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull(),
  claimedBy: text("claimed_by"),
  claimedAt: text("claimed_at"),
  heartbeatAt: text("heartbeat_at"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
