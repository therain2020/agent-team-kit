import { describe, expect, it } from "vitest";
import {
  DEGRADATION_MODE_IDS,
  DRILL_INTERVAL_MS,
  IncidentContractError,
  RPO_TARGET_MINUTES,
  RTO_TARGET_MINUTES,
  appendIncidentTimeline,
  evaluateRecoveryDrill,
  incidentToEvolutionSignal,
  incidentToRegressionCase,
  isRecoveryDrillDue,
  newIncident,
  newRecoveryDrill,
  newRunbook,
  newRunbookDrill,
  postmortemDeadlines,
  postmortemState,
  runbookCoverage,
  updateIncidentPostmortem,
} from "../src/incident";

const DETECTED_AT = "2026-11-01T00:00:00.000Z";

function incident() {
  return newIncident({
    workspaceId: "ws",
    title: "model provider outage",
    severity: "sev2",
    owner: "oncall",
    detectedAt: DETECTED_AT,
    now: DETECTED_AT,
  });
}

function runbook(modeId: string, status: "active" | "draft" = "active") {
  return newRunbook({
    workspaceId: "ws",
    modeId,
    trigger: "dependency down",
    owner: "oncall",
    status,
    steps: [
      { order: 2, action: "page owner", expected: "owner ack" },
      { order: 1, action: "flip to LKG", expected: "LKG served" },
    ],
    now: DETECTED_AT,
  });
}

describe("incident contract (61 §3.4)", () => {
  it("seeds a detected timeline and fixes the 24h/48h deadlines", () => {
    const record = incident();
    expect(record.status).toBe("open");
    expect(record.timeline).toHaveLength(1);
    expect(record.timeline[0]?.kind).toBe("detected");
    const deadlines = postmortemDeadlines(DETECTED_AT);
    expect(deadlines.draftDueAt).toBe("2026-11-02T00:00:00.000Z");
    expect(deadlines.finalDueAt).toBe("2026-11-03T00:00:00.000Z");
    expect(record.postmortem.draftDueAt).toBe(deadlines.draftDueAt);
    expect(record.postmortem.finalDueAt).toBe(deadlines.finalDueAt);
  });

  it("flags an overdue draft at 24h and overdue final at 48h", () => {
    const record = incident();
    const draftOver = postmortemState(record, "2026-11-02T01:00:00.000Z");
    expect(draftOver.draftOverdue).toBe(true);
    expect(draftOver.finalOverdue).toBe(false);
    expect(draftOver.overdue).toBe(true);

    const finalOver = postmortemState(record, "2026-11-03T01:00:00.000Z");
    expect(finalOver.finalOverdue).toBe(true);

    const drafted = updateIncidentPostmortem(record, {
      status: "draft",
      content: "root cause",
      now: "2026-11-02T05:00:00.000Z",
    });
    const afterDraft = postmortemState(drafted, "2026-11-02T06:00:00.000Z");
    expect(afterDraft.draftOverdue).toBe(false);
    expect(afterDraft.finalOverdue).toBe(false);

    const finalized = updateIncidentPostmortem(drafted, {
      status: "final",
      now: "2026-11-03T06:00:00.000Z",
    });
    expect(
      postmortemState(finalized, "2026-11-05T00:00:00.000Z").finalOverdue,
    ).toBe(false);
  });

  it("closes the incident when a resolved entry is appended", () => {
    const resolved = appendIncidentTimeline(incident(), {
      kind: "resolved",
      actor: "oncall",
      note: "recovered",
      at: "2026-11-01T02:00:00.000Z",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.timeline).toHaveLength(2);
    expect(resolved.updatedAt).toBe("2026-11-01T02:00:00.000Z");
  });
});

describe("runbook contract (61 §3.2)", () => {
  it("rejects runbooks for unknown degradation modes", () => {
    expect(() =>
      newRunbook({
        workspaceId: "ws",
        modeId: "not-a-mode",
        trigger: "x",
        owner: "oncall",
        steps: [{ order: 1, action: "do", expected: "" }],
      }),
    ).toThrow(IncidentContractError);
  });

  it("sorts steps and defaults to active", () => {
    const record = runbook("model.provider");
    expect(record.status).toBe("active");
    expect(record.steps.map((step) => step.order)).toEqual([1, 2]);
  });
});

describe("runbook coverage (61 §5)", () => {
  it("requires an active runbook AND a drill record per mode", () => {
    const rb = runbook("model.provider");
    const empty = runbookCoverage([rb], []);
    expect(empty.coveredModes).toEqual([]);
    expect(empty.undrilledModes).toContain("model.provider");
    expect(empty.missingModes).toHaveLength(DEGRADATION_MODE_IDS.length - 1);

    const drill = newRunbookDrill({
      workspaceId: "ws",
      runbookId: rb.runbookId,
      modeId: rb.modeId,
      executedBy: "oncall",
      outcome: "pass",
    });
    const covered = runbookCoverage([rb], [drill]);
    expect(covered.coveredModes).toEqual(["model.provider"]);
    expect(covered.undrilledModes).toEqual([]);
  });

  it("a draft runbook does not count toward coverage", () => {
    const rb = runbook("model.provider", "draft");
    const drill = newRunbookDrill({
      workspaceId: "ws",
      runbookId: rb.runbookId,
      modeId: rb.modeId,
      executedBy: "oncall",
      outcome: "pass",
    });
    const coverage = runbookCoverage([rb], [drill]);
    expect(coverage.coveredModes).toEqual([]);
    expect(coverage.missingModes).toContain("model.provider");
  });
});

describe("RTO/RPO recovery drills (D-38)", () => {
  it("passes only within RTO 4h / RPO 6h and integrity", () => {
    const ok = evaluateRecoveryDrill({
      measuredRtoMinutes: 180,
      measuredRpoMinutes: 300,
      integrityPass: true,
    });
    expect(ok.pass).toBe(true);

    const slow = evaluateRecoveryDrill({
      measuredRtoMinutes: RTO_TARGET_MINUTES + 1,
      measuredRpoMinutes: 300,
      integrityPass: true,
    });
    expect(slow.pass).toBe(false);

    const lossy = evaluateRecoveryDrill({
      measuredRtoMinutes: 60,
      measuredRpoMinutes: RPO_TARGET_MINUTES + 1,
      integrityPass: true,
    });
    expect(lossy.pass).toBe(false);

    const corrupted = evaluateRecoveryDrill({
      measuredRtoMinutes: 60,
      measuredRpoMinutes: 60,
      integrityPass: false,
    });
    expect(corrupted.pass).toBe(false);
  });

  it("derives the outcome from the evaluation", () => {
    const fail = newRecoveryDrill({
      executedBy: "oncall",
      measuredRtoMinutes: 999,
      measuredRpoMinutes: 60,
      integrityPass: true,
    });
    expect(fail.outcome).toBe("fail");

    const pass = newRecoveryDrill({
      executedBy: "oncall",
      measuredRtoMinutes: 120,
      measuredRpoMinutes: 240,
      integrityPass: true,
    });
    expect(pass.outcome).toBe("pass");
    expect(pass.script).toBe("smoke:recovery");
    expect(pass.rtoTargetMinutes).toBe(RTO_TARGET_MINUTES);
    expect(pass.rpoTargetMinutes).toBe(RPO_TARGET_MINUTES);
  });

  it("is due when never run and again after the quarterly cadence", () => {
    expect(isRecoveryDrillDue(null)).toBe(true);
    expect(
      isRecoveryDrillDue(
        "2026-11-01T00:00:00.000Z",
        "2026-11-20T00:00:00.000Z",
      ),
    ).toBe(false);
    const stale = new Date(
      Date.parse("2026-11-01T00:00:00.000Z") + DRILL_INTERVAL_MS + 1,
    ).toISOString();
    expect(isRecoveryDrillDue("2026-11-01T00:00:00.000Z", stale)).toBe(true);
  });
});

describe("handoff integration points", () => {
  it("produces a stable RegressionCase draft (plan 40)", () => {
    const record = incident();
    const draft = incidentToRegressionCase(record);
    expect(draft.caseId).toBe(`reg_${record.incidentId}`);
    expect(draft.source).toBe("incident");
    expect(draft.sourceRef).toEqual({
      kind: "incident",
      id: record.incidentId,
    });
    expect(draft.reproduction.length).toBeGreaterThan(0);
  });

  it("produces an evolution signal draft (plan 70)", () => {
    const record = incident();
    const signal = incidentToEvolutionSignal(record);
    expect(signal.signalId).toBe(`sig_inc_${record.incidentId}`);
    expect(signal.source).toBe("manual");
    expect(signal.incidentId).toBe(record.incidentId);
    expect(signal.severity).toBe("sev2");
  });
});
