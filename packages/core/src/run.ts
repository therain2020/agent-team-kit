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

export const runSchema = z.object({
  runId: z.string().min(1),
  eventId: z.string().min(1),
  workspaceId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowVersion: z.string().min(1),
  runMode: runModeSchema,
  status: runStatusSchema,
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
