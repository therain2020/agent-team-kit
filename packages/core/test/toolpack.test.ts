import { describe, expect, it } from "vitest";
import { skillPackSchema, teamPackSchema, toolPackSchema } from "../src";

const httpTool = {
  name: "weather_lookup",
  description: "Look up the weather for a city",
  risk: "network",
  adapter: "http",
  endpoint: "https://api.example.com/weather",
  method: "GET",
  permissions: { network: true },
};

function toolPack(tools: unknown[]) {
  return {
    apiVersion: "agentteam/v1",
    kind: "ToolPack",
    name: "weather",
    version: "1.0.0",
    tools,
  };
}

describe("tool pack schema", () => {
  it("parses declarative http and mcp tools with defaults", () => {
    const parsed = toolPackSchema.parse(
      toolPack([
        httpTool,
        {
          name: "mcp_lookup",
          description: "Call a remote MCP server",
          risk: "network",
          adapter: "mcp",
          endpoint: "https://mcp.example.com/sse",
          toolName: "lookup",
          permissions: { network: true },
        },
      ]),
    );
    expect(parsed.tools[0]?.timeoutMs).toBe(15_000);
    expect(parsed.tools[0]?.method).toBe("GET");
    expect(parsed.tools[1]?.method).toBe("POST");
  });

  it("rejects duplicate tool names", () => {
    const parsed = toolPackSchema.safeParse(toolPack([httpTool, httpTool]));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        "duplicate tool name: weather_lookup",
      );
    }
  });

  it("requires network permission for http tools", () => {
    const parsed = toolPackSchema.safeParse(
      toolPack([{ ...httpTool, permissions: {} }]),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects credential headers", () => {
    const parsed = toolPackSchema.safeParse(
      toolPack([{ ...httpTool, headers: { Authorization: "Bearer x" } }]),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects credentials embedded in the endpoint", () => {
    const parsed = toolPackSchema.safeParse(
      toolPack([
        { ...httpTool, endpoint: "https://user:pass@api.example.com/weather" },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  it("requires command tools to run sandboxed with execute risk", () => {
    const base = {
      name: "run_script",
      description: "Run a script",
      adapter: "command",
      command: ["node", "script.js"],
      permissions: { filesystem: "sandbox" },
    };
    expect(
      toolPackSchema.safeParse(toolPack([{ ...base, risk: "execute" }]))
        .success,
    ).toBe(true);
    expect(
      toolPackSchema.safeParse(toolPack([{ ...base, risk: "write" }])).success,
    ).toBe(false);
    expect(
      toolPackSchema.safeParse(
        toolPack([
          { ...base, risk: "execute", permissions: { filesystem: "none" } },
        ]),
      ).success,
    ).toBe(false);
    expect(
      toolPackSchema.safeParse(
        toolPack([
          {
            ...base,
            risk: "execute",
            permissions: { filesystem: "sandbox", network: true },
          },
        ]),
      ).success,
    ).toBe(false);
  });
});

describe("skill pack schema", () => {
  it("requires the entry file to be listed", () => {
    const parsed = skillPackSchema.safeParse({
      apiVersion: "agentteam/v1",
      kind: "SkillPack",
      name: "writer",
      version: "1.0.0",
      entry: "skills/writer/SKILL.md",
      files: ["skills/writer/helper.md"],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects path traversal", () => {
    const parsed = skillPackSchema.safeParse({
      apiVersion: "agentteam/v1",
      kind: "SkillPack",
      name: "writer",
      version: "1.0.0",
      entry: "../SKILL.md",
      files: ["../SKILL.md"],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("team pack schema", () => {
  it("defaults toolpack and skillpack lists", () => {
    const parsed = teamPackSchema.parse({
      apiVersion: "agentteam/v1",
      kind: "TeamPack",
      metadata: {
        name: "demo",
        version: "1.0.0",
        compatibility: { kit: ">=0.1 <2.0" },
      },
      agents: [{ id: "echo", file: "agents/echo.md", model: "deepseek-flash" }],
      workflows: ["workflows/main.yaml"],
    });
    expect(parsed.toolpacks).toEqual([]);
    expect(parsed.skillpacks).toEqual([]);
  });
});
