import { describe, expect, it } from "vitest";
import {
  aggregationWindowMs,
  dedupeKeyFor,
  isAckOverdue,
  parseOnCallPolicy,
  resolveAlertRouting,
} from "../src/index";

const NOON = new Date("2026-11-15T12:00:00Z");
const NIGHT = new Date("2026-11-15T23:30:00Z");

function nightPolicy() {
  return parseOnCallPolicy({
    nightMode: {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    },
  });
}

function daytimePolicy() {
  return parseOnCallPolicy({
    nightMode: { enabled: false },
    quietWindow: { start: "22:00", end: "07:00", timezone: "UTC" },
  });
}

describe("alert routing", () => {
  it("sends P0 over IM only during night mode", () => {
    const routing = resolveAlertRouting({
      tier: "P0",
      policy: nightPolicy(),
      now: NIGHT,
    });

    expect(routing.channels).toEqual(["im"]);
    expect(routing.suppressed).toBe(false);
  });

  it("suppresses P1-P3 during night mode", () => {
    for (const tier of ["P1", "P2", "P3"] as const) {
      const routing = resolveAlertRouting({
        tier,
        policy: nightPolicy(),
        now: NIGHT,
      });
      expect(routing.suppressed).toBe(true);
      expect(routing.reason).toBe("night_mode");
      expect(routing.channels).toEqual([]);
    }
  });

  it("lets P0 through a quiet window but suppresses P1", () => {
    const policy = daytimePolicy();
    const p0 = resolveAlertRouting({
      tier: "P0",
      policy,
      now: new Date("2026-11-15T23:30:00Z"),
    });
    const p1 = resolveAlertRouting({
      tier: "P1",
      policy,
      now: new Date("2026-11-15T23:30:00Z"),
    });

    expect(p0.suppressed).toBe(false);
    expect(p0.channels).toEqual(["im", "email"]);
    expect(p1.suppressed).toBe(true);
    expect(p1.reason).toBe("quiet_window");
  });

  it("suppresses P2/P3 when the monthly budget is exhausted", () => {
    const policy = parseOnCallPolicy({
      nightMode: { enabled: false },
      monthlyBudget: 10,
    });

    expect(
      resolveAlertRouting({
        tier: "P2",
        policy,
        now: NOON,
        monthlyCount: 10,
      }).reason,
    ).toBe("monthly_budget");
    expect(
      resolveAlertRouting({
        tier: "P1",
        policy,
        now: NOON,
        monthlyCount: 10,
      }).suppressed,
    ).toBe(false);
  });

  it("keeps P3 as a stored-only tier", () => {
    const routing = resolveAlertRouting({
      tier: "P3",
      policy: parseOnCallPolicy({ nightMode: { enabled: false } }),
      now: NOON,
    });

    expect(routing.suppressed).toBe(false);
    expect(routing.channels).toEqual([]);
  });

  it("derives stable dedupe keys and aggregation windows", () => {
    const policy = parseOnCallPolicy({});
    expect(aggregationWindowMs("P2", policy)).toBe(60 * 60_000);
    expect(aggregationWindowMs("P0", policy)).toBe(0);
    expect(
      dedupeKeyFor({ tier: "P1", kind: "run.failed", runId: "run_1" }),
    ).toBe("P1|run.failed|run_1||");
    expect(
      dedupeKeyFor({
        tier: "P1",
        kind: "run.failed",
        runId: "run_1",
        dedupeKey: " custom ",
      }),
    ).toBe("custom");
  });

  it("flags overdue acknowledgements against the tier SLA", () => {
    const policy = parseOnCallPolicy({});
    expect(
      isAckOverdue(
        {
          tier: "P1",
          status: "open",
          firstSeenAt: "2026-11-15T09:00:00Z",
        },
        policy,
        NOON,
      ),
    ).toBe(true);
    expect(
      isAckOverdue(
        {
          tier: "P1",
          status: "acknowledged",
          firstSeenAt: "2026-11-15T09:00:00Z",
        },
        policy,
        NOON,
      ),
    ).toBe(false);
  });
});
