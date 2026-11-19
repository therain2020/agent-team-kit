import { loadQuotaPolicies } from "@kit/core";
import {
  type CapacityOverview,
  type QueueCapacityMetrics,
  summarizeCapacity,
  toCapacityRow,
  toQuotaView,
} from "./capacity-math";
import { ensureStoreSchema, getStore } from "./store";

/** Capacity read model for the `/ops` capacity section (60 §3.5, issue #21). */
export * from "./capacity-math";

export async function loadCapacityOverview(
  workspaceId = "default",
): Promise<CapacityOverview> {
  await ensureStoreSchema();
  const store = getStore();
  const rows = await store.sql<
    Array<{
      request_id: string;
      workspace_id: string;
      status: string;
      created_at: string;
      claimed_at: string | null;
      payload: string;
    }>
  >`
    SELECT request_id, workspace_id, status, created_at, claimed_at, payload
    FROM run_requests
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const now = Date.now();
  const queue: QueueCapacityMetrics = summarizeCapacity(
    rows.map((row) => toCapacityRow(row)),
    now,
  );
  const quotas = loadQuotaPolicies().map((quota) => toQuotaView(quota, queue));
  return {
    workspaceId,
    generatedAt: new Date(now).toISOString(),
    queue,
    quotas,
    empty: rows.length === 0,
  };
}
