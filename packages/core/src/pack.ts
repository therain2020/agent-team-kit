import { z } from "zod";
import { ASSET_ENTRY } from "./assets";
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
  toolpacks: z.array(z.string()).default([]),
  skillpacks: z.array(z.string()).default([]),
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
  agents: z.array(templateAgentSchema).default([]),
  workflow: workflowDefinitionSchema,
  policy: policySchema,
  autopilot: autopilotSchema,
});

export type TemplateAgent = z.infer<typeof templateAgentSchema>;
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type TemplateRoles = z.infer<typeof templateRolesSchema>;

const WORKSHOP_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export const workshopSignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  value: z.string().min(16).max(4096),
});

export type WorkshopSignature = z.infer<typeof workshopSignatureSchema>;

export const workshopManifestSchema = z
  .object({
    apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
    kind: z.enum([
      "pack",
      "workflow",
      "agent",
      "toolpack",
      "skillpack",
      "pipeline",
      "source",
      "template",
    ]),
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
    signature: workshopSignatureSchema.optional(),
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
    const expectedEntry = ASSET_ENTRY[manifest.kind];
    if (expectedEntry && manifest.entry !== expectedEntry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${manifest.kind} items must use entry ${expectedEntry}`,
        path: ["entry"],
      });
    }
  });

export type WorkshopManifest = z.infer<typeof workshopManifestSchema>;

export const packToolRiskSchema = z.enum([
  "read",
  "write",
  "execute",
  "network",
]);

export type PackToolRisk = z.infer<typeof packToolRiskSchema>;

export const packToolPermissionsSchema = z.object({
  network: z.boolean().default(false),
  filesystem: z.enum(["none", "sandbox"]).default("none"),
});

export type PackToolPermissions = z.infer<typeof packToolPermissionsSchema>;

const FORBIDDEN_TOOL_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const packToolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    description: z.string().min(1).max(500),
    risk: packToolRiskSchema,
    adapter: z.enum(["http", "mcp", "command"]),
    inputSchema: z.record(z.unknown()).default({
      type: "object",
      properties: {},
    }),
    endpoint: z
      .string()
      .url()
      .refine(
        (value) => /^https?:\/\//i.test(value),
        "endpoint must use http or https",
      )
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      }, "endpoint must not include credentials")
      .optional(),
    method: z.enum(HTTP_METHODS).default("POST"),
    headers: z
      .record(
        z
          .string()
          .max(1024)
          .refine(
            (value) => !/[\r\n]/.test(value),
            "header values cannot contain newlines",
          ),
      )
      .optional(),
    toolName: z.string().min(1).max(128).optional(),
    command: z.array(z.string().min(1)).min(1).max(32).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    permissions: packToolPermissionsSchema.default({
      network: false,
      filesystem: "none",
    }),
  })
  .superRefine((tool, ctx) => {
    const issue = (message: string, path: Array<string | number>) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });

    if (tool.adapter === "http" || tool.adapter === "mcp") {
      if (!tool.endpoint) {
        issue("endpoint is required for http and mcp tools", ["endpoint"]);
      }
      if (!tool.permissions.network) {
        issue("http and mcp tools require permissions.network", [
          "permissions",
          "network",
        ]);
      }
      if (tool.command) {
        issue("command is only valid for adapter=command", ["command"]);
      }
    }

    if (tool.adapter === "http" && tool.toolName) {
      issue("toolName is only valid for adapter=mcp", ["toolName"]);
    }

    if (tool.adapter === "mcp" && tool.method !== "POST") {
      issue("mcp tools always use POST", ["method"]);
    }

    if (tool.adapter === "command") {
      if (!tool.command) {
        issue("command is required for adapter=command", ["command"]);
      }
      if (tool.endpoint) {
        issue("endpoint is only valid for http and mcp tools", ["endpoint"]);
      }
      if (tool.toolName) {
        issue("toolName is only valid for adapter=mcp", ["toolName"]);
      }
      if (tool.risk !== "execute") {
        issue("command tools must declare risk=execute", ["risk"]);
      }
      if (tool.permissions.filesystem !== "sandbox") {
        issue("command tools must run in the sandbox", [
          "permissions",
          "filesystem",
        ]);
      }
      if (tool.permissions.network) {
        issue("command tools cannot request network", [
          "permissions",
          "network",
        ]);
      }
    }

    for (const header of Object.keys(tool.headers ?? {})) {
      if (FORBIDDEN_TOOL_HEADERS.has(header.toLowerCase())) {
        issue(`header is not allowed: ${header}`, ["headers", header]);
      }
    }
  });

export type PackTool = z.infer<typeof packToolSchema>;

export const toolPackSchema = z
  .object({
    apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
    kind: z.literal("ToolPack"),
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    description: z.string().default(""),
    tools: z.array(packToolSchema).min(1).max(50),
  })
  .superRefine((pack, ctx) => {
    const names = new Set<string>();
    for (const [index, tool] of pack.tools.entries()) {
      if (names.has(tool.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate tool name: ${tool.name}`,
          path: ["tools", index, "name"],
        });
      }
      names.add(tool.name);
    }
  });

export type ToolPack = z.infer<typeof toolPackSchema>;

export const skillPackSchema = z
  .object({
    apiVersion: z.literal("agentteam/v1").default("agentteam/v1"),
    kind: z.literal("SkillPack"),
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+/),
    description: z.string().default(""),
    entry: z.string().regex(WORKSHOP_PATH),
    files: z.array(z.string().regex(WORKSHOP_PATH)).min(1).max(200),
  })
  .superRefine((pack, ctx) => {
    if (!pack.files.includes(pack.entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entry must be listed in files",
        path: ["entry"],
      });
    }
    if (pack.files.length !== new Set(pack.files).size) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "files must be unique",
        path: ["files"],
      });
    }
  });

export type SkillPack = z.infer<typeof skillPackSchema>;
