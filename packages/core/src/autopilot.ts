import { z } from "zod";
import { isCronExpression } from "./cron";

export { isCronExpression } from "./cron";

export const autopilotScheduleSchema = z.object({
  id: z.string().min(1),
  workflow: z.string().min(1),
  cron: z.string().refine(isCronExpression, "invalid 5-field cron expression"),
  mode: z.enum(["DRY_RUN", "LIVE"]).default("DRY_RUN"),
  inputFile: z.string().min(1).optional(),
  budget: z
    .object({
      dailyRuns: z.number().int().positive().optional(),
      dailyCostCny: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const autopilotIterationSchema = z.object({
  id: z.string().min(1),
  cron: z.string().refine(isCronExpression, "invalid 5-field cron expression"),
  goal: z.string().min(1),
  acceptance: z.string().min(1).optional(),
  maxTasks: z.number().int().min(1).max(20).default(2),
  maxRepair: z.number().int().min(0).max(5).default(1),
  mode: z.enum(["DRY_RUN", "LIVE"]).default("DRY_RUN"),
  applyMode: z.enum(["none", "low", "low-medium"]).default("none"),
  coder: z.enum(["dsh", "codex", "opencode", "command"]).optional(),
  budget: z
    .object({
      dailyRuns: z.number().int().positive().optional(),
      dailyCostCny: z.number().nonnegative().optional(),
    })
    .optional(),
});

export const autopilotSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(false),
  timezone: z.string().default("UTC"),
  schedules: z.array(autopilotScheduleSchema).default([]),
  iterations: z.array(autopilotIterationSchema).default([]),
  approval: z
    .object({
      autoApprove: z
        .object({
          enabled: z.boolean().default(false),
          maxRisk: z.enum(["low", "medium", "high"]).default("low"),
          maxRunCostCny: z.number().nonnegative().optional(),
          onTimeout: z.enum(["wait", "abort"]).default("wait"),
        })
        .optional(),
    })
    .optional(),
  evolution: z
    .object({
      enabled: z.boolean().default(false),
      cadence: z.enum(["daily", "weekly"]).default("weekly"),
      agent: z.string().min(1).optional(),
      evidenceFile: z.string().min(1).optional(),
      autoApply: z.boolean().default(false),
      budgetCny: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type AutopilotConfig = z.infer<typeof autopilotSchema>;
export type AutopilotSchedule = z.infer<typeof autopilotScheduleSchema>;
export type AutopilotIteration = z.infer<typeof autopilotIterationSchema>;

export const MISSION_STAGE_SUFFIX = ":mission-assignment";

export const missionAssignmentSchema = z.object({
  goal: z.string().min(1),
  acceptance: z.string().optional(),
  packDir: z.string().min(1),
  workflow: z.string().min(1),
  manager: z.string().min(1),
  sellers: z.array(z.string().min(1)).default([]),
  builders: z.array(z.string().min(1)).default([]),
  specialists: z.array(z.string().min(1)).default([]),
  agents: z.array(z.string().min(1)).min(1),
  allowCombined: z.boolean().default(true),
  mode: z.enum(["DRY_RUN", "LIVE"]).default("DRY_RUN"),
  createdAt: z.string().min(1),
  createdBy: z.string().min(1),
});

export type MissionAssignment = z.infer<typeof missionAssignmentSchema>;
