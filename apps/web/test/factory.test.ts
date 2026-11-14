import { describe, expect, it } from "vitest";
import {
  type FactoryItem,
  MAX_BATCH_SIZE,
  batchTargetsFor,
  lowRiskItems,
  needsConfirmation,
  orderGateItems,
  stationForApproval,
  stationsFor,
  validateBatchInput,
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

describe("factory stations", () => {
  it("maps approval request types to the station strip", () => {
    const stations = stationsFor([
      { ...item("low", "before"), requestType: "stage_before" },
      { ...item("low", "after"), requestType: "stage_after" },
      { ...item("high", "gate"), requestType: "gate_failure" },
      { ...item("high", "failed"), kind: "failed" },
    ]);
    expect(stations.map((station) => [station.id, station.count])).toEqual([
      ["demand", 0],
      ["build", 1],
      ["qa", 1],
      ["gatekeeper", 1],
      ["deliver", 0],
    ]);
    expect(stationForApproval("stage_before")).toBe("build");
    expect(stationForApproval("stage_after")).toBe("qa");
    expect(stationForApproval(undefined)).toBe("gatekeeper");
  });
});

describe("batch approvals", () => {
  it("caps targets at the batch limit and keeps only low risk", () => {
    const items = Array.from({ length: MAX_BATCH_SIZE + 5 }, (_, index) =>
      item("low", `low-${index}`),
    );
    items.push(item("medium", "medium"));

    const targets = batchTargetsFor(items);
    expect(targets).toHaveLength(MAX_BATCH_SIZE);
    expect(targets.every((target) => target.requestId.startsWith("low-"))).toBe(
      true,
    );
  });

  it("validates batch payloads before touching the approval API", () => {
    expect(validateBatchInput(null)).toEqual({ ok: false, error: "empty" });
    expect(validateBatchInput({ items: [] })).toEqual({
      ok: false,
      error: "empty",
    });
    expect(validateBatchInput({ items: [{ runId: "run" }] })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      validateBatchInput({ items: [{ runId: "run", requestId: "req" }] }),
    ).toEqual({
      ok: true,
      targets: [{ runId: "run", requestId: "req" }],
    });

    const oversized = Array.from(
      { length: MAX_BATCH_SIZE + 1 },
      (_, index) => ({
        runId: `run-${index}`,
        requestId: `req-${index}`,
      }),
    );
    expect(validateBatchInput({ items: oversized })).toEqual({
      ok: false,
      error: "too-large",
    });
  });

  it("dedupes repeated targets", () => {
    expect(
      validateBatchInput({
        items: [
          { runId: "run", requestId: "req" },
          { runId: "run", requestId: "req" },
        ],
      }),
    ).toEqual({
      ok: true,
      targets: [{ runId: "run", requestId: "req" }],
    });
  });
});
