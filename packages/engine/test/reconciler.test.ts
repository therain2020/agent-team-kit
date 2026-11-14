import { describe, expect, it } from "vitest";
import {
  type EngineProbe,
  type EngineRunStatus,
  type ReconcileRunRow,
  decideReconciliations,
  probeErrorStatus,
  reconcileLocalTarget,
  reconcileTarget,
} from "../src/reconciler";

function row(overrides: Partial<ReconcileRunRow> = {}): ReconcileRunRow {
  return {
    iterationId: "it_1",
    workspaceId: "default",
    workflowId: "iteration-it_1",
    status: "running",
    updatedAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

function probe(status: EngineRunStatus | Error): EngineProbe {
  return {
    async describe() {
      if (status instanceof Error) {
        throw status;
      }
      return status;
    },
  };
}

describe("reconcileTarget", () => {
  it("maps engine terminal failures to failed", () => {
    expect(reconcileTarget("failed")).toBe("failed");
    expect(reconcileTarget("terminated")).toBe("failed");
    expect(reconcileTarget("timed_out")).toBe("failed");
  });

  it("maps engine cancellation to cancelled", () => {
    expect(reconcileTarget("cancelled")).toBe("cancelled");
  });

  it("maps a missing workflow to failed", () => {
    expect(reconcileTarget("missing")).toBe("failed");
  });

  it("leaves live and unknown engines alone", () => {
    expect(reconcileTarget("running")).toBeNull();
    expect(reconcileTarget("completed")).toBeNull();
    expect(reconcileTarget("continued_as_new")).toBeNull();
    expect(reconcileTarget("unknown")).toBeNull();
  });
});

describe("decideReconciliations", () => {
  it("skips live runs", async () => {
    const decisions = await decideReconciliations(
      [row({ iterationId: "it_live" })],
      probe("running"),
    );
    expect(decisions).toHaveLength(0);
  });

  it("repairs failed and cancelled engines with evidence", async () => {
    const failed = await decideReconciliations(
      [row({ iterationId: "it_failed" })],
      probe("failed"),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.target).toBe("failed");
    expect(failed[0]?.reason).toContain("engine workflow failed");

    const cancelled = await decideReconciliations(
      [row({ iterationId: "it_cancelled" })],
      probe("cancelled"),
    );
    expect(cancelled[0]?.target).toBe("cancelled");
  });

  it("skips runs without a workflow id and probe failures", async () => {
    const noWorkflow = await decideReconciliations(
      [row({ workflowId: null })],
      probe("failed"),
    );
    expect(noWorkflow).toHaveLength(0);

    const unreachable = await decideReconciliations(
      [row()],
      probe(new Error("temporal down")),
    );
    expect(unreachable).toHaveLength(0);
  });
});

describe("probeErrorStatus", () => {
  it("treats a missing workflow as deterministic failure evidence", () => {
    const notFound = new Error("workflow not found");
    notFound.name = "WorkflowNotFoundError";
    expect(probeErrorStatus(notFound)).toBe("missing");

    const grpcNotFound = Object.assign(new Error("not found"), {
      cause: { code: 5 },
    });
    expect(probeErrorStatus(grpcNotFound)).toBe("missing");
  });

  it("keeps transient probe errors unknown", () => {
    expect(probeErrorStatus(new Error("connection refused"))).toBe("unknown");
    expect(
      probeErrorStatus(
        Object.assign(new Error("unavailable"), {
          cause: { code: 14 },
        }),
      ),
    ).toBe("unknown");
  });
});

describe("reconcileLocalTarget", () => {
  const now = new Date("2026-11-15T01:00:00.000Z");

  it("fails runs whose request is missing or already failed", () => {
    expect(
      reconcileLocalTarget(
        { requestStatus: null, requestHeartbeatAt: null },
        {
          now,
        },
      ),
    ).toMatchObject({ target: "failed" });
    expect(
      reconcileLocalTarget(
        {
          requestStatus: "failed",
          requestError: "coder boom",
          requestHeartbeatAt: null,
        },
        { now },
      ),
    ).toMatchObject({
      target: "failed",
      reason: "reconciled: local request failed (coder boom)",
    });
  });

  it("maps cancelled requests to cancelled", () => {
    expect(
      reconcileLocalTarget(
        { requestStatus: "cancelled", requestHeartbeatAt: null },
        { now },
      ),
    ).toMatchObject({ target: "cancelled" });
  });

  it("leaves queued requests for a future runner", () => {
    expect(
      reconcileLocalTarget(
        { requestStatus: "queued", requestHeartbeatAt: null },
        { now },
      ),
    ).toBeNull();
  });

  it("fails claimed requests with a stale heartbeat only", () => {
    expect(
      reconcileLocalTarget(
        {
          requestStatus: "claimed",
          requestHeartbeatAt: "2026-11-15T00:50:00.000Z",
        },
        { now },
      ),
    ).toMatchObject({ target: "failed" });
    expect(
      reconcileLocalTarget(
        {
          requestStatus: "claimed",
          requestHeartbeatAt: "2026-11-15T00:59:00.000Z",
        },
        { now },
      ),
    ).toBeNull();
  });
});
