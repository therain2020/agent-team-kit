#!/usr/bin/env bun
import {
  DEGRADATION_MODE_IDS,
  type DrillOutcome,
  newRunbook,
  newRunbookDrill,
  runbookCoverage,
} from "@kit/core";
import { initStore } from "@kit/store";
import { RUNBOOK_TEMPLATES as TEMPLATES } from "./runbook-templates";

/**
 * Runbook coverage + drill records (61 §3.2, §5). Every declared degradation
 * mode needs an active runbook and at least one drill record. Dry-run by
 * default; `--execute --seed-runbooks` writes the default templates and
 * `--record --mode <id>` appends a drill record.
 *
 * Template bodies live in ./runbook-templates so other drills (degradation
 * drills) seed the same runbooks instead of duplicating them.
 */
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
