import { describe, expect, it } from "vitest";
import {
  eventBudgetSkip,
  eventPriorityOf,
  resolveEventBudget,
  startOfUtcDay,
  triggerMatches,
} from "../src/router";

describe("event priority linkage", () => {
  it("reads priority hints from a payload and ignores malformed input", () => {
    expect(eventPriorityOf({ priority: "P1" })).toBe("P1");
    expect(eventPriorityOf({ priorityClass: "P0" })).toBe("P0");
    expect(eventPriorityOf({ tier: "P2" })).toBe("P2");
    expect(eventPriorityOf({ other: 1 })).toBeUndefined();
    expect(eventPriorityOf("P0")).toBeUndefined();
    expect(eventPriorityOf(null)).toBeUndefined();
    expect(eventPriorityOf({ priority: "  " })).toBeUndefined();
  });
});

describe("trigger matching", () => {
  it("matches exact types", () => {
    expect(triggerMatches("github.issue.opened", "github.issue.opened")).toBe(
      true,
    );
    expect(triggerMatches("github.issue.opened", "github.issue.closed")).toBe(
      false,
    );
  });

  it("matches prefix wildcards", () => {
    expect(triggerMatches("github.*", "github.issue.opened")).toBe(true);
    expect(triggerMatches("github.*", "ci.failed")).toBe(false);
    expect(triggerMatches("ci.*", "ci.failed")).toBe(true);
  });

  it("matches the global wildcard", () => {
    expect(triggerMatches("*", "anything.happened")).toBe(true);
  });
});

describe("event budget", () => {
  it("prefers the declared budget and falls back to the environment", () => {
    expect(
      resolveEventBudget(
        { dailyRuns: 3 },
        {
          KIT_EVENT_DAILY_RUNS: "9",
          KIT_EVENT_DAILY_COST_CNY: "1.5",
        },
      ),
    ).toEqual({ dailyRuns: 3, dailyCostCny: 1.5 });
    expect(resolveEventBudget(undefined, {})).toBeUndefined();
    expect(
      resolveEventBudget(undefined, {
        KIT_EVENT_DAILY_RUNS: "0",
        KIT_EVENT_DAILY_COST_CNY: "nope",
      }),
    ).toBeUndefined();
  });

  it("skips when the run count or projected cost exceeds the budget", () => {
    expect(eventBudgetSkip({ dailyRuns: 2 }, { runs: 1, costCny: 0 }, 0)).toBe(
      null,
    );
    expect(
      eventBudgetSkip({ dailyRuns: 2 }, { runs: 2, costCny: 0 }, 0),
    ).toContain("daily run budget reached");
    expect(
      eventBudgetSkip({ dailyCostCny: 0.5 }, { runs: 0, costCny: 0.4 }, 0.2),
    ).toContain("daily cost budget would be exceeded");
    expect(
      eventBudgetSkip({ dailyCostCny: 0.5 }, { runs: 0, costCny: 0.4 }, 0.1),
    ).toBeNull();
    expect(
      eventBudgetSkip(undefined, { runs: 99, costCny: 99 }, 99),
    ).toBeNull();
  });

  it("anchors the counting window at UTC midnight", () => {
    const start = startOfUtcDay(new Date("2026-11-15T23:59:59.999Z"));
    expect(start.toISOString()).toBe("2026-11-15T00:00:00.000Z");
  });
});
