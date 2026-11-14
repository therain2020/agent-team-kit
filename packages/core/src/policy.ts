import { z } from "zod";

export const policyRuleSchema = z.object({
  match: z.string().min(1),
  class: z.enum(["A", "B", "C", "D"]),
  approval: z
    .object({
      ttl: z.string().min(1).optional(),
      scope: z.string().min(1).optional(),
    })
    .optional(),
});

export const policySchema = z.object({
  version: z.number().int().positive(),
  actions: z.array(policyRuleSchema).min(1),
});

export type Policy = z.infer<typeof policySchema>;
