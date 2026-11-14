import {
  repoBuildTool,
  repoDiffTool,
  repoLintTool,
  repoListTool,
  repoReadTool,
  repoSearchTool,
  repoTestTool,
  repoTypecheckTool,
  workspaceDiffTool,
  workspaceWriteTool,
} from "./repo-tools";
import {
  securityScanCodeTool,
  securityScanDependenciesTool,
} from "./security-tools";
import type { Tool } from "./types";
import { browserInspectTool, httpFetchTool } from "./web-tools";

export * from "./types";
export {
  repoReadTool,
  repoSearchTool,
  securityScanCodeTool,
  securityScanDependenciesTool,
};

const TOOLS: Tool[] = [
  repoListTool,
  repoReadTool,
  repoSearchTool,
  repoDiffTool,
  repoTypecheckTool,
  repoTestTool,
  repoLintTool,
  repoBuildTool,
  workspaceWriteTool,
  workspaceDiffTool,
  securityScanCodeTool,
  securityScanDependenciesTool,
  httpFetchTool,
  browserInspectTool,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));

export const KNOWN_TOOLS = [...BY_NAME.keys()];

export function getTool(name: string): Tool | null {
  return BY_NAME.get(name) ?? null;
}

export function toolDefinitions(names: string[]) {
  return names.flatMap((name) => {
    const tool = BY_NAME.get(name);
    return tool
      ? [
          {
            name: tool.definition.name,
            description: tool.definition.description,
            parameters: tool.definition.parameters,
          },
        ]
      : [];
  });
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: Parameters<Tool["execute"]>[1],
) {
  const tool = BY_NAME.get(name);
  if (!tool) {
    throw new Error(`unknown tool: ${name}`);
  }
  if (context.readOnly === true && tool.definition.risk !== "read") {
    throw new Error(
      `tool "${name}" is a ${tool.definition.risk} action; side effects are paused by night mode`,
    );
  }
  return tool.execute(args, context);
}
