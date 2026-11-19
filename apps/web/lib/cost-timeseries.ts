import { microToCny } from "@kit/core";
import { type CostTimeseriesQuery, costTimeseries } from "@kit/store";
import { ensureStoreSchema, getStore } from "./store";

export interface CostTimeseriesPoint {
  bucket: string;
  runId: string;
  stageId: string | null;
  agentId: string | null;
  cny: number;
  tokens: number;
}

export type CostTimeseriesOptions = Omit<CostTimeseriesQuery, "workspaceId"> & {
  workspaceId?: string;
};

/**
 * Chart-ready read model for the Atlas cost river and budget curve. Amounts are
 * converted from integer micro-CNY to CNY; no UI consumes this yet.
 */
export async function loadCostTimeseries(
  options: CostTimeseriesOptions = {},
): Promise<CostTimeseriesPoint[]> {
  await ensureStoreSchema();
  const rows = await costTimeseries(getStore(), {
    ...options,
    workspaceId: options.workspaceId ?? "default",
  });
  return rows.map((row) => ({
    bucket: row.bucket,
    runId: row.runId,
    stageId: row.stageId,
    agentId: row.agentId,
    cny: microToCny(row.cnyMicro),
    tokens: row.tokens,
  }));
}
