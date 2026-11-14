import { z } from "zod";

export const rubricDimensionSchema = z.object({
  weight: z.number().positive(),
  threshold: z.number().positive(),
});

export const rubricDefinitionSchema = z.object({
  dimensions: z.record(rubricDimensionSchema),
});

export const rubricSetSchema = z.object({
  version: z.number().int().positive(),
  rubrics: z.record(rubricDefinitionSchema),
});

export type RubricDimension = z.infer<typeof rubricDimensionSchema>;
export type RubricSet = z.infer<typeof rubricSetSchema>;
