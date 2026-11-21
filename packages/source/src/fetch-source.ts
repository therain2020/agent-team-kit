import { fetchBuiltin, fetchFromDefinition, isBuiltinSource } from "./adapters";
import { loadInstalledSource } from "./registry";
import type { RawSourceItem } from "./types";

export interface FetchSourceOptions {
  limit?: number;
  root?: string;
}

/**
 * Fetch items from a single source, whether builtin or an installed
 * declarative manifest. Kept separate from {@link fetchEvidence} so the
 * continuous collector can measure and isolate each source independently.
 */
export async function fetchSource(
  source: string,
  options: FetchSourceOptions = {},
): Promise<RawSourceItem[]> {
  const requested = Math.max(1, Math.min(options.limit ?? 5, 100));
  if (isBuiltinSource(source)) {
    return fetchBuiltin(source, requested);
  }
  const installed = await loadInstalledSource(source, options.root);
  if (!installed) {
    throw new Error(`source not installed: ${source}`);
  }
  // Retirement stops collection but keeps the manifest and fetched history
  // (98 §3.4, 10 §3.6); an explicit observer edit can revive it.
  if (installed.meta.retiredAt) {
    throw new Error(
      `source retired: ${source} (${installed.meta.retirement?.reason ?? "no reason"})`,
    );
  }
  // The observer item budget is a hard per-run cap; cost budgets are recorded
  // in meta and enforced by the cost ledger.
  const limit = installed.meta.budget
    ? Math.min(requested, installed.meta.budget.maxItemsPerRun)
    : requested;
  return fetchFromDefinition(installed.definition, Math.max(1, limit));
}
