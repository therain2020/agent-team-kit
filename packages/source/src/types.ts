import { z } from "zod";

export const SOURCE_TOPIC = "agent-team-source";

export const sourceDefinitionSchema = z.object({
  apiVersion: z.literal("agentteam/source/v1"),
  kind: z.literal("Source"),
  metadata: z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "invalid source name"),
    version: z.string().min(1),
    description: z.string().optional(),
    license: z.string().optional(),
    homepage: z.string().url().optional(),
    author: z.string().optional(),
  }),
  spec: z.object({
    type: z.enum(["rss", "json", "github"]),
    request: z.object({
      url: z.string().url(),
      headers: z.record(z.string()).optional(),
    }),
    mapping: z
      .object({
        items: z.string().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        publishedAt: z.string().optional(),
        summary: z.string().optional(),
        score: z.string().optional(),
      })
      .optional(),
    limits: z
      .object({
        timeoutMs: z.number().int().positive().max(30000).optional(),
        maxItems: z.number().int().positive().max(100).optional(),
      })
      .optional(),
  }),
  compliance: z
    .object({
      tos: z.string().url().optional(),
      attribution: z.enum(["required", "optional", "none"]).optional(),
      notes: z.string().optional(),
    })
    .optional(),
  security: z
    .object({
      dataOnly: z.literal(true).optional(),
    })
    .optional(),
});

export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;

export interface SourceMeta {
  name: string;
  repo: string;
  commit: string;
  manifestSha256: string;
  installedAt: string;
  trust: "builtin" | "third-party";
  homepage?: string;
  license?: string;
}

export interface InstalledSource {
  definition: SourceDefinition;
  meta: SourceMeta;
  file: string;
}

export type SourceKind = string;

export interface RawSourceItem {
  source: string;
  sourceId: string;
  title: string;
  url: string;
  publishedAt?: string;
  summary?: string;
  score?: number;
}

export interface EvidenceSource extends RawSourceItem {
  citationId: string;
}

export interface EvidenceError {
  source: string;
  message: string;
}

export interface EvidenceSet {
  generatedAt: string;
  sources: EvidenceSource[];
  errors: EvidenceError[];
}

export interface SourceCandidate {
  repo: string;
  htmlUrl: string;
  description: string | null;
  stars: number;
  topics: string[];
  updatedAt: string;
  manifest?: SourceDefinition;
  manifestError?: string;
}
