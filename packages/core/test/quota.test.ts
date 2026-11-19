import { describe, expect, it } from "vitest";
import {
  PRIORITY_PROFILES,
  loadQuotaPolicies,
  normalizePriority,
  priorityClassFor,
  priorityRank,
  priorityWeight,
  quotaMatches,
  quotaSchema,
  quotaUtilization,
  resolveQuota,
} from "../src/quota";

describe("PriorityClass", () => {
  it("orders P0 above P3 and gives higher classes more weight", () => {
    expect(priorityRank("P0")).toBe(0);
    expect(priorityRank("P3")).toBe(3);
    expect(priorityWeight("P0")).toBeGreaterThan(priorityWeight("P1"));
    expect(priorityWeight("P1")).toBeGreaterThan(priorityWeight("P2"));
    expect(priorityWeight("P2")).toBeGreaterThan(priorityWeight("P3"));
    expect(PRIORITY_PROFILES.P0.preemptible).toBe(false);
    expect(PRIORITY_PROFILES.P3.preemptible).toBe(true);
  });

  it("links event priority to a class, with run mode as the fallback", () => {
    expect(priorityClassFor({ priority: "p1" })).toBe("P1");
    expect(priorityClassFor({ tier: "P0" })).toBe("P0");
    expect(priorityClassFor({ runMode: "DRY_RUN" })).toBe("P3");
    expect(priorityClassFor({ runMode: "SHADOW" })).toBe("P3");
    expect(priorityClassFor({ runMode: "LIVE" })).toBe("P2");
    expect(priorityClassFor({})).toBe("P2");
    expect(normalizePriority("nope")).toBeNull();
    expect(normalizePriority(42)).toBeNull();
  });
});

describe("Quota contract", () => {
  const wildcard = quotaSchema.parse({ workspaceId: "*", rpm: 100 });
  const quotas = [
    wildcard,
    quotaSchema.parse({ workspaceId: "alpha", rpm: 10 }),
    quotaSchema.parse({ workspaceId: "alpha", model: "deepseek-pro", rpm: 2 }),
  ];

  it("requires at least one limit", () => {
    expect(() => quotaSchema.parse({ workspaceId: "*" })).toThrow();
  });

  it("matches wildcards and resolves the most specific policy", () => {
    expect(
      quotaMatches(wildcard, {
        workspaceId: "alpha",
        provider: "deepseek",
        model: "deepseek-flash",
      }),
    ).toBe(true);
    expect(
      resolveQuota(quotas, {
        workspaceId: "alpha",
        provider: "deepseek",
        model: "deepseek-flash",
      })?.rpm,
    ).toBe(10);
    expect(
      resolveQuota(quotas, {
        workspaceId: "alpha",
        provider: "deepseek",
        model: "deepseek-pro",
      })?.rpm,
    ).toBe(2);
    expect(
      resolveQuota(quotas, {
        workspaceId: "beta",
        provider: "deepseek",
        model: "deepseek-pro",
      })?.rpm,
    ).toBe(100);
    expect(
      resolveQuota([], { workspaceId: "a", provider: "b", model: "c" }),
    ).toBeNull();
  });

  it("loads operator defaults from env and can be disabled", () => {
    const policies = loadQuotaPolicies({});
    expect(policies).toHaveLength(1);
    expect(policies[0]?.rpm).toBeGreaterThan(0);
    expect(
      loadQuotaPolicies({
        KIT_QUOTA_RPM: "7",
        KIT_QUOTA_CONCURRENCY: "2",
        KIT_QUOTA_OVERFLOW: "reject",
      })[0],
    ).toMatchObject({ rpm: 7, concurrency: 2, overflow: "reject" });
    expect(loadQuotaPolicies({ KIT_QUOTA_ENABLED: "0" })).toEqual([]);
  });

  it("computes utilization ratios", () => {
    const quota = quotaSchema.parse({ rpm: 10, concurrency: 4 });
    expect(
      quotaUtilization({
        rpm: 5,
        tpm: 0,
        concurrency: 1,
        quota,
      }),
    ).toEqual({ rpm: 0.5, tpm: null, concurrency: 0.25 });
  });
});
