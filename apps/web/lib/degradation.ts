import {
  type DegradationAuditAction,
  type DegradationScope,
  type DegradedMode,
  type DegradedModeKind,
  activeModeFor,
  enterDegradedMode,
  exitDegradedMode,
  isExecutionBlocked,
  newId,
} from "@kit/core";
import type { DegradationStateRecord } from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

export const DEFAULT_WORKSPACE = "default";

export interface EnterModeInput {
  scope: DegradationScope;
  workspaceId?: string;
  kind: DegradedModeKind;
  dependencyId: string;
  reason: string;
  minChars?: number;
  minStableMinutes?: number;
  securityEvent?: boolean;
}

export interface ExitModeInput {
  scope: DegradationScope;
  workspaceId?: string;
  reason: string;
  qualityRecheck?: boolean;
  summary?: string;
}

export interface ExitModeResult {
  ok: boolean;
  reasons: string[];
  mode: DegradedMode | null;
}

export function toDegradedMode(record: DegradationStateRecord): DegradedMode {
  return {
    ...record,
    exitedAt: record.exitedAt ?? undefined,
    exitReason: record.exitReason ?? undefined,
  };
}

export async function loadActiveModes(): Promise<DegradedMode[]> {
  await ensureStoreSchema();
  const records = await getStore().degradation.listActive();
  return records.map(toDegradedMode);
}

export async function loadDegradationAudit(limit = 50) {
  await ensureStoreSchema();
  return getStore().degradation.listAudit(limit);
}

export async function loadModeForWorkspace(
  workspaceId: string,
): Promise<DegradedMode | null> {
  const modes = await loadActiveModes();
  return activeModeFor(modes, workspaceId);
}

export function modeBlocksExecution(mode: DegradedMode | null): boolean {
  return isExecutionBlocked(mode);
}

/** Admission check for HTTP entry points that start new work. */
export async function readOnlyBlockMessage(
  workspaceId = DEFAULT_WORKSPACE,
): Promise<string | null> {
  const mode = await loadModeForWorkspace(workspaceId);
  return mode && modeBlocksExecution(mode)
    ? `workspace ${workspaceId} is in read-only mode (${mode.modeId})`
    : null;
}

export async function enterMode(input: EnterModeInput): Promise<DegradedMode> {
  await ensureStoreSchema();
  const mode = enterDegradedMode({
    scope: input.scope,
    workspaceId: input.workspaceId,
    kind: input.kind,
    triggers: [{ dependencyId: input.dependencyId, reason: input.reason }],
    behavior:
      input.kind === "read_only"
        ? "New executions are paused; glass-box inspection and audit remain available."
        : "Degraded execution with an explicit quality floor; delivery requires floor compliance.",
    ...(input.minChars !== undefined
      ? {
          qualityFloor: {
            minChars: input.minChars,
            forbiddenPatterns: ["TODO", "{{"],
          },
        }
      : {}),
    ...(input.minStableMinutes !== undefined
      ? {
          exitCriteria: {
            minStableMinutes: input.minStableMinutes,
            requireQualityRecheck: true,
          },
        }
      : {}),
    securityEvent: input.securityEvent ?? false,
    actor: "web-console",
  });

  const store = getStore();
  await store.degradation.upsert({
    ...mode,
    exitedAt: mode.exitedAt ?? null,
    exitReason: mode.exitReason ?? null,
  });
  await appendAudit("enter", mode, {
    reason: input.reason,
    dependencyId: input.dependencyId,
    securityEvent: input.securityEvent ?? false,
  });
  return mode;
}

export async function exitMode(input: ExitModeInput): Promise<ExitModeResult> {
  await ensureStoreSchema();
  const store = getStore();
  const workspaceId =
    input.scope === "global" ? "*" : (input.workspaceId ?? DEFAULT_WORKSPACE);

  const record = await store.degradation.get(input.scope, workspaceId);
  if (!record) {
    return {
      ok: false,
      reasons: ["no mode is stored for this scope"],
      mode: null,
    };
  }

  const result = exitDegradedMode(toDegradedMode(record), {
    actor: "web-console",
    reason: input.reason,
    qualityRecheck: {
      pass: input.qualityRecheck === true,
      ...(input.summary ? { summary: input.summary } : {}),
    },
  });
  if (!result.ok) {
    return { ok: false, reasons: result.reasons, mode: result.mode };
  }

  const exited = await store.degradation.markExited(
    input.scope,
    workspaceId,
    result.mode.exitedAt ?? new Date().toISOString(),
    input.reason,
  );
  if (!exited) {
    return {
      ok: false,
      reasons: ["mode changed concurrently; reload and retry"],
      mode: result.mode,
    };
  }
  await appendAudit("exit", result.mode, {
    reason: input.reason,
    qualityRecheck: input.qualityRecheck === true,
  });
  return { ok: true, reasons: [], mode: result.mode };
}

async function appendAudit(
  action: DegradationAuditAction,
  mode: DegradedMode,
  detail: Record<string, unknown>,
): Promise<void> {
  await getStore().degradation.appendAudit({
    auditId: newId("daud"),
    occurredAt: new Date().toISOString(),
    actor: "web-console",
    action,
    scope: mode.scope,
    workspaceId: mode.scope === "global" ? "*" : mode.workspaceId,
    modeId: mode.modeId,
    detail,
  });
}
