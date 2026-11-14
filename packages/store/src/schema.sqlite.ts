import type { Producer } from "@kit/core";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
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
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.packDir] })],
);
