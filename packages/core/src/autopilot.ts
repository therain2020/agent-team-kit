import { z } from "zod";

const CRON_FIELD = /^(\*|(\d+)(-\d+)?)(\/\d+)?$/;

export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }
  return fields.every((field) =>
    field
      .split(",")
      .filter(Boolean)
      .every((part) => CRON_FIELD.test(part)),
  );
}

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

export const autopilotSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(false),
  timezone: z.string().default("UTC"),
  schedules: z.array(autopilotScheduleSchema).default([]),
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
