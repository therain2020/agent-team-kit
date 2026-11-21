import { JobsConsole } from "@/components/jobs/jobs-console";
import { type JobsSurfaceData, loadJobsSurface } from "@/lib/jobs";
import { parseJobListFilter } from "@/lib/jobs-view";

export const dynamic = "force-dynamic";

interface JobsSearchParams {
  source?: string | string[];
  trigger?: string | string[];
  kind?: string | string[];
}

/**
 * `/jobs` — the unified observation surface (96 §5.5, T5). Both pack runs and
 * iterations are read through `@kit/job.listJobs`; the origin column answers
 * "who started it" and the filter bar narrows by source/trigger.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<JobsSearchParams>;
}) {
  const initialFilter = parseJobListFilter(await searchParams);

  let data: JobsSurfaceData | null = null;
  let error: string | null = null;
  try {
    data = await loadJobsSurface();
  } catch (loadError) {
    error =
      loadError instanceof Error ? loadError.message : "failed to load jobs";
  }

  return (
    <JobsConsole
      initialJobs={data?.jobs ?? []}
      initialFilter={initialFilter}
      limit={data?.limit ?? 0}
      loadedAt={data?.loadedAt ?? null}
      error={error}
    />
  );
}
