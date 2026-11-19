import { BUILTIN_SOURCES, buildEvidenceSet } from "./adapters";
import { fetchSource } from "./fetch-source";
import type { EvidenceError, EvidenceSet, RawSourceItem } from "./types";

export * from "./adapters";
export * from "./collect";
export * from "./fetch-source";
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
      const items = await fetchSource(source, { limit, root: options.root });
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
