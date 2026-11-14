import type { EventEnvelope } from "@kit/core";
import { describe, expect, it, vi } from "vitest";
import { EventIngestor } from "../src/ingestor";

const event: EventEnvelope = {
  eventId: "evt_1",
  type: "demo.event.received",
  schemaVersion: "1.0",
  occurredAt: "2026-11-14T00:00:00.000Z",
  receivedAt: "2026-11-14T00:00:00.000Z",
  workspaceId: "default",
  idempotencyKey: "test:key",
  traceId: "trc_1",
  payloadRef: "memory://test",
};

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("event ingestor", () => {
  it("reports inserted events", async () => {
    const insert = vi.fn().mockResolvedValue({ inserted: true });
    const ingestor = new EventIngestor({ insert });

    const result = await ingestor.handle(encode(event));

    expect(result.status).toBe("inserted");
    expect(result.eventId).toBe("evt_1");
    expect(insert).toHaveBeenCalledWith(event);
  });

  it("reports duplicates", async () => {
    const insert = vi.fn().mockResolvedValue({ inserted: false });
    const ingestor = new EventIngestor({ insert });

    const result = await ingestor.handle(encode(event));

    expect(result.status).toBe("duplicate");
  });

  it("rejects invalid payloads", async () => {
    const insert = vi.fn();
    const ingestor = new EventIngestor({ insert });

    await expect(
      ingestor.handle(new TextEncoder().encode("not-json")),
    ).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
