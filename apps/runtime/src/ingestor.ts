import { type EventEnvelope, eventEnvelopeSchema } from "@kit/core";
import type { EventStore } from "@kit/store";

export interface IngestResult {
  status: "inserted" | "duplicate";
  eventId: string;
  eventType: string;
  event: EventEnvelope;
  payload?: unknown;
}

export interface ParsedQueueMessage {
  event: EventEnvelope;
  payload?: unknown;
}

export class EventIngestor {
  constructor(private readonly events: Pick<EventStore, "insert">) {}

  async handle(payload: Uint8Array): Promise<IngestResult> {
    const parsed = parseQueueMessage(payload);
    const { inserted } = await this.events.insert(parsed.event);

    return {
      status: inserted ? "inserted" : "duplicate",
      eventId: parsed.event.eventId,
      eventType: parsed.event.type,
      event: parsed.event,
      ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
    };
  }
}

export function parseQueueMessage(payload: Uint8Array): ParsedQueueMessage {
  const text = new TextDecoder().decode(payload);
  const parsed = JSON.parse(text) as unknown;

  if (
    parsed &&
    typeof parsed === "object" &&
    "event" in parsed &&
    (parsed as { event?: unknown }).event !== undefined
  ) {
    const wrapper = parsed as { event: unknown; payload?: unknown };
    return {
      event: eventEnvelopeSchema.parse(wrapper.event),
      ...(wrapper.payload !== undefined ? { payload: wrapper.payload } : {}),
    };
  }

  return { event: eventEnvelopeSchema.parse(parsed) };
}
