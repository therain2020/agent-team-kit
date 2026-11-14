import type {
  DegradationTrigger,
  ExitCriteria,
  Producer,
  QualityFloor,
} from "@kit/core";
import {
  bigint,
  boolean,
  date,
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
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "string",
  }).notNull(),
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

export const runRequests = pgTable("run_requests", {
  requestId: text("request_id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  workflowId: text("workflow_id").notNull(),
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
