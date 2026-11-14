export interface ModelRequest {
  model: string;
  instructions: string;
  input: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costCny?: number;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string;
      toolCalls?: ModelToolCall[];
    }
  | { role: "tool"; toolCallId: string; name?: string; content: string };

export interface ToolCompletionRequest {
  model: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ToolCompletionResponse {
  text: string;
  toolCalls: ModelToolCall[];
  message: Extract<ModelMessage, { role: "assistant" }>;
  usage: ModelUsage;
}

export interface ModelGateway {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  completeWithTools(
    request: ToolCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ToolCompletionResponse>;
}

export type ModelMode = "stub" | "live";

export interface ModelConfig {
  mode: ModelMode;
  baseUrl: string;
  apiKey?: string;
  aliases: Record<string, string>;
}

const PRICES: Record<string, { input: number; output: number }> = {
  "deepseek-flash": { input: 0.001, output: 0.002 },
  "deepseek-pro": { input: 0.002, output: 0.008 },
};

export function calculateCostCny(
  modelAlias: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICES[modelAlias];
  if (!price) {
    return 0;
  }
  const cost =
    (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function loadModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig {
  return {
    mode:
      env.KIT_MODEL_MODE === "live" || env.DEEPSEEK_API_KEY ? "live" : "stub",
    baseUrl: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey: env.DEEPSEEK_API_KEY,
    aliases: {
      "deepseek-flash": env.DEEPSEEK_MODEL_FLASH ?? "deepseek-flash",
      "deepseek-pro": env.DEEPSEEK_MODEL_PRO ?? "deepseek-v4-pro",
    },
  };
}

export class StubModelGateway implements ModelGateway {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      text: `[stub:${request.model}] ${request.input.slice(0, 120)}`,
      usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
    };
  }

  async completeWithTools(
    request: ToolCompletionRequest,
  ): Promise<ToolCompletionResponse> {
    const last = [...request.messages]
      .reverse()
      .find((message) => message.role === "user");
    const text = `[stub:${request.model}] ${(last?.content ?? "").slice(0, 160)}`;
    return {
      text,
      toolCalls: [],
      message: { role: "assistant", content: text },
      usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
    };
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ToolChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content ?? null,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

export class OpenAiCompatibleGateway implements ModelGateway {
  constructor(private readonly config: ModelConfig) {}

  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (!this.config.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required for live model calls");
    }

    const model = this.config.aliases[request.model] ?? request.model;
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: request.instructions },
            { role: "user", content: request.input },
          ],
        }),
        signal,
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`model request failed: ${response.status} ${detail}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;
    const price = PRICES[request.model] ?? PRICES[model];
    const cost = price
      ? (inputTokens / 1000) * price.input +
        (outputTokens / 1000) * price.output
      : 0;

    return {
      text: payload.choices?.[0]?.message?.content ?? "",
      usage: {
        inputTokens,
        outputTokens,
        costCny: Math.round(cost * 1000000) / 1000000,
      },
    };
  }

  async completeWithTools(
    request: ToolCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ToolCompletionResponse> {
    if (!this.config.apiKey) {
      throw new Error("DEEPSEEK_API_KEY is required for live model calls");
    }
    const model = this.config.aliases[request.model] ?? request.model;
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: request.temperature ?? 0,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          messages: request.messages.map(serializeMessage),
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        signal,
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`model request failed: ${response.status} ${detail}`);
    }

    const payload = (await response.json()) as ToolChatCompletionResponse;
    const rawMessage = payload.choices?.[0]?.message;
    const toolCalls: ModelToolCall[] = (rawMessage?.tool_calls ?? []).flatMap(
      (call, index) => {
        const name = call.function?.name;
        if (!name) {
          return [];
        }
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.function?.arguments ?? "{}");
          if (typeof parsed === "object" && parsed !== null) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = { _parseError: "arguments were not valid JSON" };
        }
        return [{ id: call.id ?? `call_${index}`, name, arguments: args }];
      },
    );
    const text = rawMessage?.content ?? "";
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;
    const price = PRICES[request.model] ?? PRICES[model];
    const cost = price
      ? (inputTokens / 1000) * price.input +
        (outputTokens / 1000) * price.output
      : 0;

    return {
      text,
      toolCalls,
      message: {
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: {
        inputTokens,
        outputTokens,
        costCny: Math.round(cost * 1000000) / 1000000,
      },
    };
  }
}

export function createModelGateway(
  config: ModelConfig = loadModelConfig(),
): ModelGateway {
  return config.mode === "live"
    ? new OpenAiCompatibleGateway(config)
    : new StubModelGateway();
}
