const PROTOCOL_VERSION = "2025-03-26";
const MAX_CONTENT_CHARS = 40_000;
const CLIENT_INFO = { name: "agent-team-kit", version: "0.9.0" };

interface McpSession {
  headers: Record<string, string>;
}

interface JsonRpcMessage {
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface McpToolCall {
  endpoint: string;
  toolName: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs: number;
}

const sessions = new Map<string, Promise<McpSession>>();
let requestId = 0;

export function resetMcpSessions(): void {
  sessions.clear();
}

export async function callMcpTool(
  call: McpToolCall,
): Promise<{ content: string; isError: boolean }> {
  const session = await getSession(call);
  const id = nextId();
  const message = await postJsonRpc(
    call.endpoint,
    session.headers,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: call.toolName, arguments: call.args },
    },
    call.timeoutMs,
    id,
  );
  if (message.error) {
    throw new Error(
      `MCP error ${message.error.code ?? "unknown"}: ${message.error.message ?? "no message"}`,
    );
  }

  const result = asRecord(message.result);
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const record = asRecord(part);
        return typeof record?.text === "string"
          ? record.text
          : JSON.stringify(part);
      })
      .join("\n");
    return {
      content: truncate(text, MAX_CONTENT_CHARS),
      isError: result?.isError === true,
    };
  }

  return {
    content: truncate(
      JSON.stringify(message.result ?? null),
      MAX_CONTENT_CHARS,
    ),
    isError: result?.isError === true,
  };
}

async function getSession(call: McpToolCall): Promise<McpSession> {
  const existing = sessions.get(call.endpoint);
  if (existing) {
    return existing;
  }
  const created = initializeSession(call);
  sessions.set(call.endpoint, created);
  try {
    return await created;
  } catch (error) {
    sessions.delete(call.endpoint);
    throw error;
  }
}

async function initializeSession(call: McpToolCall): Promise<McpSession> {
  const id = nextId();
  const response = await postRaw(
    call.endpoint,
    call.headers ?? {},
    {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
    call.timeoutMs,
  );
  const message = await readMessage(response, id);
  if (message.error) {
    throw new Error(
      `MCP initialize failed: ${message.error.message ?? "unknown error"}`,
    );
  }

  const sessionId = response.headers.get("mcp-session-id");
  const headers: Record<string, string> = { ...(call.headers ?? {}) };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  await postRaw(
    call.endpoint,
    headers,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    call.timeoutMs,
    true,
  );

  return { headers };
}

async function postJsonRpc(
  endpoint: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  id: number | string,
): Promise<JsonRpcMessage> {
  const response = await postRaw(endpoint, headers, body, timeoutMs);
  return readMessage(response, id);
}

async function postRaw(
  endpoint: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
  notification = false,
): Promise<Response> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      `MCP endpoint returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  if (notification) {
    await response.text();
  }
  return response;
}

async function readMessage(
  response: Response,
  id: number | string,
): Promise<JsonRpcMessage> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const messages = parseSse(await response.text());
    const match =
      messages.find((message) => message.id === id) ??
      messages.find(
        (message) =>
          message.result !== undefined || message.error !== undefined,
      );
    if (!match) {
      throw new Error("MCP endpoint returned no JSON-RPC response");
    }
    return match;
  }

  const payload = (await response.json()) as unknown;
  const record = asRecord(payload);
  if (!record) {
    throw new Error("MCP endpoint returned an invalid JSON-RPC response");
  }
  return record as JsonRpcMessage;
}

function parseSse(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  let data: string[] = [];

  const flush = () => {
    if (data.length === 0) {
      return;
    }
    const payload = data.join("\n");
    data = [];
    if (payload === "[DONE]") {
      return;
    }
    try {
      const parsed = asRecord(JSON.parse(payload));
      if (parsed) {
        messages.push(parsed as JsonRpcMessage);
      }
    } catch {
      // SSE streams may include non-JSON keepalive events.
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();

  return messages;
}

function nextId(): number {
  requestId += 1;
  return requestId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}
