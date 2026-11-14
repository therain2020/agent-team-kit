import { describe, expect, it } from "vitest";
import {
  defaultOnCallPolicy,
  mergeOnCallPolicy,
  parseOnCallPolicy,
  parseOnCallPolicyPatch,
} from "../src/index";

describe("on-call policy", () => {
  it("applies defaults for tiers and night mode", () => {
    const policy = parseOnCallPolicy({});

    expect(policy.channels.P0).toEqual(["im", "email"]);
    expect(policy.channels.P1).toEqual(["im"]);
    expect(policy.channels.P2).toEqual(["email"]);
    expect(policy.channels.P3).toEqual([]);
    expect(policy.nightMode.enabled).toBe(true);
    expect(policy.nightMode.start).toBe("22:00");
    expect(policy.nightMode.end).toBe("07:00");
    expect(policy.monthlyBudget).toBeNull();
  });

  it("merges partial patches and dedupes channels", () => {
    const policy = parseOnCallPolicy({
      channels: { P0: ["email", "im", "email"] },
      nightMode: { start: "21:30" },
      aggregationMinutes: { P2: 5 },
      monthlyBudget: 10,
    });

    expect(policy.channels.P0).toEqual(["im", "email"]);
    expect(policy.nightMode.start).toBe("21:30");
    expect(policy.nightMode.end).toBe("07:00");
    expect(policy.nightMode.enabled).toBe(true);
    expect(policy.aggregationMinutes.P2).toBe(5);
    expect(policy.aggregationMinutes.P1).toBe(10);
    expect(policy.monthlyBudget).toBe(10);
  });

  it("keeps an explicit null quiet window", () => {
    const base = defaultOnCallPolicy("UTC");
    const merged = mergeOnCallPolicy(
      {
        ...base,
        quietWindow: { start: "23:00", end: "07:00", timezone: "UTC" },
      },
      { quietWindow: null },
    );

    expect(merged.quietWindow).toBeNull();
  });

  it("rejects invalid times and budgets", () => {
    expect(() =>
      parseOnCallPolicy({ nightMode: { start: "25:00" } }),
    ).toThrow();
    expect(() => parseOnCallPolicyPatch({ monthlyBudget: 0 })).toThrow();
    expect(() =>
      parseOnCallPolicyPatch({ channels: { P0: ["pager"] } }),
    ).toThrow();
  });
});
