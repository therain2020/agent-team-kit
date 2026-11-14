import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from "node:http";
import { NatsEventQueue } from "@kit/queue";
import {
  type NormalizedEvent,
  normalizeGeneric,
  normalizeGithub,
  normalizeSentry,
} from "./normalize";
import { isFreshTimestamp, verifyHmac } from "./signature";

const port = Number(process.env.KIT_GATEWAY_PORT ?? 8787);
const host = process.env.KIT_GATEWAY_HOST ?? "127.0.0.1";
const workspaceId = process.env.KIT_WORKSPACE_ID ?? "default";
const subject = process.env.KIT_EVENT_SUBJECT ?? "kit.events.external";
const maxBodyBytes = 1 * 1024 * 1024;
const rateWindowMs = 60_000;
const rateLimit = 60;

const queue = new NatsEventQueue({
  url: process.env.KIT_NATS_URL ?? "nats://localhost:4222",
  stream: process.env.KIT_NATS_STREAM ?? "KIT_EVENTS",
  subjects: ["kit.events.>"],
});

await queue.connect();
console.log(`[gateway] connected to nats subject=${subject}`);

const hits = new Map<string, number[]>();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, service: "kit-gateway" });
      return;
    }

    if (request.method !== "POST") {
      json(response, 404, { error: "not found" });
      return;
    }

    const ip = ipOf(request);
    if (!allow(ip)) {
      json(response, 429, { error: "rate limit exceeded" });
      return;
    }

    if (request.url === "/ingest/generic") {
      await handleGeneric(request, response);
      return;
    }
    if (request.url === "/ingest/github") {
      await handleGithub(request, response);
      return;
    }
    if (request.url === "/ingest/sentry") {
      await handleSentry(request, response);
      return;
    }

    json(response, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[gateway] request failed: ${message}`);
    json(response, 400, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`[gateway] listening http://${host}:${port}`);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleGeneric(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const secret = process.env.KIT_EVENT_SECRET;
  if (!secret) {
    json(response, 503, { error: "KIT_EVENT_SECRET is not configured" });
    return;
  }
  const body = await readBody(request);
  const signature = request.headers["x-kit-signature"];
  if (
    !verifyHmac(secret, body, typeof signature === "string" ? signature : null)
  ) {
    json(response, 401, { error: "invalid signature" });
    return;
  }
  const timestamp = request.headers["x-kit-timestamp"];
  if (typeof timestamp === "string" && !isFreshTimestamp(timestamp)) {
    json(response, 401, { error: "stale timestamp" });
    return;
  }

  const input = JSON.parse(body) as Record<string, unknown>;
  const normalized = normalizeGeneric(input, { workspaceId });
  await accept(normalized, response);
}

async function handleGithub(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    json(response, 503, {
      error: "GITHUB_WEBHOOK_SECRET is not configured",
    });
    return;
  }
  const body = await readBody(request);
  const signature = request.headers["x-hub-signature-256"];
  if (
    !verifyHmac(secret, body, typeof signature === "string" ? signature : null)
  ) {
    json(response, 401, { error: "invalid signature" });
    return;
  }

  const eventName = header(request, "x-github-event") ?? "";
  const deliveryId = header(request, "x-github-delivery") ?? "";
  if (!eventName || !deliveryId) {
    json(response, 400, { error: "missing github event headers" });
    return;
  }

  const payload = JSON.parse(body) as Record<string, unknown>;
  const expectedRepo = process.env.KIT_GITHUB_REPO;
  if (expectedRepo) {
    const repository = payload.repository as
      | { full_name?: unknown }
      | undefined;
    if (repository?.full_name !== expectedRepo) {
      json(response, 403, { error: "repository is not allowlisted" });
      return;
    }
  }

  const normalized = normalizeGithub(eventName, deliveryId, payload, {
    workspaceId,
  });
  if (!normalized) {
    json(response, 202, {
      status: "ignored",
      reason: `unsupported github event: ${eventName}`,
    });
    return;
  }
  await accept(normalized, response);
}

async function handleSentry(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!secret) {
    json(response, 503, { error: "SENTRY_WEBHOOK_SECRET is not configured" });
    return;
  }
  const body = await readBody(request);
  const signature = header(request, "sentry-hook-signature");
  if (!verifyHmac(secret, body, signature)) {
    json(response, 401, { error: "invalid signature" });
    return;
  }
  const timestamp = header(request, "sentry-hook-timestamp");
  if (!isFreshTimestamp(timestamp)) {
    json(response, 401, { error: "stale timestamp" });
    return;
  }

  const payload = JSON.parse(body) as Record<string, unknown>;
  const resource = header(request, "sentry-hook-resource");
  const normalized = normalizeSentry(payload, { workspaceId, resource });
  if (!normalized) {
    const action =
      typeof payload.action === "string" ? payload.action : "unknown";
    json(response, 202, {
      status: "ignored",
      reason: `unsupported sentry event: ${resource ?? "unknown"}/${action}`,
    });
    return;
  }
  await accept(normalized, response);
}

async function accept(
  normalized: NormalizedEvent,
  response: ServerResponse,
): Promise<void> {
  const message = JSON.stringify({
    event: normalized.event,
    payload: normalized.payload,
  });
  await queue.publish(
    subject,
    new TextEncoder().encode(message),
    normalized.event.idempotencyKey,
  );
  console.log(
    `[gateway] accepted ${normalized.event.type} id=${normalized.event.eventId}`,
  );
  json(response, 202, {
    status: "accepted",
    eventId: normalized.event.eventId,
    type: normalized.event.type,
  });
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function ipOf(request: IncomingMessage): string {
  const forwarded = header(request, "x-forwarded-for");
  return (
    forwarded?.split(",")[0]?.trim() ?? request.socket.remoteAddress ?? "local"
  );
}

function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(
    (time) => now - time <= rateWindowMs,
  );
  if (recent.length >= rateLimit) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new Error(`body exceeds ${maxBodyBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function shutdown(): Promise<void> {
  server.close();
  await queue.close();
  process.exit(0);
}
