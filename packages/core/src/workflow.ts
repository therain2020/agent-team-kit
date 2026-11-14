import { z } from "zod";
import { failureModeSchema } from "./degradation";

export const retryPolicySchema = z.object({
  max: z.number().int().positive(),
  backoff: z.enum(["fixed", "exp"]),
});

export const approvalAutoWhenSchema = z.object({
  maxRunCostCny: z.number().nonnegative().optional(),
  riskClass: z
    .array(z.enum(["low", "medium", "high"]))
    .min(1)
    .optional(),
  stages: z.array(z.string().min(1)).min(1).optional(),
});

export const approvalNotifySchema = z.object({
  webhook: z.string().url().optional(),
  tokenEnv: z.string().min(1).optional(),
});

export const stageApprovalSchema = z.object({
  mode: z.enum(["required", "auto", "never"]).default("required"),
  position: z.enum(["before", "after"]).default("after"),
  riskClass: z.enum(["low", "medium", "high"]).default("medium"),
  ttl: z.string().min(1).default("7d"),
  notify: approvalNotifySchema.optional(),
  autoApproveWhen: approvalAutoWhenSchema.optional(),
});

export type StageApproval = z.infer<typeof stageApprovalSchema>;

export const workflowStageSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["workflow", "agent", "coder"]),
    agent: z.string().min(1).optional(),
    coder: z.enum(["dsh", "codex", "opencode", "command"]).optional(),
    goal: z.string().min(1).optional(),
    acceptance: z.string().min(1).optional(),
    inputs: z.array(z.string().min(1)).min(1),
    outputs: z.array(z.string().min(1)).min(1),
    timeout: z.string().min(1).optional(),
    retry: retryPolicySchema.optional(),
    gate: z.string().min(1).optional(),
    includeInitialInput: z.boolean().optional(),
    inputFrom: z.string().min(1).optional(),
    inputsFrom: z.array(z.string().min(1)).min(1).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    revisionAgent: z.string().min(1).optional(),
    approval: stageApprovalSchema.optional(),
    failureMode: failureModeSchema.optional(),
  })
  .superRefine((stage, ctx) => {
    if (stage.inputFrom && stage.inputsFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "use inputFrom or inputsFrom, not both",
        path: ["inputsFrom"],
      });
    }
    if (
      stage.inputsFrom &&
      new Set(stage.inputsFrom).size !== stage.inputsFrom.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "inputsFrom must be unique",
        path: ["inputsFrom"],
      });
    }
    if (stage.type === "agent" && !stage.agent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent stage requires agent",
        path: ["agent"],
      });
    }
    if (stage.type === "coder" && !stage.coder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "coder stage requires coder",
        path: ["coder"],
      });
    }
  });

export const deliverySchema = z.object({
  channel: z.enum(["im", "email", "local_file", "webhook"]),
  approval: z.enum(["never", "required_if_published"]).optional(),
});

export const workflowDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z
    .union([z.string().min(1), z.number()])
    .transform((value) =>
      typeof value === "number" ? value.toFixed(1) : value,
    ),
  trigger: z.object({
    event: z.string().min(1),
    schedule: z.string().min(1).optional(),
  }),
  stages: z.array(workflowStageSchema).min(1),
  delivery: deliverySchema.optional(),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
