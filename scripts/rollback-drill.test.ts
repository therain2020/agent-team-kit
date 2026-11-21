import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EvidenceBundle,
  buildGateReport,
  buildWindow,
} from "./gate-report/model";
import {
  type RollbackDrillReport,
  defaultRollbackDrillReportPath,
  runRollbackDrill,
} from "./rollback-drill";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const at = "2026-11-21T00:00:00.000Z";

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function localStore() {
  const dir = await tempDir("kit-rollback-drill-store-");
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

function g6Bundle(report: RollbackDrillReport): EvidenceBundle {
  return {
    window: buildWindow(report.finishedAt, 7),
    sources: [
      { id: "store-db", path: "drill", status: "ok", records: 1, detail: null },
    ],
    informationEvents: [],
    triggerRuns: [],
    manualTasks: [],
    reactionSamples: [],
    reactionSignals: [],
    manufactureProposals: [],
    codeChanges: [],
    runs: [],
    interventions: [],
    forbiddenBlocks: [],
    recoveryDrills: [
      {
        id: report.drillId,
        executedAt: report.finishedAt,
        outcome: report.outcome === "passed" ? "pass" : "fail",
        measuredRtoMinutes: report.rto.worstCaseMinutes,
        integrityPass: report.integrityPass,
        script: report.script,
      },
    ],
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

describe("rollback drill", () => {
  it("rolls back one code change and one instruction change within the RTO target", async () => {
    const store = await localStore();
    const reportPath = path.join(
      await tempDir("kit-rollback-drill-report-"),
      "rollback-drill-20261121-000000.json",
    );

    const report = await runRollbackDrill(store, {
      workspaceId: "ws-drill",
      executedBy: "tester",
      sourceRepo: process.cwd(),
      reportPath,
      now: at,
    });

    expect(report.outcome).toBe("passed");
    expect(report.changes.code?.status).toBe("ok");
    expect(report.changes.instruction?.status).toBe("ok");
    expect(report.changes.code?.pass).toBe(true);
    expect(report.changes.instruction?.pass).toBe(true);
    expect(report.integrityPass).toBe(true);
    expect(report.rto.worstCaseMinutes).toBeLessThanOrEqual(
      report.rto.targetMinutes,
    );
    expect(report.rto.targetMinutes).toBe(10);
    expect(report.source.gitSha).toMatch(/^[0-9a-f]{40}$/);

    const check = (name: string) =>
      report.checks.find((item) => item.name === name);
    expect(check("code-own-commit-reverted")?.pass).toBe(true);
    expect(check("code-unrelated-change-preserved")?.pass).toBe(true);
    expect(check("instruction-restored")?.pass).toBe(true);
    expect(check("instruction-backup-integrity")?.pass).toBe(true);
    expect(check("audit-trail")?.pass).toBe(true);
    expect(check("rto-target")?.pass).toBe(true);
    expect(check("drill-recorded")?.pass).toBe(true);

    const drills = await store.drills.listRecoveryDrills(10);
    const row = drills.find((item) => item.drillId === report.drillId);
    expect(row?.outcome).toBe("pass");
    expect(row?.integrityPass).toBe(true);
    expect(row?.measuredRtoMinutes).toBeLessThanOrEqual(10);
    expect(row?.script).toBe("scripts/rollback-drill.ts");

    const raw = JSON.parse(await readFile(reportPath, "utf8")) as {
      script?: string;
      finishedAt?: string;
      recoverySeconds?: number;
      checks?: Array<{ pass?: boolean }>;
    };
    expect(raw.script).toBe("scripts/rollback-drill.ts");
    expect(raw.finishedAt).toBe(report.finishedAt);
    expect(raw.recoverySeconds).toBe(report.recoverySeconds);
    expect(raw.checks?.every((item) => item.pass === true)).toBe(true);
  });

  it("is judged by the same G6 rule as every other recovery drill", async () => {
    const store = await localStore();
    const report = await runRollbackDrill(store, {
      workspaceId: "ws-drill",
      executedBy: "tester",
      sourceRepo: process.cwd(),
      reportPath: path.join(
        await tempDir("kit-rollback-drill-report-"),
        "rollback-drill-20261121-000001.json",
      ),
      now: at,
    });

    const gate = buildGateReport(g6Bundle(report)).gates.find(
      (item) => item.id === "G6",
    );
    expect(gate?.status).toBe("pass");
    expect(gate?.metrics.latestRtoMinutes).toBe(report.rto.worstCaseMinutes);
    expect(gate?.metrics.latestOutcome).toBe("pass");
  });

  it("names its report for the gate collector window", () => {
    const file = defaultRollbackDrillReportPath(
      new Date("2026-11-21T12:34:56.000Z"),
      "C:/kit-home",
    );
    expect(path.basename(file)).toBe("rollback-drill-20261121-123456.json");
  });
});
