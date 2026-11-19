import { z } from "zod";
import { runModeSchema } from "./event";

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "paused",
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const stageStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export type StageStatus = z.infer<typeof stageStatusSchema>;

/**
 * Where a job was launched from. `unknown` is the read-back value for rows
 * created before origin was persisted; it is never written by new code.
 */
export const runOriginKindSchema = z.enum([
  "cli",
  "web",
  "api",
  "manual",
  "schedule",
  "event",
  "information",
  "autopilot",
  "unknown",
]);

export type RunOriginKind = z.infer<typeof runOriginKindSchema>;

export const runOriginSchema = z.object({
  kind: runOriginKindSchema,
  triggerId: z.string().min(1).optional(),
  triggerRunId: z.string().min(1).optional(),
});

export type RunOrigin = z.infer<typeof runOriginSchema>;

export const runSchema = z.object({
  runId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowVersion: z.string().min(1),
  runMode: runModeSchema,
  status: runStatusSchema,
  originKind: runOriginKindSchema.optional(),
  triggerId: z.string().optional(),
  triggerRunId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Run = z.infer<typeof runSchema>;

export const stageSchema = z.object({
  stageId: z.string().min(1),
  runId: z.string().min(1),
  name: z.string().min(1),
  status: stageStatusSchema,
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  checkpointId: z.string().optional(),
  error: z.string().optional(),
});

export type Stage = z.infer<typeof stageSchema>;
