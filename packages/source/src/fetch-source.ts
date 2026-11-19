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
  const limit = Math.max(1, Math.min(options.limit ?? 5, 100));
  if (isBuiltinSource(source)) {
    return fetchBuiltin(source, limit);
  }
  const installed = await loadInstalledSource(source, options.root);
  if (!installed) {
    throw new Error(`source not installed: ${source}`);
  }
  return fetchFromDefinition(installed.definition, limit);
}
