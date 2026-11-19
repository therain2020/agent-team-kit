#!/usr/bin/env bun
import {
  DEGRADATION_MODE_IDS,
  type DrillOutcome,
  newRunbook,
  newRunbookDrill,
  runbookCoverage,
} from "@kit/core";
import { initStore } from "@kit/store";

/**
 * Runbook coverage + drill records (61 §3.2, §5). Every declared degradation
 * mode needs an active runbook and at least one drill record. Dry-run by
 * default; `--execute --seed-runbooks` writes the default templates and
 * `--record --mode <id>` appends a drill record.
 */
interface RunbookTemplate {
  trigger: string;
  steps: { order: number; action: string; expected: string }[];
  verification: { check: string; expected: string }[];
}

const TEMPLATES: Record<string, RunbookTemplate> = {
  "model.provider": {
    trigger: "model provider outage or circuit open",
    steps: [
      {
        order: 1,
        action: "Enable an allowed fallback model or pause the affected stage",
        expected: "stage paused or serving a permitted fallback",
      },
      {
        order: 2,
        action: "Re-check the quality floor before any external output",
        expected: "quality floor passes",
      },
      {
        order: 3,
        action: "Serve the verified LKG for external delivery",
        expected: "delivery uses verified LKG",
      },
    ],
    verification: [
      { check: "quality floor", expected: "all external outputs pass" },
    ],
  },
  event_bus: {
    trigger: "event bus unavailable",
    steps: [
      {
        order: 1,
        action: "Enable the local persistent spool buffer",
        expected: "buffer-only mode active",
      },
      {
        order: 2,
        action: "Stop accepting unbounded new tasks",
        expected: "backlog bounded",
      },
      {
        order: 3,
        action: "On recovery replay by event_id and dedupe",
        expected: "spool drained with no duplicates",
      },
    ],
    verification: [
      { check: "event_spool pending", expected: "0 after recovery" },
    ],
  },
  artifact_store: {
    trigger: "artifact store unavailable",
    steps: [
      {
        order: 1,
        action: "Stop publishing and suspend the run",
        expected: "runs suspended",
      },
      {
        order: 2,
        action: "Stage outputs locally and checksum them",
        expected: "staged files checksummed",
      },
      {
        order: 3,
        action: "On recovery re-write the Manifest",
        expected: "Manifests re-written",
      },
    ],
    verification: [
      { check: "artifact integrity", expected: "hashes match Manifest" },
    ],
  },
  source_api: {
    trigger: "source ingestion interrupted",
    steps: [
      {
        order: 1,
        action: "Pause ingestion and keep the queue",
        expected: "queue retained",
      },
      {
        order: 2,
        action: "Switch to a registered backup source",
        expected: "backup source serving",
      },
      {
        order: 3,
        action: "Annotate the coverage gap in the report",
        expected: "gap documented",
      },
    ],
    verification: [
      { check: "coverage gap", expected: "reported, no silent gap" },
    ],
  },
  delivery: {
    trigger: "quality floor not met on delivery",
    steps: [
      {
        order: 1,
        action: "Block external delivery",
        expected: "no external output",
      },
      {
        order: 2,
        action: "Serve verified LKG if available",
        expected: "LKG served or delivery stays blocked",
      },
      {
        order: 3,
        action: "Recheck quality before resuming delivery",
        expected: "quality recheck passes",
      },
    ],
    verification: [
      { check: "external delivery", expected: "100% quality-floor checked" },
    ],
  },
};

const execute = process.argv.includes("--execute");
const seed = process.argv.includes("--seed-runbooks");
const record = process.argv.includes("--record");
const workspaceId = argValue("--workspace") ?? "default";
const executedBy = argValue("--executed-by") ?? "operator:runbook-drill";
const mode = argValue("--mode");
const outcome = (argValue("--outcome") ?? "pass") as DrillOutcome;
const notes = argValue("--notes") ?? "runbook drill";

if (outcome !== "pass" && outcome !== "fail") {
  console.error("--outcome must be pass or fail");
  process.exit(2);
}

const store = await initStore();
try {
  if (execute && seed) {
    for (const modeId of DEGRADATION_MODE_IDS) {
      const existing = await store.runbooks.list(workspaceId, {
        modeId,
        status: "active",
      });
      if (existing.length > 0) {
        continue;
      }
      const template = TEMPLATES[modeId];
      if (!template) {
        continue;
      }
      const runbook = newRunbook({
        workspaceId,
        modeId,
        trigger: template.trigger,
        steps: template.steps,
        verification: template.verification,
        owner: executedBy,
      });
      await store.runbooks.upsert(runbook);
      console.log(`seeded runbook ${runbook.runbookId} for ${modeId}`);
    }
  }

  if (execute && record) {
    if (!mode) {
      console.error("--record requires --mode <modeId>");
      process.exit(2);
    }
    const [runbook] = await store.runbooks.list(workspaceId, {
      modeId: mode,
      status: "active",
    });
    if (!runbook) {
      console.error(
        `no active runbook for ${mode}; run with --execute --seed-runbooks first`,
      );
      process.exit(1);
    }
    const drill = newRunbookDrill({
      workspaceId,
      runbookId: runbook.runbookId,
      modeId: mode,
      executedBy,
      outcome,
      notes,
    });
    await store.drills.recordRunbookDrill(drill);
    console.log(
      `recorded drill ${drill.drillId} ${outcome} for ${mode} (${runbook.runbookId})`,
    );
  }

  const coverage = runbookCoverage(
    await store.runbooks.list(workspaceId),
    await store.drills.listRunbookDrillsByWorkspace(workspaceId),
  );
  console.log(
    JSON.stringify(
      {
        dryRun: !execute,
        workspaceId,
        coveredModes: coverage.coveredModes,
        undrilledModes: coverage.undrilledModes,
        missingModes: coverage.missingModes,
        requiredModes: coverage.requiredModes,
      },
      null,
      2,
    ),
  );
} finally {
  await store.close();
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
