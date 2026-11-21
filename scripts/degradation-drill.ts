#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DegradationContractError,
  type DegradationScope,
  type DegradedMode,
  activeModeFor,
  enterDegradedMode,
  evaluateQualityFloor,
  exitDegradedMode,
  isExecutionBlocked,
  newId,
  newRunbook,
  newRunbookDrill,
} from "@kit/core";
import { initStore } from "@kit/store";
import { RUNBOOK_TEMPLATES } from "./runbook-templates";

/**
 * Workspace-level and global degradation drills (61 §3.2, §3.4, §5).
 *
 * Each scope is exercised independently: enter the degraded mode, verify the
 * scope resolution and quality floor, attempt an exit without the quality
 * recheck (must be denied), exit with the recheck, then verify the persisted
 * recovery state. The global drill first proves that global degradation cannot
 * be entered without a security event, then enters read-only. A drill refuses
 * to overwrite an active degradation so it cannot mask a live incident.
 *
 * Records reuse the existing persistence: `degradation_state` +
 * `degradation_audit` for the state transition and `runbook_drills` (via
 * `newRunbookDrill` / `store.drills`) for the drill record. No parallel
 * recorder is introduced. Dry-run by default; `--execute` writes records.
 *
 * Run: `bun run drill:degradation --execute [--scope workspace|global|both]`
 */

type StoreHandle = Pick<
  Awaited<ReturnType<typeof initStore>>,
  "degradation" | "runbooks" | "drills"
>;

export interface DegradationDrillCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DegradationDrillReport {
  scope: DegradationScope;
  workspaceId: string;
  dependencyId: string;
  executedBy: string;
  modeId: string | null;
  runbookId: string | null;
  drillId: string | null;
  ok: boolean;
  checks: DegradationDrillCheck[];
}

export interface DegradationDrillOptions {
  /** Tenant under test for the workspace drill; also the runbook workspace. */
  workspaceId?: string;
  /** A peer tenant used to prove isolation / global coverage. */
  otherWorkspaceId?: string;
  /** Overrides the default dependency for whichever scope is running. */
  dependencyId?: string;
  executedBy?: string;
  notes?: string;
  /** Deterministic clock for tests; defaults to the current time. */
  now?: string;
}

export type DegradationDrillScope = DegradationScope | "both";

const DEFAULT_WORKSPACE = "drill-degradation";
const WORKSPACE_DEPENDENCY = "model.provider";
const GLOBAL_DEPENDENCY = "artifact_store";

interface ResolvedOptions {
  workspaceId: string;
  otherWorkspaceId: string;
  dependencyId: string;
  executedBy: string;
  notes: string;
  now: string;
}

/**
 * Runs the selected drills in order. "both" runs workspace first, then global,
 * each with its own mode, audit trail and drill record so the two remain
 * independent.
 */
export async function runDegradationDrills(
  store: StoreHandle,
  scope: DegradationDrillScope,
  options: DegradationDrillOptions = {},
): Promise<DegradationDrillReport[]> {
  const scopes: DegradationScope[] =
    scope === "both" ? ["workspace", "global"] : [scope];
  const reports: DegradationDrillReport[] = [];
  for (const item of scopes) {
    reports.push(await runDegradationDrill(store, item, options));
  }
  return reports;
}

export async function runDegradationDrill(
  store: StoreHandle,
  scope: DegradationScope,
  options: DegradationDrillOptions = {},
): Promise<DegradationDrillReport> {
  const resolved = resolveOptions(scope, options);
  const checks: DegradationDrillCheck[] = [];
  let mode: DegradedMode | null = null;

  try {
    if (scope === "global") {
      checks.push(assertGlobalRequiresSecurityEvent(resolved));
    }

    const scopeWorkspaceId = scope === "global" ? "*" : resolved.workspaceId;
    const existing = await store.degradation.get(scope, scopeWorkspaceId);
    if (existing?.status === "active") {
      throw new Error(
        `${scope} degradation is already active (${existing.modeId}); refusing to overwrite live state`,
      );
    }

    mode = enterDegradedMode({
      scope,
      workspaceId: scope === "workspace" ? resolved.workspaceId : undefined,
      // A security event drives global degradation into read-only (61 §3.2).
      kind: scope === "global" ? "read_only" : "degraded",
      triggers: [
        {
          dependencyId: resolved.dependencyId,
          reason: `${scope} degradation drill`,
        },
      ],
      behavior:
        scope === "global"
          ? "drill: global read-only after a security event; new execution is paused, inspection and audit stay available"
          : "drill: degraded execution with the declared quality floor; exit requires a passing quality recheck",
      exitCriteria: { minStableMinutes: 0, requireQualityRecheck: true },
      securityEvent: scope === "global",
      actor: resolved.executedBy,
      now: resolved.now,
    });

    await store.degradation.upsert(recordFromMode(mode));
    await appendAudit(store, "enter", mode, resolved.executedBy, {
      reason: "degradation drill",
      securityEvent: scope === "global",
    });

    checks.push(...entryChecks(mode, resolved));
    checks.push(qualityGateCheck(mode));
    checks.push(recheckGateCheck(mode, resolved));
    checks.push(...(await exitAndVerify(store, mode, resolved)));
  } catch (error) {
    checks.push({
      id: "drill_execution",
      ok: false,
      detail: `drill aborted: ${errorMessage(error)}`,
    });
  }

  const beforeRecord = checks.every((check) => check.ok);
  let runbookId: string | null = null;
  let drillId: string | null = null;
  if (mode) {
    try {
      runbookId = await ensureRunbook(store, resolved);
      const drill = newRunbookDrill({
        workspaceId: resolved.workspaceId,
        runbookId,
        modeId: resolved.dependencyId,
        executedBy: resolved.executedBy,
        outcome: beforeRecord ? "pass" : "fail",
        notes: `${resolved.notes} scope=${mode.scope} mode=${mode.modeId}`,
        now: resolved.now,
      });
      await store.drills.recordRunbookDrill(drill);
      drillId = drill.drillId;
      const persisted = (
        await store.drills.listRunbookDrillsByWorkspace(
          resolved.workspaceId,
          100,
        )
      ).some((item) => item.drillId === drill.drillId);
      checks.push({
        id: "drill_recorded",
        ok: persisted,
        detail: persisted
          ? `runbook drill ${drill.drillId} persisted for ${resolved.dependencyId}`
          : "drill record was not persisted",
      });
    } catch (error) {
      checks.push({
        id: "drill_recorded",
        ok: false,
        detail: `could not record drill: ${errorMessage(error)}`,
      });
    }
  } else {
    checks.push({
      id: "drill_recorded",
      ok: false,
      detail: "no degraded mode was entered; nothing to record",
    });
  }

  return {
    scope,
    workspaceId: resolved.workspaceId,
    dependencyId: resolved.dependencyId,
    executedBy: resolved.executedBy,
    modeId: mode?.modeId ?? null,
    runbookId,
    drillId,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function resolveOptions(
  scope: DegradationScope,
  options: DegradationDrillOptions,
): ResolvedOptions {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE;
  return {
    workspaceId,
    otherWorkspaceId: options.otherWorkspaceId ?? `${workspaceId}-peer`,
    dependencyId:
      options.dependencyId ??
      (scope === "workspace" ? WORKSPACE_DEPENDENCY : GLOBAL_DEPENDENCY),
    executedBy: options.executedBy ?? "operator:degradation-drill",
    notes: options.notes ?? "degradation drill",
    now: options.now ?? new Date().toISOString(),
  };
}

function assertGlobalRequiresSecurityEvent(
  resolved: ResolvedOptions,
): DegradationDrillCheck {
  try {
    enterDegradedMode({
      scope: "global",
      kind: "degraded",
      triggers: [
        {
          dependencyId: resolved.dependencyId,
          reason: "drill: global without a security event",
        },
      ],
      behavior: "must never be persisted",
      actor: resolved.executedBy,
      now: resolved.now,
    });
    return {
      id: "global_requires_security_event",
      ok: false,
      detail: "global degradation was entered without a security event",
    };
  } catch (error) {
    const rejected =
      error instanceof DegradationContractError &&
      error.code === "global_requires_security_event";
    return {
      id: "global_requires_security_event",
      ok: rejected,
      detail: rejected
        ? "global entry rejected without a security event"
        : `unexpected error rejecting global entry: ${errorMessage(error)}`,
    };
  }
}

function entryChecks(
  mode: DegradedMode,
  resolved: ResolvedOptions,
): DegradationDrillCheck[] {
  const checks: DegradationDrillCheck[] = [];
  const active = activeModeFor([mode], resolved.workspaceId);
  checks.push({
    id: "mode_active",
    ok: active?.modeId === mode.modeId,
    detail:
      active?.modeId === mode.modeId
        ? `${mode.scope} mode resolves for ${resolved.workspaceId}`
        : `${mode.scope} mode does not resolve for ${resolved.workspaceId}`,
  });

  if (mode.scope === "workspace") {
    const leaked = activeModeFor([mode], resolved.otherWorkspaceId);
    checks.push({
      id: "workspace_isolation",
      ok: leaked === null,
      detail:
        leaked === null
          ? `peer ${resolved.otherWorkspaceId} is unaffected`
          : `workspace mode leaked into ${resolved.otherWorkspaceId}`,
    });
  } else {
    const governed = activeModeFor([mode], resolved.otherWorkspaceId);
    checks.push({
      id: "global_governs_all",
      ok: governed?.modeId === mode.modeId,
      detail:
        governed?.modeId === mode.modeId
          ? `global mode governs ${resolved.otherWorkspaceId}`
          : `global mode does not govern ${resolved.otherWorkspaceId}`,
    });
    checks.push({
      id: "global_read_only_blocks_execution",
      ok: isExecutionBlocked(mode),
      detail: isExecutionBlocked(mode)
        ? "global read-only mode blocks new execution"
        : "global mode does not block new execution",
    });
  }

  return checks;
}

function qualityGateCheck(mode: DegradedMode): DegradationDrillCheck {
  const accepted = evaluateQualityFloor(
    "Drill output that contains no placeholders and satisfies the floor.",
    mode.qualityFloor,
  );
  const rejected = evaluateQualityFloor("TODO {{draft}}", mode.qualityFloor);
  const ok = accepted.pass && !rejected.pass;
  return {
    id: "quality_floor_gate",
    ok,
    detail: ok
      ? "compliant output passes and placeholder output is blocked"
      : "quality floor did not accept/reject the drill samples as expected",
  };
}

function recheckGateCheck(
  mode: DegradedMode,
  resolved: ResolvedOptions,
): DegradationDrillCheck {
  const denied = exitDegradedMode(mode, {
    actor: resolved.executedBy,
    reason: "drill: skip quality recheck",
    now: resolved.now,
    qualityRecheck: { pass: false },
  });
  return {
    id: "exit_requires_quality_recheck",
    ok: !denied.ok,
    detail: !denied.ok
      ? "exit without a passing quality recheck was denied"
      : "exit succeeded without a passing quality recheck",
  };
}

async function exitAndVerify(
  store: StoreHandle,
  mode: DegradedMode,
  resolved: ResolvedOptions,
): Promise<DegradationDrillCheck[]> {
  const checks: DegradationDrillCheck[] = [];
  const scopeWorkspaceId = mode.scope === "global" ? "*" : mode.workspaceId;
  const reason = "degradation drill complete";

  const exit = exitDegradedMode(mode, {
    actor: resolved.executedBy,
    reason,
    now: resolved.now,
    qualityRecheck: { pass: true },
  });
  checks.push({
    id: "exit_with_quality_recheck",
    ok: exit.ok,
    detail: exit.ok
      ? "exit accepted with a passing quality recheck"
      : `exit denied: ${exit.reasons.join("; ")}`,
  });
  if (!exit.ok) {
    return checks;
  }

  const exitedAt = exit.mode.exitedAt ?? resolved.now;
  const marked = await store.degradation.markExited(
    mode.scope,
    scopeWorkspaceId,
    exitedAt,
    reason,
  );
  checks.push({
    id: "recovery_state_exited",
    ok: marked,
    detail: marked
      ? "stored mode marked exited"
      : "active mode could not be marked exited",
  });

  await appendAudit(store, "exit", mode, resolved.executedBy, {
    reason,
    qualityRecheck: true,
  });

  const stored = await store.degradation.get(mode.scope, scopeWorkspaceId);
  checks.push({
    id: "recovery_persisted",
    ok: stored?.status === "exited",
    detail:
      stored?.status === "exited"
        ? "persisted mode reports exited"
        : `persisted mode reports ${stored?.status ?? "missing"}`,
  });

  const stillActive = (await store.degradation.listActive()).some(
    (item) => item.modeId === mode.modeId,
  );
  checks.push({
    id: "recovery_no_active_mode",
    ok: !stillActive,
    detail: stillActive
      ? "drill mode is still listed as active"
      : "drill mode is no longer active",
  });

  const audits = await store.degradation.listAudit(200);
  const actions = new Set(
    audits
      .filter((audit) => audit.modeId === mode.modeId)
      .map((audit) => audit.action),
  );
  const auditOk = actions.has("enter") && actions.has("exit");
  checks.push({
    id: "audit_trail",
    ok: auditOk,
    detail: auditOk
      ? "enter and exit audit records are present"
      : "enter/exit audit records are incomplete",
  });

  return checks;
}

async function ensureRunbook(
  store: StoreHandle,
  resolved: ResolvedOptions,
): Promise<string> {
  const [existing] = await store.runbooks.list(resolved.workspaceId, {
    modeId: resolved.dependencyId,
    status: "active",
  });
  if (existing) {
    return existing.runbookId;
  }

  const template = RUNBOOK_TEMPLATES[resolved.dependencyId];
  if (!template) {
    throw new Error(`no runbook template for ${resolved.dependencyId}`);
  }
  const runbook = newRunbook({
    workspaceId: resolved.workspaceId,
    modeId: resolved.dependencyId,
    trigger: template.trigger,
    steps: template.steps,
    verification: template.verification,
    owner: resolved.executedBy,
    now: resolved.now,
  });
  await store.runbooks.upsert(runbook);
  return runbook.runbookId;
}

function recordFromMode(mode: DegradedMode) {
  return {
    ...mode,
    exitedAt: mode.exitedAt ?? null,
    exitReason: mode.exitReason ?? null,
  };
}

async function appendAudit(
  store: StoreHandle,
  action: "enter" | "exit" | "blocked",
  mode: DegradedMode,
  actor: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await store.degradation.appendAudit({
    auditId: newId("daud"),
    occurredAt: new Date().toISOString(),
    actor,
    action,
    scope: mode.scope,
    workspaceId: mode.scope === "global" ? "*" : mode.workspaceId,
    modeId: mode.modeId,
    detail,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseScope(raw: string): DegradationDrillScope {
  if (raw === "both" || raw === "workspace" || raw === "global") {
    return raw;
  }
  console.error("--scope must be one of workspace, global, both");
  process.exit(2);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function runCli(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const scope = parseScope(argValue("--scope") ?? "both");
  const options: DegradationDrillOptions = {
    ...(argValue("--workspace")
      ? { workspaceId: argValue("--workspace") }
      : {}),
    ...(argValue("--executed-by")
      ? { executedBy: argValue("--executed-by") }
      : {}),
    ...(argValue("--notes") ? { notes: argValue("--notes") } : {}),
  };

  if (!execute) {
    const scopes: DegradationScope[] =
      scope === "both" ? ["workspace", "global"] : [scope];
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          planned: scopes.map((item) => {
            const resolved = resolveOptions(item, options);
            return {
              scope: item,
              workspaceId: item === "workspace" ? resolved.workspaceId : "*",
              runbookWorkspaceId: resolved.workspaceId,
              dependencyId: resolved.dependencyId,
              requiresSecurityEvent: item === "global",
            };
          }),
          hint: "pass --execute to run the drills and persist degradation + drill records",
        },
        null,
        2,
      ),
    );
    return;
  }

  const store = await initStore();
  try {
    const reports = await runDegradationDrills(store, scope, options);
    console.log(JSON.stringify({ dryRun: false, reports }, null, 2));
    if (reports.some((report) => !report.ok)) {
      process.exitCode = 1;
    }
  } finally {
    await store.close();
  }
}

const invokedPath = process.argv[1];
const isMain =
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (invokedPath !== undefined &&
    path.resolve(invokedPath) === fileURLToPath(import.meta.url));

if (isMain) {
  await runCli();
}
