import { describe, expect, it } from "vitest";
import {
  type CodeChangeEvidence,
  type EvidenceBundle,
  type GateReport,
  buildGateReport,
  buildWindow,
} from "./model";

const NOW = "2026-11-21T12:00:00.000Z";
const WINDOW = buildWindow(NOW, 7);

function day(index: number): string {
  return `2026-11-${String(15 + index).padStart(2, "0")}T01:00:00.000Z`;
}

function emptyBundle(): EvidenceBundle {
  return {
    window: WINDOW,
    sources: [],
    informationEvents: [],
    triggerRuns: [],
    manualTasks: [],
    reactionSamples: [],
    manufactureProposals: [],
    codeChanges: [],
    runs: [],
    interventions: [],
    forbiddenBlocks: [],
    recoveryDrills: [],
    evolutionPromotions: [],
    concurrencyEvidence: [],
    factoryEvidence: [],
    workshopEvidence: [],
    outcomeObservations: [],
    installedComponents: [],
    installedSources: [],
    decisionRefs: [],
    lkgRefs: [],
    openIncidents: [],
    supervisor: null,
    coldStart: null,
  };
}

function fullBundle(): EvidenceBundle {
  const bundle = emptyBundle();
  bundle.sources = [
    {
      id: "kitd-audit",
      path: "fixture",
      status: "ok",
      records: 1,
      detail: null,
    },
    {
      id: "store-db",
      path: "fixture",
      status: "ok",
      records: 1,
      detail: null,
    },
  ];
  bundle.informationEvents = Array.from({ length: 7 }, (_, index) => ({
    eventId: `inf-${index}`,
    sourceId: `source-${index % 2}`,
    sourceKind: "passive",
    createdAt: day(index),
  }));
  bundle.triggerRuns = [
    ...Array.from({ length: 7 }, (_, index) => ({
      triggerRunId: `trig-${index}`,
      triggerId: "info-trigger",
      kind: "information",
      jobId: `job-${index}`,
      payloadRef: `event:inf-${index}`,
      status: "started",
      launchedAt: day(index),
    })),
    {
      triggerRunId: "trig-event",
      triggerId: "event-trigger",
      kind: "event",
      jobId: "job-event",
      payloadRef: "event:github",
      status: "started",
      launchedAt: day(2),
    },
    {
      triggerRunId: "trig-schedule",
      triggerId: "cron-trigger",
      kind: "schedule",
      jobId: "job-schedule",
      payloadRef: "schedule:daily",
      status: "started",
      launchedAt: day(3),
    },
  ];
  bundle.reactionSamples = Array.from({ length: 5 }, (_, index) => ({
    at: day(index),
    eventId: `inf-${index}`,
    triggerRunId: `trig-${index}`,
    useful: true,
    costCny: 1,
  }));
  bundle.manufactureProposals = [
    {
      id: "proposal-workflow",
      kind: "workflow",
      status: "accepted",
      model: "live",
      createdAt: day(1),
      acceptedAt: day(1),
      assetId: "weekly-review",
      files: ["workflows/weekly-review.yaml", "team.yaml"],
      provenanceSha256: "a".repeat(64),
    },
    {
      id: "proposal-source",
      kind: "source",
      status: "accepted",
      model: "live",
      createdAt: day(2),
      acceptedAt: day(2),
      assetId: "signals-feed",
      files: ["sources/signals-feed.yaml"],
      provenanceSha256: "b".repeat(64),
    },
  ];
  bundle.codeChanges = [
    change({ dayIndex: 5, iterationId: "iter-5", taskId: "task-5" }),
    change({
      dayIndex: 6,
      iterationId: "iter-6",
      taskId: "task-6",
      triggerRunId: "trig-6",
      resultArtifactId: "artifact-6",
    }),
  ];
  bundle.runs = [
    {
      runId: "run-6",
      triggerRunId: "trig-6",
      status: "succeeded",
      artifactIds: ["artifact-6"],
      createdAt: day(6),
    },
  ];
  bundle.interventions = [
    {
      id: "approval:1",
      at: day(2),
      actor: "operator:console",
      kind: "approval:risk-high",
      category: "high-risk-approval",
      reason: "reviewed the risky change",
      risk: "high",
    },
    {
      id: "ops:1",
      at: day(3),
      actor: "operator:console",
      kind: "ops.autonomy.enabled",
      category: "release-budget",
      reason: "raise the daily budget for the pilot",
      risk: null,
    },
  ];
  bundle.recoveryDrills = [
    {
      id: "drill-1",
      executedAt: day(3),
      outcome: "pass",
      measuredRtoMinutes: 5,
      integrityPass: true,
      script: "smoke:recovery",
    },
  ];
  bundle.evolutionPromotions = [
    {
      id: "promo-1",
      at: day(4),
      action: "evolution.promoted",
      status: "success",
      detail: "promoted a low-risk prompt change",
    },
    {
      id: "promo-rollback",
      at: day(4),
      action: "evolution.rollback",
      status: "success",
      detail: "rollback path exercised",
    },
  ];
  bundle.outcomeObservations = [
    { at: day(4), source: "human_review", score: 0.9, pass: true },
  ];
  bundle.concurrencyEvidence = [
    { id: "activity:lock", at: day(4), kind: "lock.acquired", status: "ok" },
  ];
  bundle.workshopEvidence = [
    {
      id: "activity:workshop",
      at: day(4),
      kind: "workshop.installed",
      status: "ok",
    },
  ];
  bundle.factoryEvidence = [
    {
      id: "activity:factory",
      at: day(4),
      kind: "factory.approved",
      status: "ok",
    },
  ];
  bundle.installedComponents = [
    { pack: "tech-radar", kind: "agent", id: "reviewer" },
  ];
  bundle.decisionRefs = ["approval:1"];
  bundle.lkgRefs = ["lkg-0.9.0-preview@2026-11-20T00:00:00.000Z"];
  bundle.supervisor = {
    present: true,
    children: ["autopilot", "gateway", "web", "worker"],
  };
  bundle.coldStart = { packageOk: true, missing: [], tthwMinutes: 4 };
  return bundle;
}

function change(input: {
  dayIndex: number;
  iterationId: string;
  taskId: string;
  triggerRunId?: string;
  resultArtifactId?: string;
}): CodeChangeEvidence {
  return {
    iterationId: input.iterationId,
    taskId: input.taskId,
    risk: "low",
    status: "succeeded",
    applyStatus: "applied",
    commitSha: "c".repeat(40),
    originKind: "autonomous",
    triggerRunId: input.triggerRunId ?? null,
    startedAt: day(input.dayIndex),
    resultArtifactId: input.resultArtifactId ?? null,
    source: "store",
  };
}

function gate(report: GateReport, id: string) {
  const found = report.gates.find((item) => item.id === id);
  if (!found) {
    throw new Error(`gate ${id} missing`);
  }
  return found;
}

describe("buildWindow", () => {
  it("anchors the window to UTC midnights", () => {
    const window = buildWindow(NOW, 7);
    expect(window.start).toBe("2026-11-15T00:00:00.000Z");
    expect(window.end).toBe(NOW);
    expect(window.days).toBe(7);
  });
});

describe("buildGateReport", () => {
  it("reports every gate as a GAP when there is no evidence", () => {
    const report = buildGateReport(emptyBundle());
    expect(report.allGatesSatisfied).toBe(false);
    expect(report.claimedOneZero).toBe(false);
    expect(report.statement).toContain("1.0 is not yet achieved");
    expect(report.gates).toHaveLength(8);
    expect(report.gates.every((item) => item.status === "gap")).toBe(true);
    expect(report.gaps).toContain("G1.continuity");
    expect(report.gaps).toContain("G2.samples-present");
    expect(report.gaps).toContain("G3.accepted-asset");
    expect(report.gaps).toContain("G4.low-medium-merged");
    expect(report.gaps).toContain("G6.drill-recorded");
    expect(report.gaps).toContain("G7.reactions-present");
  });

  it("never invents metrics for missing data", () => {
    const report = buildGateReport(emptyBundle());
    expect(gate(report, "G2").metrics.usefulRate).toBeNull();
    expect(gate(report, "G2").metrics.noiseCostRatio).toBeNull();
    expect(gate(report, "G6").metrics.latestRtoMinutes).toBeNull();
    expect(gate(report, "G1").metrics.informationEvents).toBe(0);
  });

  it("passes all eight gates with a complete fixture and still does not claim 1.0", () => {
    const report = buildGateReport(fullBundle());
    expect(report.allGatesSatisfied).toBe(true);
    expect(report.claimedOneZero).toBe(false);
    expect(report.gates.map((item) => item.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(report.statement).toContain("operator sign-off");
    expect(report.statement).not.toMatch(/^1\.0/i);
  });

  it("is deterministic regardless of input order", () => {
    const bundle = fullBundle();
    const reversed = fullBundle();
    reversed.informationEvents.reverse();
    reversed.triggerRuns.reverse();
    reversed.reactionSamples.reverse();
    reversed.codeChanges.reverse();
    reversed.runs.reverse();
    reversed.interventions.reverse();
    reversed.recoveryDrills.reverse();
    reversed.manufactureProposals.reverse();
    expect(JSON.stringify(buildGateReport(reversed))).toBe(
      JSON.stringify(buildGateReport(bundle)),
    );
  });

  it("gaps the information loop when a day is missing or a human creates a task", () => {
    const bundle = fullBundle();
    bundle.informationEvents = bundle.informationEvents.filter(
      (event) => event.createdAt !== day(2),
    );
    bundle.manualTasks = [{ id: "manual-1", at: day(3), kind: "iteration" }];
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G1.continuity");
    expect(report.gaps).toContain("G1.no-manual-tasks");
  });

  it("gaps reaction quality below 80% useful or above 20% noise cost", () => {
    const lowUseful = fullBundle();
    const first = lowUseful.reactionSamples[0];
    const second = lowUseful.reactionSamples[1];
    if (first && second) {
      first.useful = false;
      second.useful = false;
    }
    expect(buildGateReport(lowUseful).gaps).toContain("G2.useful-rate");

    const noisy = fullBundle();
    for (const sample of noisy.reactionSamples) {
      sample.useful = true;
    }
    const noise = noisy.reactionSamples[0];
    if (noise) {
      noise.useful = false;
      noise.costCny = 5;
    }
    expect(buildGateReport(noisy).gaps).toContain("G2.noise-cost-ratio");
  });

  it("requires every sample to carry a cost", () => {
    const bundle = fullBundle();
    const sample = bundle.reactionSamples[0];
    if (sample) {
      sample.costCny = null;
    }
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G2.cost-complete");
    expect(gate(report, "G2").metrics.totalCostCny).toBeNull();
  });

  it("gaps asset manufacture without an AI draft or system-written files", () => {
    const bundle = fullBundle();
    bundle.manufactureProposals = bundle.manufactureProposals.map(
      (proposal) => ({
        ...proposal,
        model: "heuristic",
        files: [],
        provenanceSha256: null,
      }),
    );
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G3.ai-drafted");
    expect(report.gaps).toContain("G3.system-written");
  });

  it("gaps code manufacture on forbidden blocks or unlinked high-risk changes", () => {
    const bundle = fullBundle();
    bundle.forbiddenBlocks = [
      { id: "f-1", at: day(3), detail: "forbidden path" },
    ];
    bundle.codeChanges = [
      ...bundle.codeChanges,
      {
        ...change({
          dayIndex: 4,
          iterationId: "iter-high",
          taskId: "task-high",
        }),
        risk: "high",
      },
    ];
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G4.forbidden-zero");
    expect(report.gaps).toContain("G4.high-risk-approved");
  });

  it("gaps observer boundary on unaudited interventions", () => {
    const bundle = fullBundle();
    bundle.interventions = [
      ...bundle.interventions,
      {
        id: "manual-trigger:1",
        at: day(3),
        actor: "unattributed",
        kind: "trigger:manual",
        category: "routine",
        reason: null,
        risk: null,
      },
    ];
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G5.reason-recorded");
    expect(report.gaps).toContain("G5.actor-recorded");
  });

  it("gaps approvals that carry no risk class instead of assuming one", () => {
    const bundle = fullBundle();
    bundle.interventions = bundle.interventions.map((item) =>
      item.category === "high-risk-approval" ? { ...item, risk: null } : item,
    );
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G5.approval-risk-recorded");
    expect(gate(report, "G5").metrics).toMatchObject({
      approvals: 1,
      highRiskApprovals: 0,
      untypedApprovals: 1,
    });
  });

  it("passes approval risk when every decision carries a class", () => {
    const bundle = fullBundle();
    const report = buildGateReport(bundle);
    expect(report.gaps).not.toContain("G5.approval-risk-recorded");
  });

  it("gaps recovery when RTO exceeds 10 minutes or integrity fails", () => {
    const bundle = fullBundle();
    bundle.recoveryDrills = [
      {
        id: "drill-slow",
        executedAt: day(3),
        outcome: "pass",
        measuredRtoMinutes: 11,
        integrityPass: false,
        script: "smoke:recovery",
      },
    ];
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G6.rto-target");
    expect(report.gaps).toContain("G6.integrity");
  });

  it("gaps traceability when links, decisions or rollback references are missing", () => {
    const bundle = fullBundle();
    bundle.decisionRefs = [];
    bundle.lkgRefs = [];
    const jobs = bundle.triggerRuns.map((run) =>
      run.kind === "information" ? { ...run, payloadRef: null } : run,
    );
    bundle.triggerRuns = jobs;
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G7.event-and-job-links");
    expect(report.gaps).toContain("G7.decision-link");
    expect(report.gaps).toContain("G7.rollback-link");
  });

  it("gaps support conditions with no concurrency, workshop or factory records", () => {
    const bundle = fullBundle();
    bundle.concurrencyEvidence = [];
    bundle.workshopEvidence = [];
    bundle.factoryEvidence = [];
    bundle.coldStart = { packageOk: true, missing: [], tthwMinutes: null };
    const report = buildGateReport(bundle);
    expect(report.gaps).toContain("G8.S9.concurrency");
    expect(report.gaps).toContain("G8.S10.workshop");
    expect(report.gaps).toContain("G8.S11.pixel-factory");
    expect(report.gaps).toContain("G8.S12.zero-config");
  });
});
