import {
  type Incident,
  type PostmortemState,
  type RecoveryDrill,
  type Runbook,
  type RunbookCoverage,
  isRecoveryDrillDue,
  postmortemState,
  runbookCoverage,
} from "@kit/core";
import { ensureStoreSchema, getStore } from "./store";

export const DEFAULT_WORKSPACE = "default";

export interface IncidentView extends Incident {
  postmortemState: PostmortemState;
}

export interface IncidentOverview {
  workspaceId: string;
  incidents: IncidentView[];
  runbooks: Runbook[];
  coverage: RunbookCoverage;
  recoveryDrills: RecoveryDrill[];
  /** True when no recovery drill has run within the quarterly cadence. */
  recoveryDrillDue: boolean;
}

/**
 * Read-only incident/runbook surface (61 §3.4, §5). Postmortem cadence and
 * runbook coverage are computed against the current clock so overdue drafts
 * and undrilled modes are visible without a separate job.
 */
export async function loadIncidentOverview(
  workspaceId: string = DEFAULT_WORKSPACE,
): Promise<IncidentOverview> {
  await ensureStoreSchema();
  const store = getStore();
  const now = new Date().toISOString();

  const [incidents, runbooks, drills, recoveryDrills] = await Promise.all([
    store.incidents.list(workspaceId, { limit: 50 }),
    store.runbooks.list(workspaceId),
    store.drills.listRunbookDrillsByWorkspace(workspaceId),
    store.drills.listRecoveryDrills(20),
  ]);

  return {
    workspaceId,
    incidents: incidents.map((incident) => ({
      ...incident,
      postmortemState: postmortemState(incident, now),
    })),
    runbooks,
    coverage: runbookCoverage(runbooks, drills),
    recoveryDrills,
    recoveryDrillDue: isRecoveryDrillDue(
      recoveryDrills[0]?.executedAt ?? null,
      now,
    ),
  };
}
