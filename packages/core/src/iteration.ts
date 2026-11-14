import { z } from "zod";

export const coderIdSchema = z.enum(["dsh", "codex", "opencode", "command"]);

export const verificationCheckSchema = z.enum([
  "typecheck",
  "test",
  "lint",
  "build",
  "bench",
  "security",
]);

export const iterationDomainSchema = z.object({
  workflow: z.string().min(1),
  coder: coderIdSchema.default("dsh"),
  agent: z.string().min(1).optional(),
  riskCeiling: z.enum(["low", "medium", "high"]).default("medium"),
  verification: z
    .array(verificationCheckSchema)
    .min(1)
    .default(["typecheck", "test", "lint"]),
  instructions: z.string().min(1).optional(),
});

export const iterationConfigSchema = z.object({
  apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
  kind: z.literal("IterationPack").default("IterationPack"),
  planner: z
    .object({
      model: z.string().min(1).default("deepseek-pro"),
      maxTasks: z.number().int().min(1).max(20).default(4),
      instructions: z.string().min(1).optional(),
    })
    .default({ model: "deepseek-pro", maxTasks: 4 }),
  domains: z.record(z.string(), iterationDomainSchema),
  autoApply: z
    .object({
      low: z.boolean().default(true),
      medium: z.boolean().default(false),
      high: z.boolean().default(false),
    })
    .default({ low: true, medium: false, high: false }),
});

export const iterationTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  domain: z.string().min(1),
  goal: z.string().min(1).max(8000),
  acceptance: z.string().min(1).max(8000),
  filesHint: z.array(z.string().min(1)).max(50).default([]),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  dependsOn: z.array(z.string().min(1)).default([]),
});

export const taskPlanSchema = z.object({
  goal: z.string().min(1),
  summary: z.string().default(""),
  tasks: z.array(iterationTaskSchema).min(1).max(20),
});

export type IterationConfig = z.infer<typeof iterationConfigSchema>;
export type IterationDomain = z.infer<typeof iterationDomainSchema>;
export type CoderId = z.infer<typeof coderIdSchema>;
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type IterationTask = z.infer<typeof iterationTaskSchema>;
export type TaskPlan = z.infer<typeof taskPlanSchema>;
