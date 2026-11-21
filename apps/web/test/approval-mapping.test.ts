import { describe, expect, it } from "vitest";
import {
  type ApprovalEntityView,
  toApiApprovalItem,
} from "../lib/approval-mapping";

const entity: ApprovalEntityView = {
  approvalId: "apr_1",
  runId: "run_1",
  workflowId: "demo",
  stageId: "run_1:review",
  stageName: "review",
  kind: "gate_failure",
  status: "queued",
  slaDueAt: "2026-11-16T00:00:00.000Z",
  expiresAt: "2026-11-20T00:00:00.000Z",
  requester: "manager",
  assignee: null,
  version: 1,
  runStatus: "paused",
};

describe("approval API item mapping", () => {
  it("keeps the legacy JSON shape for the inbox endpoint", () => {
    const item = toApiApprovalItem(entity, {
      requestId: "apr_1",
      summary: "gate failed: needs a human",
      options: ["approve", "abort"],
      riskClass: "high",
    });

    expect(item).toEqual({
      runId: "run_1",
      workflowId: "demo",
      requestId: "apr_1",
      stageId: "run_1:review",
      stageName: "review",
      requestType: "gate_failure",
      riskClass: "high",
      summary: "gate failed: needs a human",
      options: ["approve", "abort"],
      expiresAt: "2026-11-20T00:00:00.000Z",
      status: "queued",
      requester: "manager",
      assignee: null,
      version: 1,
      slaDueAt: "2026-11-16T00:00:00.000Z",
      runStatus: "paused",
      substrate: null,
      changeId: null,
    });
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining([
        "runId",
        "workflowId",
        "requestId",
        "stageId",
        "stageName",
        "requestType",
        "riskClass",
        "summary",
        "options",
        "expiresAt",
      ]),
    );
  });

  it("falls back to safe defaults when the payload is unavailable", () => {
    const item = toApiApprovalItem(
      { ...entity, stageName: null, expiresAt: null },
      null,
    );
    expect(item.stageName).toBe("");
    expect(item.expiresAt).toBe("");
    expect(item.riskClass).toBe("medium");
    expect(item.options).toEqual(["approve", "abort"]);
    expect(item.summary).toBe("");
  });

  it("carries requester and takeover owner through the API shape", () => {
    const taken = toApiApprovalItem(
      { ...entity, assignee: "operator:web" },
      { requestedBy: "manager" },
    );
    expect(taken.requester).toBe("manager");
    expect(taken.assignee).toBe("operator:web");

    const fallback = toApiApprovalItem(
      { ...entity, requester: undefined, assignee: undefined },
      { requestedBy: "reviewer" },
    );
    expect(fallback.requester).toBe("reviewer");
    expect(fallback.assignee).toBeNull();
  });

  it("prefers the risk class recorded on the approvals row", () => {
    const item = toApiApprovalItem(
      { ...entity, riskClass: "high" },
      { riskClass: "low" },
    );
    expect(item.riskClass).toBe("high");

    // Legacy rows have no column value; the request payload still carries it.
    const legacy = toApiApprovalItem(
      { ...entity, riskClass: null },
      { riskClass: "medium" },
    );
    expect(legacy.riskClass).toBe("medium");
  });

  it("uses payload fields the entity does not store", () => {
    const item = toApiApprovalItem(
      { ...entity, workflowId: null, stageName: null },
      {
        stageName: "publish",
        riskClass: "low",
        summary: "ready",
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
    );
    expect(item.workflowId).toBe("");
    expect(item.stageName).toBe("publish");
    expect(item.riskClass).toBe("low");
    expect(item.expiresAt).toBe("2026-11-20T00:00:00.000Z");
  });
});
