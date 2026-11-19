#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  RPO_TARGET_MINUTES,
  RTO_TARGET_MINUTES,
  newRecoveryDrill,
} from "@kit/core";
import { initStore } from "@kit/store";

/**
 * RTO/RPO recovery drill (D-38: RTO 4h / RPO 6h, quarterly). This wrapper
 * REUSES the existing `smoke:recovery` script (`apps/runtime/src/temporal/
 * recovery-smoke.ts`) — it does not re-implement recovery — and records the
 * measured result. kitd rollback is exercised separately and referenced here.
 *
 * Dry-run by default. `--execute` runs `bun run smoke:recovery`, times the
 * wall-clock recovery as the RTO measurement, and records a RecoveryDrill.
 * RPO cannot be measured from the smoke script, so a passing record requires
 * an explicit `--rpo-minutes` from the operator's data-loss check.
 */
const execute = process.argv.includes("--execute");
const executedBy = argValue("--executed-by") ?? "operator:recovery-drill";
const rpoMinutes = numberArg("--rpo-minutes");
const rtoOverride = numberArg("--rto-minutes");
const kitdRollbackRef = argValue("--kitd-rollback-ref") ?? null;
const integrityFail = process.argv.includes("--integrity-fail");
const notes = argValue("--notes") ?? "quarterly recovery drill";

const store = await initStore();
try {
  if (!execute) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          reuses: "smoke:recovery",
          rtoTargetMinutes: RTO_TARGET_MINUTES,
          rpoTargetMinutes: RPO_TARGET_MINUTES,
          hint: "pass --execute to run smoke:recovery and record the result; add --rpo-minutes <n> for a passing RPO",
        },
        null,
        2,
      ),
    );
  } else {
    const startedAt = Date.now();
    const result = spawnSync("bun", ["run", "smoke:recovery"], {
      stdio: "inherit",
    });
    const elapsedMinutes = Math.ceil((Date.now() - startedAt) / 60_000);
    const measuredRtoMinutes = rtoOverride ?? elapsedMinutes;
    const integrityPass = result.status === 0 && !integrityFail;

    const drill = newRecoveryDrill({
      executedBy,
      measuredRtoMinutes,
      measuredRpoMinutes: rpoMinutes,
      integrityPass,
      kitdRollbackRef,
      notes,
    });
    await store.drills.recordRecoveryDrill(drill);

    console.log(
      JSON.stringify(
        {
          recorded: true,
          drillId: drill.drillId,
          outcome: drill.outcome,
          measuredRtoMinutes: drill.measuredRtoMinutes,
          measuredRpoMinutes: drill.measuredRpoMinutes,
          rtoTargetMinutes: drill.rtoTargetMinutes,
          rpoTargetMinutes: drill.rpoTargetMinutes,
          integrityPass: drill.integrityPass,
          kitdRollbackRef: drill.kitdRollbackRef,
          script: drill.script,
          smokeExitCode: result.status,
        },
        null,
        2,
      ),
    );

    if (drill.outcome === "fail") {
      process.exitCode = 1;
    }
  }
} finally {
  await store.close();
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function numberArg(name: string): number | null {
  const raw = argValue(name);
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
