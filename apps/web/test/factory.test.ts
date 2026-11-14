import { describe, expect, it } from "vitest";
import {
  type FactoryItem,
  lowRiskItems,
  needsConfirmation,
  orderGateItems,
} from "../lib/factory";

function item(risk: FactoryItem["riskClass"], id: string): FactoryItem {
  return {
    kind: "approval",
    requestId: id,
    runId: `run-${id}`,
    riskClass: risk,
    summary: id,
    costCny: 0,
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
}

describe("factory lanes", () => {
  it("orders high risk first and ignores failed runs", () => {
    const ordered = orderGateItems([
      item("low", "low"),
      { ...item("high", "failed"), kind: "failed" },
      item("high", "high"),
      item("medium", "medium"),
    ]);
    expect(ordered.map((entry) => entry.requestId)).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("batches only low-risk approvals", () => {
    const low = lowRiskItems([
      item("low", "a"),
      item("medium", "b"),
      { ...item("low", "failed"), kind: "failed" },
    ]);
    expect(low.map((entry) => entry.requestId)).toEqual(["a"]);
  });

  it("requires confirmation above low risk", () => {
    expect(needsConfirmation(item("low", "a"))).toBe(false);
    expect(needsConfirmation(item("medium", "a"))).toBe(true);
    expect(needsConfirmation(item("high", "a"))).toBe(true);
  });
});
