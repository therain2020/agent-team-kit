export type ToolRisk = "read" | "write" | "execute" | "network";

export interface ToolContext {
  repoRoot: string;
  sandboxRoot: string;
  runId: string;
  workspaceId: string;
  runMode: string;
  allowNetwork: boolean;
  allowLocalhost: boolean;
  readOnly?: boolean;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: ToolRisk;
}

export interface Tool {
  definition: ToolDefinition;
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}
