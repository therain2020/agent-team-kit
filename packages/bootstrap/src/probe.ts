export type ProbeErrorKind =
  | "auth"
  | "quota"
  | "bad_request"
  | "network"
  | "unknown";

export interface ModelProbeResult {
  ok: boolean;
  baseUrl: string;
  model: string;
  models?: string[];
  latencyMs: number;
  reply?: string;
  error?: { kind: ProbeErrorKind; message: string };
}

export interface ProbeModelInput {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

interface ChatProbeResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";

export async function probeModel(
  input: ProbeModelInput,
): Promise<ModelProbeResult> {
  const apiKey = input.apiKey.trim();
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = input.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 20_000;

  if (!apiKey) {
    return {
      ok: false,
      baseUrl,
      model,
      latencyMs: 0,
      error: { kind: "auth", message: "api key is empty" },
    };
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    const body = await response.text().catch(() => "");

    if (!response.ok) {
      return {
        ok: false,
        baseUrl,
        model,
        latencyMs,
        error: {
          kind: classifyStatus(response.status),
          message: redact(
            `probe failed: ${response.status} ${body.slice(0, 300)}`,
            apiKey,
          ),
        },
      };
    }

    let reply: string | undefined;
    try {
      const payload = JSON.parse(body) as ChatProbeResponse;
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (text) {
        reply = text.slice(0, 120);
      }
    } catch {
      // A 2xx with a non-JSON body still proves the endpoint is reachable.
    }

    const models = await listModels(baseUrl, apiKey);

    return {
      ok: true,
      baseUrl,
      model,
      latencyMs,
      ...(models.length > 0 ? { models } : {}),
      ...(reply ? { reply } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      baseUrl,
      model,
      latencyMs: Date.now() - startedAt,
      error: {
        kind: classifyError(message),
        message: redact(message, apiKey),
      },
    };
  }
}

async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as ModelsResponse;
    return (payload.data ?? []).flatMap((item) =>
      typeof item.id === "string" ? [item.id] : [],
    );
  } catch {
    return [];
  }
}

function classifyStatus(status: number): ProbeErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 402 || status === 429) {
    return "quota";
  }
  if (status === 400 || status === 404) {
    return "bad_request";
  }
  return "unknown";
}

function classifyError(message: string): ProbeErrorKind {
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|aborted|network/i.test(
    message,
  )
    ? "network"
    : "unknown";
}

function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("<redacted>") : text;
}
