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
import { browserInspectTool, httpFetchTool, webSearchTool } from "./web-tools";

export * from "./declarative";
export { resetMcpSessions } from "./mcp";
export * from "./types";
export type { WebSearchHit } from "./web-tools";
export { webSearchTool } from "./web-tools";
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
  webSearchTool,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.definition.name, tool]));

export const KNOWN_TOOLS = [...BY_NAME.keys()];

export const KNOWN_TOOL_DEFINITIONS = TOOLS.map((tool) => ({
  name: tool.definition.name,
  description: tool.definition.description,
}));

function findTool(name: string, extra: Tool[] = []): Tool | null {
  return (
    BY_NAME.get(name) ??
    extra.find((tool) => tool.definition.name === name) ??
    null
  );
}

export function getTool(name: string, extra: Tool[] = []): Tool | null {
  return findTool(name, extra);
}

export function toolDefinitions(names: string[], extra: Tool[] = []) {
  return names.flatMap((name) => {
    const tool = findTool(name, extra);
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
  extra: Tool[] = [],
) {
  const tool = findTool(name, extra);
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
