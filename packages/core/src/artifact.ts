import { z } from "zod";
import { runModeSchema } from "./event";

export const sensitivitySchema = z.enum([
  "public",
  "internal",
  "secret",
  "pii",
]);

export type Sensitivity = z.infer<typeof sensitivitySchema>;

export const blobSchema = z.object({
  blobId: z.string().min(1),
  workspaceId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type Blob = z.infer<typeof blobSchema>;

export const producerSchema = z.object({
  agentId: z.string().min(1),
  agentVersion: z.string().min(1),
  promptHash: z.string().min(1),
  modelId: z.string().min(1),
});

export type Producer = z.infer<typeof producerSchema>;

export const manifestSchema = z.object({
  manifestId: z.string().min(1),
  workspaceId: z.string().min(1),
  producer: producerSchema,
  inputs: z.array(
    z.object({
      artifactId: z.string().min(1),
      version: z.number().int().positive(),
    }),
  ),
  runId: z.string().min(1),
  stageId: z.string().min(1),
  runMode: runModeSchema,
  cost: z.object({
    currency: z.literal("CNY"),
    amount: z.number().nonnegative(),
    tokens: z.number().int().nonnegative(),
  }),
  evalRefs: z.array(z.string()).default([]),
  approvalRefs: z.array(z.string()).default([]),
  sensitivity: sensitivitySchema,
  retentionClass: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type Manifest = z.infer<typeof manifestSchema>;

export const artifactVersionSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  workspaceId: z.string().min(1),
  blobId: z.string().min(1),
  manifestId: z.string().min(1),
  status: z.enum(["staged", "committed", "superseded"]),
  supersedes: z.string().nullable(),
  supersededBy: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
