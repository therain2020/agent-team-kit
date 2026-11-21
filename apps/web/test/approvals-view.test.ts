import { describe, expect, it } from "vitest";
import {
  approvalsHref,
  cycleRequestId,
  factoryRunHref,
  firstRequestForRun,
  flattenTower,
  parseApprovalsView,
  requestIdsOf,
  resolveInitialRequest,
  stepRequestId,
  towerBatchTargets,
  towerCardToItem,
} from "../lib/approvals-view";
import type { FactoryItem } from "../lib/factory";
import type { ApprovalTowerCard } from "../lib/inbox-shared";
import { groupApprovals } from "../lib/inbox-shared";

const NOW = new Date(2026, 10, 19, 10, 0, 0).getTime();
const MINUTE = 60_000;

function card(
  requestId: string,
  overrides: Partial<ApprovalTowerCard> = {},
): ApprovalTowerCard {
  return {
    requestId,
    runId: `run_${requestId}`,
    changeId: null,
    substrate: null,
    revertRef: null,
    workflowId: "demo",
    stageId: `run_${requestId}:review`,
    stageName: "review",
    kind: "gate_failure",
    requestType: "gate_failure",
    riskClass: "medium",
    summary: requestId,
    requester: "manager",
    assignee: null,
    status: "queued",
    version: 3,
    createdAt: new Date(NOW - 15 * MINUTE).toISOString(),
    dueAt: new Date(NOW - MINUTE).toISOString(),
    expiresAt: null,
    draftArtifactId: null,
    draftSnippet: "",
    gate: null,
    budget: null,
    runStatus: "paused",
    ...overrides,
  };
}

describe("approvals view routing", () => {
  it("falls back to the queue for unknown or missing view params", () => {
    expect(parseApprovalsView(undefined)).toBe("queue");
    expect(parseApprovalsView("nonsense")).toBe("queue");
    expect(parseApprovalsView(["factory", "queue"])).toBe("factory");
    expect(parseApprovalsView("factory")).toBe("factory");
  });

  it("keeps the request id in deep links", () => {
    expect(approvalsHref()).toBe("/approvals");
    expect(approvalsHref("queue", "req_1")).toBe("/approvals?request=req_1");
    expect(approvalsHref("factory")).toBe("/approvals?view=factory");
    expect(approvalsHref("factory", "req_1")).toBe(
      "/approvals?view=factory&request=req_1",
    );
  });

  it("opens the deep-linked request when it is still queued", () => {
    expect(resolveInitialRequest(["a", "b"], "b")).toBe("b");
    expect(resolveInitialRequest(["a", "b"], "gone")).toBe("a");
    expect(resolveInitialRequest([], "gone")).toBeNull();
  });

  it("builds a factory deep link scoped to a run (97.3)", () => {
    expect(factoryRunHref("run_1")).toBe("/approvals?view=factory&run=run_1");
  });

  it("preselects the first approval of a run, ignoring failed runs", () => {
    const items: FactoryItem[] = [
      {
        kind: "approval",
        requestId: "other",
        runId: "run_other",
        riskClass: "low",
        summary: "other",
        costCny: 0,
        updatedAt: "2026-11-19T10:00:00.000Z",
      },
      {
        kind: "failed",
        runId: "run_target",
        riskClass: "high",
        summary: "failed",
        costCny: 0,
        updatedAt: "2026-11-19T10:00:00.000Z",
      },
      {
        kind: "approval",
        requestId: "first",
        runId: "run_target",
        riskClass: "medium",
        summary: "first",
        costCny: 0,
        updatedAt: "2026-11-19T10:00:00.000Z",
      },
      {
        kind: "approval",
        requestId: "second",
        runId: "run_target",
        riskClass: "low",
        summary: "second",
        costCny: 0,
        updatedAt: "2026-11-19T10:00:00.000Z",
      },
    ];
    expect(firstRequestForRun(items, "run_target")).toBe("first");
    expect(firstRequestForRun(items, "run_missing")).toBeNull();
    expect(firstRequestForRun(items, null)).toBeNull();
  });
});

describe("shared selection movement", () => {
  it("flattens the tower in SLA order", () => {
    const groups = groupApprovals(
      [
        card("later", { dueAt: new Date(NOW + 5 * 60 * MINUTE).toISOString() }),
        card("overdue"),
        card("soon", { dueAt: new Date(NOW + 5 * MINUTE).toISOString() }),
      ],
      NOW,
    );
    expect(flattenTower(groups).map((entry) => entry.requestId)).toEqual([
      "overdue",
      "soon",
      "later",
    ]);
  });

  it("clamps the tower at the ends", () => {
    expect(stepRequestId(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepRequestId(["a", "b", "c"], "a", 1)).toBe("b");
    expect(stepRequestId(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepRequestId(["a"], null, 1)).toBe("a");
    expect(stepRequestId([], "a", 1)).toBeNull();
  });

  it("wraps the conveyor so both views point at the same approval", () => {
    expect(cycleRequestId(["a", "b", "c"], "c", 1)).toBe("a");
    expect(cycleRequestId(["a", "b", "c"], "a", -1)).toBe("c");
    expect(cycleRequestId(["a", "b"], "missing", 1)).toBe("a");
    expect(cycleRequestId([], null, 1)).toBeNull();
  });

  it("drops ids from failed runs when projecting workpieces", () => {
    expect(
      requestIdsOf([
        { requestId: "a" },
        { requestId: undefined },
        { requestId: "b" },
      ]),
    ).toEqual(["a", "b"]);
  });
});

describe("queue to line projection", () => {
  it("maps a tower card onto the factory item the line and drawer use", () => {
    const item = towerCardToItem(
      card("req_1", {
        requestType: "stage_before",
        riskClass: "low",
        budget: { spentCny: 1.5, limitCny: 10 },
        expiresAt: "2026-11-19T12:00:00.000Z",
      }),
    );
    expect(item.kind).toBe("approval");
    expect(item.requestId).toBe("req_1");
    expect(item.stationId).toBe("build");
    expect(item.requestType).toBe("stage_before");
    expect(item.costCny).toBe(1.5);
    expect(item.expiresAt).toBe("2026-11-19T12:00:00.000Z");
  });

  it("keeps the CAS version on batch targets", () => {
    expect(towerBatchTargets([card("a"), card("b", { version: 7 })])).toEqual([
      { runId: "run_a", requestId: "a", version: 3 },
      { runId: "run_b", requestId: "b", version: 7 },
    ]);
  });
});
