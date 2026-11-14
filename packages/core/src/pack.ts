import { z } from "zod";
import { autopilotSchema } from "./autopilot";
import { policySchema } from "./policy";
import { workflowDefinitionSchema } from "./workflow";

export const budgetSchema = z.object({
  tokens: z.number().int().positive().optional(),
  costCny: z.number().nonnegative().optional(),
  wallClockSeconds: z.number().positive().optional(),
});

export type Budget = z.infer<typeof budgetSchema>;

export const agentRoleSchema = z.enum([
  "builder",
  "seller",
  "manager",
  "specialist",
]);

export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentSpecSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  model: z.string().min(1),
  role: agentRoleSchema.optional(),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export type AgentSpec = z.infer<typeof agentSpecSchema>;

export const agentFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  role: agentRoleSchema.optional(),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  permissions: z
    .object({
      filesystem: z.string().optional(),
      network: z.string().optional(),
    })
    .optional(),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().optional(),
  "allowed-tools": z.array(z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export const teamPackSchema = z.object({
  apiVersion: z.literal("agentteam/v1"),
  kind: z.literal("TeamPack"),
  metadata: z.object({
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    description: z.string().optional(),
    license: z.string().optional(),
    compatibility: z.object({ kit: z.string().min(1) }),
  }),
  manager: z
    .object({
      agent: z.string().min(1),
      model: z.string().min(1).optional(),
      budget: budgetSchema.optional(),
    })
    .optional(),
  agents: z.array(agentSpecSchema).min(1),
  roles: z
    .object({
      requireSeller: z.boolean().default(false),
      requireBuilder: z.boolean().default(true),
      allowCombined: z.boolean().default(true),
    })
    .optional(),
  workspaces: z
    .record(
      z.object({
        agents: z.array(z.string()),
        delivery: z.enum(["im", "email", "local_file"]).optional(),
      }),
    )
    .optional(),
  workflows: z.array(z.string()).min(1),
  policies: z.array(z.string()).default([]),
  evals: z.object({ rubrics: z.string().min(1) }).optional(),
});

export type TeamPack = z.infer<typeof teamPackSchema>;

export const templateAgentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  model: z.string().min(1),
  role: agentRoleSchema.default("builder"),
  instructions: z.string().min(1),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export const templateRolesSchema = z
  .object({
    requireSeller: z.boolean().default(false),
    requireBuilder: z.boolean().default(true),
    allowCombined: z.boolean().default(true),
  })
  .default({
    requireSeller: false,
    requireBuilder: true,
    allowCombined: true,
  });

export const templateDefinitionSchema = z.object({
  apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
  kind: z.literal("TeamTemplate").default("TeamTemplate"),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().default(""),
  roles: templateRolesSchema,
  agents: z.array(templateAgentSchema).min(1),
  workflow: workflowDefinitionSchema,
  policy: policySchema,
  autopilot: autopilotSchema,
});

export type TemplateAgent = z.infer<typeof templateAgentSchema>;
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type TemplateRoles = z.infer<typeof templateRolesSchema>;

const WORKSHOP_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export const workshopManifestSchema = z
  .object({
    apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
    kind: z.enum(["pack", "workflow", "agent", "toolpack", "skillpack"]),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    description: z.string().default(""),
    license: z.string().optional(),
    compatibility: z.object({ kit: z.string().min(1) }).optional(),
    entry: z.string().regex(WORKSHOP_PATH),
    files: z.array(z.string().regex(WORKSHOP_PATH)).min(1).max(200),
    topics: z.array(z.string()).default([]),
    permissions: z
      .object({
        network: z.boolean().default(false),
        filesystem: z
          .enum(["none", "readonly", "workspace"])
          .default("workspace"),
        code: z.boolean().default(false),
      })
      .default({ network: false, filesystem: "workspace", code: false }),
  })
  .superRefine((manifest, ctx) => {
    if (!manifest.files.includes(manifest.entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entry must be listed in files",
        path: ["entry"],
      });
    }
    if (manifest.files.length !== new Set(manifest.files).size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "files must be unique",
        path: ["files"],
      });
    }
  });

export type WorkshopManifest = z.infer<typeof workshopManifestSchema>;
