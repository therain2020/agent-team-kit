import { normalizeCursor } from "./commands/watch";

/**
 * `kit agent watch`: consume the console's world SSE stream headlessly.
 *
 * The console draws the office from `/api/world/stream`, which drains
 * `activity_events` after a cursor before going live. The agent CLI streams the
 * same endpoint instead of polling a second way, so both readers observe the
 * same deltas and the same `seq` semantics (plan 91 §3.6, plan 97 §3.2).
 *
 * Resumability: every frame carries the activity `seq` it was built from. We
 * reconnect with `after=<last seq>` (and `Last-Event-ID`), so a dropped socket
 * never loses or duplicates events. Ctrl-C aborts the fetch and exits cleanly;
 * an idle stream blocks on the socket read — it never busy-loops.
 */

export const DEFAULT_WORLD_STREAM_PATH = "/api/world/stream";

export interface AgentWatchOptions {
  /** Web console origin, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** Exclusive activity cursor to resume after. */
  after?: number;
  /** SSE path; defaults to `/api/world/stream`. */
  path?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onDelta: (delta: unknown, cursor: number) => void | Promise<void>;
  shouldStop?: () => boolean;
  /** Stop after this many frames (used by `--once` and tests). */
  maxEvents?: number;
  /** Reconnect attempts before giving up; `-1`/omitted retries forever. */
  maxReconnects?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AgentWatchResult {
  /** Highest activity cursor applied; feed it back as the next `--after`. */
  cursor: number;
  events: number;
}

export async function streamWorldDeltas(
  options: AgentWatchOptions,
): Promise<AgentWatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = options.path ?? DEFAULT_WORLD_STREAM_PATH;
  const sleep = options.sleep ?? delay;
  const baseMs = options.reconnectBaseMs ?? 1000;
  const maxMs = options.reconnectMaxMs ?? 30_000;

  let cursor = normalizeCursor(options.after);
  let events = 0;
  let failures = 0;

  for (;;) {
    if (isStopped(options)) {
      return { cursor, events };
    }

    let url: URL;
    try {
      url = new URL(path, options.baseUrl);
    } catch (error) {
      throw new Error(
        `invalid watch base URL "${options.baseUrl}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    url.searchParams.set("after", String(cursor));

    let stopped = false;
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "text/event-stream",
          "last-event-id": String(cursor),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `world stream responded ${response.status} ${response.statusText}`.trim(),
        );
      }
      failures = 0;
      stopped = await consumeFrames(response.body, async (data, id) => {
        const seq = frameSeq(data, id);
        if (seq !== null) {
          cursor = Math.max(cursor, seq);
        }
        events += 1;
        await options.onDelta(data, cursor);
        return reachedLimit(options, events);
      });
    } catch (error) {
      if (isStopped(options) || isAbortError(error)) {
        return { cursor, events };
      }
      failures += 1;
      if (
        options.maxReconnects !== undefined &&
        options.maxReconnects >= 0 &&
        failures > options.maxReconnects
      ) {
        throw error;
      }
    }

    if (stopped || isStopped(options)) {
      return { cursor, events };
    }
    // EOF or a transport error: reconnect from the same cursor. Backoff caps
    // so a long outage does not spin, and resets on the next good frame.
    await sleep(reconnectDelay(failures, baseMs, maxMs));
  }
}

function reachedLimit(options: AgentWatchOptions, events: number): boolean {
  if (options.maxEvents !== undefined && events >= options.maxEvents) {
    return true;
  }
  return isStopped(options);
}

function isStopped(options: AgentWatchOptions): boolean {
  return options.signal?.aborted === true || options.shouldStop?.() === true;
}

export function reconnectDelay(
  failures: number,
  baseMs = 1000,
  maxMs = 30_000,
): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/** Reads one SSE body until EOF, an abort, or `onData` asks to stop. */
async function consumeFrames(
  body: ReadableStream<Uint8Array>,
  onData: (data: unknown, lastEventId: string | undefined) => Promise<boolean>,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let lastEventId: string | undefined;
  let stopped = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

        if (line === "") {
          if (dataLines.length > 0) {
            const payload = dataLines.join("\n");
            const id = lastEventId;
            dataLines = [];
            lastEventId = undefined;
            if (await onData(parseData(payload), id)) {
              stopped = true;
              break;
            }
          }
          newline = buffer.indexOf("\n");
          continue;
        }

        // Comment / heartbeat (`: ping`).
        if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) {
            value = value.slice(1);
          }
          if (field === "data") {
            dataLines.push(value);
          } else if (field === "id") {
            lastEventId = value;
          }
        }
        newline = buffer.indexOf("\n");
      }

      if (stopped) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return stopped;
}

function parseData(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

/** The activity cursor for a frame: the delta `seq`, else the SSE `id`. */
function frameSeq(
  data: unknown,
  lastEventId: string | undefined,
): number | null {
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { seq?: unknown }).seq === "number" &&
    Number.isFinite((data as { seq: number }).seq)
  ) {
    return Math.trunc((data as { seq: number }).seq);
  }
  if (lastEventId !== undefined) {
    const parsed = Number(lastEventId);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
