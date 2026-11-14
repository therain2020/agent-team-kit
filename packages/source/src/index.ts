import {
  BUILTIN_SOURCES,
  buildEvidenceSet,
  fetchBuiltin,
  fetchFromDefinition,
  isBuiltinSource,
} from "./adapters";
import { loadInstalledSource } from "./registry";
import type { EvidenceError, EvidenceSet, RawSourceItem } from "./types";

export * from "./adapters";
export * from "./registry";
export * from "./types";

export async function fetchEvidence(
  options: {
    sources?: string[];
    limit?: number;
    root?: string;
  } = {},
): Promise<EvidenceSet> {
  const sources = options.sources ?? [...BUILTIN_SOURCES];
  const limit = Math.max(1, Math.min(options.limit ?? 5, 100));

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const items = await fetchOne(source, limit, options.root);
      return { source, items };
    }),
  );

  const items: RawSourceItem[] = [];
  const errors: EvidenceError[] = [];

  results.forEach((result, index) => {
    const source = sources[index] ?? "unknown";
    if (result.status === "fulfilled") {
      items.push(...result.value.items);
    } else {
      errors.push({
        source,
        message:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    }
  });

  return buildEvidenceSet(items, errors);
}

async function fetchOne(
  source: string,
  limit: number,
  root?: string,
): Promise<RawSourceItem[]> {
  if (isBuiltinSource(source)) {
    return fetchBuiltin(source, limit);
  }
  const installed = await loadInstalledSource(source, root);
  if (!installed) {
    throw new Error(`source not installed: ${source}`);
  }
  return fetchFromDefinition(installed.definition, limit);
}
