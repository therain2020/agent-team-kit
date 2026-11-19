import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGETS,
  DEFAULT_EVOLUTION_BUDGET_SHARE,
  cnyToMicro,
  evolutionBudgetLimit,
  evolutionBudgetPurpose,
  is80Percent,
  isEvolutionBudgetPurpose,
  loadBudgetPolicy,
  loadEvolutionBudgetShare,
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

  it("sizes the evolution subject at 10% of the production month budget", () => {
    const defaults = loadBudgetPolicy({});
    expect(loadEvolutionBudgetShare({})).toBe(DEFAULT_EVOLUTION_BUDGET_SHARE);
    expect(DEFAULT_EVOLUTION_BUDGET_SHARE).toBe(0.1);
    expect(evolutionBudgetLimit(defaults.month, 0.1)).toEqual({
      cny: DEFAULT_BUDGETS.monthCny * 0.1,
    });

    const overridden = loadBudgetPolicy({
      KIT_BUDGET_MONTH_CNY: "50",
      KIT_BUDGET_MONTH_TOKENS: "10000",
    });
    expect(
      evolutionBudgetLimit(overridden.month, loadEvolutionBudgetShare({})),
    ).toEqual({ cny: 5, tokens: 1000 });

    expect(
      loadEvolutionBudgetShare({ KIT_EVOLUTION_BUDGET_SHARE: "0.05" }),
    ).toBe(0.05);
    // Out-of-range or garbage values fall back to D-38's 10%.
    expect(loadEvolutionBudgetShare({ KIT_EVOLUTION_BUDGET_SHARE: "2" })).toBe(
      0.1,
    );
    expect(
      loadEvolutionBudgetShare({ KIT_EVOLUTION_BUDGET_SHARE: "nope" }),
    ).toBe(0.1);
  });

  it("tags evolution reservations by phase", () => {
    expect(evolutionBudgetPurpose("score")).toBe("evolution:score");
    expect(isEvolutionBudgetPurpose("evolution:canary")).toBe(true);
    expect(isEvolutionBudgetPurpose("planning")).toBe(false);
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
