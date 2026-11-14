import { eventEnvelopeSchema } from "@kit/core";
import type { EventStore } from "@kit/store";

export interface IngestResult {
  status: "inserted" | "duplicate";
  eventId: string;
  eventType: string;
}

export class EventIngestor {
  constructor(private readonly events: Pick<EventStore, "insert">) {}

  async handle(payload: Uint8Array): Promise<IngestResult> {
    const text = new TextDecoder().decode(payload);
    const event = eventEnvelopeSchema.parse(JSON.parse(text));
    const { inserted } = await this.events.insert(event);

    return {
      status: inserted ? "inserted" : "duplicate",
      eventId: event.eventId,
      eventType: event.type,
    };
  }
}
