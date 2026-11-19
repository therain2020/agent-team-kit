import { quotaSchema } from "@kit/core";
import { describe, expect, it } from "vitest";
import {
  parsePriority,
  quotaPressure,
  summarizeCapacity,
  toCapacityRow,
  toQuotaView,
} from "../lib/capacity-math";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  return toCapacityRow({
    request_id: "rrq_1",
    workspace_id: "alpha",
    status: "queued",
    created_at: new Date(NOW - 2_000).toISOString(),
    claimed_at: null,
    payload: JSON.stringify({ runMode: "LIVE" }),
    ...overrides,
  });
}

describe("capacity read model", () => {
  it("derives priority from payload, falling back to run mode", () => {
    expect(parsePriority(JSON.stringify({ priority: "P1" }))).toBe("P1");
    expect(parsePriority(JSON.stringify({ tier: "P0" }))).toBe("P0");
    expect(parsePriority(JSON.stringify({ runMode: "DRY_RUN" }))).toBe("P3");
    expect(parsePriority("not json")).toBe("P2");
  });

  it("summarizes depth, wait p95 and priority distribution", () => {
    const rows = [
      row({ request_id: "r1", status: "queued", payload: '{"priority":"P1"}' }),
      row({
        request_id: "r2",
        status: "claimed",
        claimed_at: new Date(NOW - 1_000).toISOString(),
        payload: '{"priority":"P0"}',
      }),
      row({
        request_id: "r3",
        workspace_id: "beta",
        status: "done",
        claimed_at: new Date(NOW - 500).toISOString(),
      }),
    ];
    const summary = summarizeCapacity(rows, NOW);
    expect(summary.queueDepth).toBe(1);
    expect(summary.inFlight).toBe(1);
    expect(summary.byPriority).toEqual({ P0: 1, P1: 1, P2: 0, P3: 0 });
    expect(summary.byWorkspace.alpha).toMatchObject({ queued: 1, inFlight: 1 });
    expect(summary.byWorkspace.beta).toMatchObject({ queued: 0, inFlight: 0 });
    expect(summary.waitP95Ms).toBeGreaterThan(0);
    expect(summary.maxWaitMs).toBeGreaterThanOrEqual(summary.waitP95Ms);
  });

  it("shows quota configuration and pressure", () => {
    const summary = summarizeCapacity(
      [
        row({ request_id: "r1" }),
        row({ request_id: "r2" }),
        row({ request_id: "r3" }),
      ],
      NOW,
    );
    const quota = quotaSchema.parse({ workspaceId: "alpha", rpm: 6 });
    const view = toQuotaView(quota, summary);
    expect(view).toMatchObject({
      workspaceId: "alpha",
      rpm: 6,
      usage: { rpm: 3 },
    });
    expect(quotaPressure(view, summary)).toBeCloseTo(0.5, 5);
  });

  it("counts recent enqueues as rpm and ignores old rows", () => {
    const rows = [
      row({ request_id: "recent" }),
      row({
        request_id: "old",
        created_at: new Date(NOW - 120_000).toISOString(),
      }),
    ];
    const summary = summarizeCapacity(rows, NOW);
    expect(summary.byWorkspace.alpha?.rpm).toBe(1);
  });
});
