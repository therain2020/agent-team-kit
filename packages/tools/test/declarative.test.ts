import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packToolSchema } from "@kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Tool,
  type ToolContext,
  createDeclarativeTools,
  executeTool,
  resetMcpSessions,
  toolDefinitions,
} from "../src";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  resetMcpSessions();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  resetMcpSessions();
});

async function context(
  overrides: Partial<ToolContext> = {},
): Promise<ToolContext> {
  const root = await mkdtemp(path.join(tmpdir(), "kit-declarative-"));
  roots.push(root);
  return {
    repoRoot: root,
    sandboxRoot: root,
    runId: "run_test",
    workspaceId: "default",
    runMode: "LIVE",
    allowNetwork: false,
    allowLocalhost: true,
    ...overrides,
  };
}

function httpSpec(overrides: Record<string, unknown> = {}) {
  return packToolSchema.parse({
    name: "weather_lookup",
    description: "Look up weather",
    risk: "network",
    adapter: "http",
    endpoint: "http://localhost:9999/weather",
    method: "GET",
    permissions: { network: true },
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    ...overrides,
  });
}

function commandSpec() {
  const script =
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify({received:JSON.parse(d),secret:process.env.KIT_TEST_SECRET??null})))";
  return packToolSchema.parse({
    name: "run_node",
    description: "Run a node script",
    risk: "execute",
    adapter: "command",
    command: [process.execPath, "-e", script],
    permissions: { filesystem: "sandbox" },
  });
}

function mcpSpec(overrides: Record<string, unknown> = {}) {
  return packToolSchema.parse({
    name: "mcp_echo",
    description: "Call an MCP tool",
    risk: "network",
    adapter: "mcp",
    endpoint: "http://localhost:9999/mcp",
    toolName: "echo",
    permissions: { network: true },
    ...overrides,
  });
}

describe("declarative http tools", () => {
  it("is listed by toolDefinitions and executes with GET query args", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ temperature: 21 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const tools = createDeclarativeTools([httpSpec()]);
    expect(toolDefinitions(["weather_lookup"], tools)).toHaveLength(1);

    const result = await executeTool(
      "weather_lookup",
      { city: "Paris" },
      await context(),
      tools,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("HTTP 200");
    expect(calls[0]?.url).toContain("city=Paris");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("sends args as a JSON body for POST", async () => {
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      calls.push(init);
      return new Response("ok", { status: 201 });
    });

    const tools = createDeclarativeTools([httpSpec({ method: "POST" })]);
    await executeTool(
      "weather_lookup",
      { city: "Paris" },
      await context(),
      tools,
    );

    expect(calls[0]?.body).toBe(JSON.stringify({ city: "Paris" }));
  });

  it("blocks external endpoints when network access is disabled", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch should not run");
    });

    const tools = createDeclarativeTools([
      httpSpec({ endpoint: "https://api.example.com/weather" }),
    ]);

    await expect(
      executeTool(
        "weather_lookup",
        { city: "Paris" },
        await context({ allowNetwork: false }),
        tools,
      ),
    ).rejects.toThrow(/external network access is disabled/);
  });
});

describe("declarative mcp tools", () => {
  function mcpFetch(toolResponse: (body: Record<string, unknown>) => Response) {
    const calls: Array<{ method?: string; session: string | null }> = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      calls.push({
        method: body.method as string | undefined,
        session: headers.get("mcp-session-id"),
      });
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-03-26", capabilities: {} },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-1",
            },
          },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      return toolResponse(body);
    });
    return calls;
  }

  it("initializes once and calls the remote tool with a session header", async () => {
    const calls = mcpFetch(
      (body) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "mcp-ok" }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const tools = createDeclarativeTools([mcpSpec()]);
    const ctx = await context();
    const first = await executeTool("mcp_echo", {}, ctx, tools);
    const second = await executeTool("mcp_echo", {}, ctx, tools);

    expect(first.content).toContain("mcp-ok");
    expect(second.content).toContain("mcp-ok");
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    expect(calls[2]?.session).toBe("sess-1");
  });

  it("parses SSE responses", async () => {
    mcpFetch((body) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "sse-ok" }] },
      });
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const tools = createDeclarativeTools([mcpSpec()]);
    const result = await executeTool("mcp_echo", {}, await context(), tools);
    expect(result.content).toContain("sse-ok");
  });

  it("surfaces JSON-RPC errors", async () => {
    mcpFetch(
      (body) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "no such tool" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const tools = createDeclarativeTools([mcpSpec()]);
    await expect(
      executeTool("mcp_echo", {}, await context(), tools),
    ).rejects.toThrow(/MCP error -32601: no such tool/);
  });
});

describe("declarative command tools", () => {
  it("stays disabled without explicit consent", async () => {
    const tools = createDeclarativeTools([commandSpec()]);
    expect(tools).toHaveLength(0);
    await expect(executeTool("run_node", {}, await context())).rejects.toThrow(
      /unknown tool/,
    );
  });

  it("refuses to run outside LIVE mode", async () => {
    const tools = createDeclarativeTools([commandSpec()], {
      allowCommand: true,
    });
    await expect(
      executeTool("run_node", {}, await context({ runMode: "DRY_RUN" }), tools),
    ).rejects.toThrow(/only available in LIVE mode/);
  });

  it("runs in the sandbox with a sanitized environment", async () => {
    const previous = process.env.KIT_TEST_SECRET;
    process.env.KIT_TEST_SECRET = "leak-me";
    try {
      const tools = createDeclarativeTools([commandSpec()], {
        allowCommand: true,
      });
      const result = await executeTool(
        "run_node",
        { value: 42 },
        await context(),
        tools,
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain('"received":{"value":42}');
      expect(result.content).toContain('"secret":null');
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "KIT_TEST_SECRET");
      } else {
        process.env.KIT_TEST_SECRET = previous;
      }
    }
  });
});

describe("tool lookup", () => {
  it("prefers builtin tools over colliding declarative tools", () => {
    const shadow: Tool = {
      definition: {
        name: "repo_read",
        description: "shadow",
        parameters: {},
        risk: "read",
      },
      async execute() {
        return { content: "shadow" };
      },
    };

    const definitions = toolDefinitions(["repo_read"], [shadow]);
    expect(definitions[0]?.description).not.toBe("shadow");
  });
});
