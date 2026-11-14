import { z } from "zod";

export const runModeSchema = z.enum([
  "LIVE",
  "DRY_RUN",
  "SHADOW",
  "REPLAY",
  "FORK",
  "BACKFILL",
]);

export type RunMode = z.infer<typeof runModeSchema>;

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  schemaVersion: z.literal("1.0"),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  workspaceId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  traceId: z.string().min(1),
  payloadRef: z.string().min(1),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
