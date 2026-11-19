import { describe, expect, it } from "vitest";
import {
  buildInformationEvent,
  computeDedupeKey,
  informationEventSchema,
} from "../src/information";

const base = {
  workspaceId: "default",
  sourceId: "hn",
  captureKey: "capture-abc",
  itemRef: "hn:1",
  contentRef: "information-capture:capture-abc",
  fetchedAt: "2026-11-20T00:00:00.000Z",
  publishedAt: "2026-11-19T12:00:00.000Z",
  eventId: "inf_1",
  traceId: "trc_1",
};

describe("InformationEvent contract", () => {
  it("extends the canonical envelope with information fields", () => {
    const event = buildInformationEvent(base);

    expect(event.eventId).toBe("inf_1");
    expect(event.type).toBe("information.item");
    expect(event.schemaVersion).toBe("1.0");
    expect(event.sourceKind).toBe("passive");
    expect(event.sensitivity).toBe("internal");
    expect(event.itemRefs).toEqual(["hn:1"]);
    expect(event.provenance).toEqual([
      {
        captureKey: "capture-abc",
        sourceId: "hn",
        contentRef: "information-capture:capture-abc",
        fetchedAt: "2026-11-20T00:00:00.000Z",
      },
    ]);
  });

  it("uses publishedAt for occurredAt and derives identity keys", () => {
    const event = buildInformationEvent(base);

    expect(event.occurredAt).toBe("2026-11-19T12:00:00.000Z");
    expect(event.receivedAt).toBe(base.fetchedAt);
    expect(event.dedupeKey).toBe(computeDedupeKey("capture-abc"));
    expect(event.idempotencyKey).toBe(event.dedupeKey);
    expect(event.payloadRef).toBe(base.contentRef);
  });

  it("falls back to fetchedAt when publishedAt is missing", () => {
    const event = buildInformationEvent({ ...base, publishedAt: undefined });
    expect(event.occurredAt).toBe(base.fetchedAt);
  });

  it("drops claims and facts that carry no provenance", () => {
    const event = buildInformationEvent({
      ...base,
      claims: [
        { claimId: "c1", text: "no evidence", provenance: [] },
        {
          claimId: "c2",
          text: "with evidence",
          provenance: [
            {
              captureKey: "capture-abc",
              sourceId: "hn",
              contentRef: "ref",
              fetchedAt: base.fetchedAt,
            },
          ],
        },
      ],
      facts: [{ factId: "f1", text: "no evidence", provenance: [] }],
    });

    expect(event.claims.map((claim) => claim.claimId)).toEqual(["c2"]);
    expect(event.facts).toEqual([]);
  });

  it("rejects non-information event types and empty provenance", () => {
    expect(
      informationEventSchema.safeParse({
        ...buildInformationEvent(base),
        type: "run.created",
      }).success,
    ).toBe(false);

    expect(
      informationEventSchema.safeParse({
        eventId: "inf_1",
        type: "information.item",
        schemaVersion: "1.0",
        occurredAt: base.fetchedAt,
        receivedAt: base.fetchedAt,
        workspaceId: "default",
        idempotencyKey: "k",
        traceId: "t",
        payloadRef: "ref",
        sourceId: "hn",
        captureKey: "capture-abc",
        dedupeKey: "capture:capture-abc",
        itemRefs: ["hn:1"],
        provenance: [],
      }).success,
    ).toBe(false);
  });

  it("dedupes itemRefs while keeping the primary ref first", () => {
    const event = buildInformationEvent({
      ...base,
      itemRefs: ["hn:2", "hn:1"],
    });
    expect(event.itemRefs).toEqual(["hn:1", "hn:2"]);
  });
});
