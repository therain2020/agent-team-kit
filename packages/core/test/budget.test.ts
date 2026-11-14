import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGETS,
  cnyToMicro,
  is80Percent,
  loadBudgetPolicy,
  microToCny,
  runBudgetSpecSchema,
  utcDayKey,
  utcMonthKey,
  validateBudgetCascade,
} from "../src/budget";

describe("budget contracts", () => {
  it("uses UTC period keys", () => {
    const late = new Date("2026-11-15T23:59:59.000Z");
    expect(utcDayKey(late)).toBe("2026-11-15");
    expect(utcMonthKey(late)).toBe("2026-11");
    expect(utcDayKey(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12-01");
  });

  it("converts CNY to integer micro-CNY", () => {
    expect(cnyToMicro(5)).toBe(5_000_000);
    expect(cnyToMicro(0.000001)).toBe(1);
    expect(cnyToMicro(0.0000014)).toBe(1);
    expect(microToCny(4_500_000)).toBe(4.5);
  });

  it("detects the 80 percent threshold", () => {
    expect(is80Percent(3.99, 5)).toBe(false);
    expect(is80Percent(4, 5)).toBe(true);
    expect(is80Percent(10, null)).toBe(false);
    expect(is80Percent(10, 0)).toBe(false);
  });

  it("validates the budget cascade", () => {
    expect(
      validateBudgetCascade({
        workspace: { cny: 200 },
        month: { cny: 200 },
        day: { cny: 30 },
        run: { cny: 5 },
        stage: { cny: 5 },
      }),
    ).toEqual([]);

    expect(
      validateBudgetCascade({
        workspace: { cny: 200 },
        month: { cny: 300 },
      })[0],
    ).toContain("month CNY 300 exceeds workspace CNY 200");

    expect(
      validateBudgetCascade({
        day: { cny: 4 },
        run: { cny: 5 },
      })[0],
    ).toContain("run CNY 5 exceeds day CNY 4");

    expect(
      validateBudgetCascade({
        run: { tokens: 1000 },
        stage: { tokens: 2000 },
      })[0],
    ).toContain("stage tokens 2000 exceeds run tokens 1000");
  });

  it("loads D-38 defaults and environment overrides", () => {
    const defaults = loadBudgetPolicy({});
    expect(defaults.run.cny).toBe(DEFAULT_BUDGETS.runCny);
    expect(defaults.day.cny).toBe(DEFAULT_BUDGETS.dayCny);
    expect(defaults.month.cny).toBe(DEFAULT_BUDGETS.monthCny);
    expect(defaults.workspace.cny).toBe(DEFAULT_BUDGETS.monthCny);
    expect(defaults.run.tokens).toBeUndefined();

    const overridden = loadBudgetPolicy({
      KIT_BUDGET_RUN_CNY: "2",
      KIT_BUDGET_DAY_CNY: "10",
      KIT_BUDGET_MONTH_CNY: "50",
      KIT_BUDGET_WORKSPACE_CNY: "80",
      KIT_BUDGET_RUN_TOKENS: "12000",
    });
    expect(overridden.run).toEqual({ cny: 2, tokens: 12000 });
    expect(overridden.day.cny).toBe(10);
    expect(overridden.month.cny).toBe(50);
    expect(overridden.workspace.cny).toBe(80);
  });

  it("parses explicit per-stage and per-agent overrides", () => {
    const parsed = runBudgetSpecSchema.parse({
      run: { cny: 5 },
      stage: { cny: 2 },
      stages: { "stage-a": { cny: 1, tokens: 1000 } },
      agents: { researcher: { cny: 3 } },
    });
    expect(parsed.stages?.["stage-a"]).toEqual({ cny: 1, tokens: 1000 });
    expect(parsed.agents?.researcher).toEqual({ cny: 3 });
  });
});
