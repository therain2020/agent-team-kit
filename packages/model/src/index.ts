import { loadApiKey, loadModelDefaults } from "@kit/bootstrap";
import { type PriorityClass, type Quota, loadQuotaPolicies } from "@kit/core";
import {
  type PriceTable,
  type ResolvedModelPrice,
  computeCostMicro,
  loadPriceTable,
  resolveModelPrice,
} from "./prices";
import {
  ModelHttpError,
  QuotaTracker,
  type ResilientGatewayOptions,
  estimateTokens,
  loadRetryPolicy,
  parseRetryAfterMs,
  runWithResilience,
} from "./resilience";

export * from "./cost-tracking";
export * from "./prices";
export * from "./resilience";

export interface ModelRequest {
  model: string;
  instructions: string;
  input: string;
  /** Quota scope (60 §2); defaults to `default` for single-workspace deployments. */
  workspaceId?: string;
  priority?: PriorityClass;
}

/** Pricing metadata stamped by the gateway from the versioned price table. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costCny?: number;
  costCnyMicro?: number;
  /** Resolved provider model id (alias expanded by config). */
  modelId?: string;
  provider?: string;
  /** CNY per 1,000 tokens; 0 when untracked. */
  unitPriceIn?: number;
  unitPriceOut?: number;
  priceVersion?: string;
  /** False when the price is unknown; `untrackedReason` explains why. */
  tracked?: boolean;
  untrackedReason?: string;
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
  workspaceId?: string;
  priority?: PriorityClass;
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
  /** Versioned price table used to cost calls and estimates. */
  priceTable: PriceTable;
}

/**
 * Cost estimate for budget admission. Returns 0 for an unpriced model (there
 * is nothing to reserve against); actual calls are recorded as `untracked`
 * rather than silently charged at zero.
 */
export function calculateCostCny(
  modelAlias: string,
  inputTokens: number,
  outputTokens: number,
  table: PriceTable = loadPriceTable(),
  at: Date = new Date(),
): number {
  const price = resolveModelPrice(table, modelAlias, at);
  const micro = computeCostMicro(price, inputTokens, outputTokens);
  return Math.round(micro) / 1_000_000;
}

export function priceUsage(
  usage: { inputTokens: number; outputTokens: number },
  modelAlias: string,
  resolvedModel: string,
  table: PriceTable,
  at: Date = new Date(),
): ModelUsage {
  // Price by alias first (the priced identity), then by the resolved provider
  // model, mirroring the pre-versioning lookup order.
  let price: ResolvedModelPrice = resolveModelPrice(table, modelAlias, at);
  if (!price.tracked && resolvedModel !== modelAlias) {
    price = resolveModelPrice(table, resolvedModel, at);
  }
  const costCnyMicro = computeCostMicro(
    price,
    usage.inputTokens,
    usage.outputTokens,
  );
  const modelId = price.tracked ? price.modelId : resolvedModel;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costCny: costCnyMicro / 1_000_000,
    costCnyMicro,
    modelId,
    provider: price.provider,
    unitPriceIn: price.inputPer1k,
    unitPriceOut: price.outputPer1k,
    priceVersion: price.priceVersion,
    tracked: price.tracked,
    ...(price.untrackedReason
      ? { untrackedReason: price.untrackedReason }
      : {}),
  };
}

export function loadModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig {
  // Injected env objects stay hermetic; only the real process falls back to
  // the bootstrap profile and key stored by `kit bootstrap`.
  const useBootstrap = env === process.env;
  const defaults = useBootstrap ? loadModelDefaults(env) : {};
  const apiKey =
    env.DEEPSEEK_API_KEY ?? (useBootstrap ? loadApiKey(env) : undefined);

  return {
    mode: env.KIT_MODEL_MODE === "live" || apiKey ? "live" : "stub",
    baseUrl:
      env.DEEPSEEK_BASE_URL ?? defaults.baseUrl ?? "https://api.deepseek.com",
    apiKey,
    aliases: {
      "deepseek-flash":
        env.DEEPSEEK_MODEL_FLASH ?? defaults.flash ?? "deepseek-flash",
      "deepseek-pro":
        env.DEEPSEEK_MODEL_PRO ?? defaults.pro ?? "deepseek-v4-pro",
    },
    priceTable: loadPriceTable(env),
  };
}

/** Stub calls cost nothing and are never counted as spend. */
function stubUsage(model: string): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costCny: 0,
    costCnyMicro: 0,
    modelId: model,
    provider: "stub",
    unitPriceIn: 0,
    unitPriceOut: 0,
    priceVersion: "stub@1",
    tracked: false,
    untrackedReason: "stub gateway: no provider call",
  };
}

export class StubModelGateway implements ModelGateway {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      text: `[stub:${request.model}] ${request.input.slice(0, 120)}`,
      usage: stubUsage(request.model),
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
      usage: stubUsage(request.model),
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
      throw new Error(
        "model API key is required: run `kit bootstrap --key <key>` or set DEEPSEEK_API_KEY",
      );
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
      throw new ModelHttpError(
        response.status,
        `model request failed: ${response.status} ${detail}`,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;

    return {
      text: payload.choices?.[0]?.message?.content ?? "",
      usage: priceUsage(
        { inputTokens, outputTokens },
        request.model,
        model,
        this.config.priceTable,
      ),
    };
  }

  async completeWithTools(
    request: ToolCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ToolCompletionResponse> {
    if (!this.config.apiKey) {
      throw new Error(
        "model API key is required: run `kit bootstrap --key <key>` or set DEEPSEEK_API_KEY",
      );
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
      throw new ModelHttpError(
        response.status,
        `model request failed: ${response.status} ${detail}`,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
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

    return {
      text,
      toolCalls,
      message: {
        role: "assistant",
        ...(text ? { content: text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: priceUsage(
        { inputTokens, outputTokens },
        request.model,
        model,
        this.config.priceTable,
      ),
    };
  }
}

export interface CreateModelGatewayOptions extends ResilientGatewayOptions {
  /**
   * Retry/backoff and quota enforcement around a live gateway. Defaults on;
   * set false for a raw client (tests, one-off probes).
   */
  resilient?: boolean;
}

/** Provider label used in quota keys. */
export function providerOf(config: ModelConfig): string {
  if (/deepseek/i.test(config.baseUrl)) {
    return "deepseek";
  }
  try {
    return new URL(config.baseUrl).host || "openai-compatible";
  } catch {
    return "openai-compatible";
  }
}

/**
 * Wraps a live gateway with 429 backoff + quota admission (60 §3.4). Stub mode
 * stays untouched so tests and dry runs never sleep.
 */
export class ResilientModelGateway implements ModelGateway {
  private readonly tracker: QuotaTracker | null;
  private readonly quotas: readonly Quota[];

  constructor(
    private readonly inner: ModelGateway,
    private readonly provider: string,
    private readonly options: ResilientGatewayOptions = {},
    tracker?: QuotaTracker,
  ) {
    this.quotas = options.quotas ?? [];
    this.tracker =
      tracker ??
      options.tracker ??
      (this.quotas.length > 0
        ? new QuotaTracker(this.quotas, options.now)
        : null);
  }

  complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    return runWithResilience(
      () => this.inner.complete(request, signal),
      {
        request: this.quotaRequest(request.workspaceId, request.model),
        tokens: estimateTokens(`${request.instructions}\n${request.input}`),
        ...(request.priority ? { priority: request.priority } : {}),
        ...(signal ? { signal } : {}),
      },
      this.effectiveOptions(),
    );
  }

  completeWithTools(
    request: ToolCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ToolCompletionResponse> {
    const text = request.messages
      .map((message) =>
        "content" in message && typeof message.content === "string"
          ? message.content
          : "",
      )
      .join("\n");
    return runWithResilience(
      () => this.inner.completeWithTools(request, signal),
      {
        request: this.quotaRequest(request.workspaceId, request.model),
        tokens: estimateTokens(text),
        ...(request.priority ? { priority: request.priority } : {}),
        ...(signal ? { signal } : {}),
      },
      this.effectiveOptions(),
    );
  }

  quickQuotaUsage(workspaceId = "default", model = "deepseek-flash") {
    return this.tracker?.usage(this.quotaRequest(workspaceId, model)) ?? null;
  }

  private effectiveOptions(): ResilientGatewayOptions {
    return {
      ...this.options,
      retry: this.options.retry ?? loadRetryPolicy(),
      quotas: this.quotas,
      ...(this.tracker ? { tracker: this.tracker } : {}),
    };
  }

  private quotaRequest(workspaceId: string | undefined, model: string) {
    return {
      workspaceId: workspaceId ?? "default",
      provider: this.provider,
      model,
    };
  }
}

export function createModelGateway(
  config: ModelConfig = loadModelConfig(),
  options: CreateModelGatewayOptions = {},
): ModelGateway {
  if (config.mode !== "live") {
    return new StubModelGateway();
  }
  const inner = new OpenAiCompatibleGateway(config);
  if (options.resilient === false) {
    return inner;
  }
  return new ResilientModelGateway(inner, providerOf(config), {
    retry: options.retry ?? loadRetryPolicy(),
    quotas: options.quotas ?? loadQuotaPolicies(),
    ...(options.tracker ? { tracker: options.tracker } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.quotaPollMs !== undefined
      ? { quotaPollMs: options.quotaPollMs }
      : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
  });
}
