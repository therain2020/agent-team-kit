import { type JobSummary, listJobs } from "@kit/job";
import { ensureStoreSchema, getStore } from "./store";

/**
 * Server read path for `/jobs` (96 §5.5, T5). `@kit/job.listJobs` already
 * unions pack runs and iterations on the same origin columns, so the console
 * reads one ordered list instead of joining two legacy pages.
 */
export const JOBS_LIST_LIMIT = 100;

export interface JobsSurfaceData {
  jobs: JobSummary[];
  /** Latest 100 rows; the copy states the cap so the list is not misleading. */
  limit: number;
  loadedAt: string;
}

export async function loadJobsSurface(): Promise<JobsSurfaceData> {
  await ensureStoreSchema();
  const jobs = await listJobs(getStore(), { limit: JOBS_LIST_LIMIT });
  return { jobs, limit: JOBS_LIST_LIMIT, loadedAt: new Date().toISOString() };
}
