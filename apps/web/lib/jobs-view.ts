import type { RunOriginKind } from "@kit/core";
import type { JobKind, JobSummary } from "@kit/job";

/**
 * Pure derivations for the unified `/jobs` observation surface (96 §5.5, T5).
 *
 * A job is either a pack run or an iteration; its `originKind` answers "who
 * started it" (manual / schedule / event / information / CLI / web / API).
 * Filtering happens here so the server pre-filter and the client controls
 * agree and stay unit-testable.
 */

export const JOB_SOURCES = [
  "manual",
  "schedule",
  "event",
  "information",
  "cli",
  "web",
  "api",
  "autopilot",
  "unknown",
] as const;

export type JobSource = (typeof JOB_SOURCES)[number];
export type JobSourceFilter = JobSource | "all";
export type JobKindFilter = JobKind | "all";

export interface JobListFilter {
  source: JobSourceFilter;
  triggerId: string | null;
  kind: JobKindFilter;
}

export const DEFAULT_JOB_FILTER: JobListFilter = {
  source: "all",
  triggerId: null,
  kind: "all",
};

export interface TriggerJobCount {
  triggerId: string;
  count: number;
}

/** Historical rows read back as `unknown`; never write it from new code. */
export function jobSource(job: Pick<JobSummary, "originKind">): JobSource {
  const kind: RunOriginKind = job.originKind;
  return isJobSource(kind) ? kind : "unknown";
}

export function isJobSource(value: unknown): value is JobSource {
  return (
    typeof value === "string" &&
    (JOB_SOURCES as readonly string[]).includes(value)
  );
}

export function isJobSourceFilter(value: unknown): value is JobSourceFilter {
  return value === "all" || isJobSource(value);
}

export function isJobKindFilter(value: unknown): value is JobKindFilter {
  return value === "all" || value === "packRun" || value === "iteration";
}

export function matchesJobFilter(
  job: JobSummary,
  filter: JobListFilter,
): boolean {
  if (filter.kind !== "all" && job.kind !== filter.kind) {
    return false;
  }
  if (filter.source !== "all" && jobSource(job) !== filter.source) {
    return false;
  }
  if (filter.triggerId !== null && job.triggerId !== filter.triggerId) {
    return false;
  }
  return true;
}

export function filterJobs(
  jobs: readonly JobSummary[],
  filter: JobListFilter,
): JobSummary[] {
  return jobs.filter((job) => matchesJobFilter(job, filter));
}

/** Non-null trigger ids present in the list, most used first. */
export function triggerOptions(jobs: readonly JobSummary[]): TriggerJobCount[] {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (!job.triggerId) {
      continue;
    }
    counts.set(job.triggerId, (counts.get(job.triggerId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([triggerId, count]) => ({ triggerId, count }))
    .sort(
      (a, b) => b.count - a.count || a.triggerId.localeCompare(b.triggerId),
    );
}

/** Source → job count over the unfiltered list (drives filter hints). */
export function countJobsBySource(
  jobs: readonly JobSummary[],
): Record<JobSource, number> {
  const counts = Object.fromEntries(
    JOB_SOURCES.map((source) => [source, 0]),
  ) as Record<JobSource, number>;
  for (const job of jobs) {
    counts[jobSource(job)] += 1;
  }
  return counts;
}

type SearchParam = string | string[] | undefined;

function firstValue(value: SearchParam): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalises `/jobs?source=&trigger=&kind=` into a filter. Unknown values fall
 * back to "all" so stale bookmarks never render an empty list by accident.
 */
export function parseJobListFilter(input: {
  source?: SearchParam;
  trigger?: SearchParam;
  kind?: SearchParam;
}): JobListFilter {
  const source = firstValue(input.source);
  const triggerId = firstValue(input.trigger);
  const kind = firstValue(input.kind);
  return {
    source: isJobSourceFilter(source) ? source : "all",
    triggerId: triggerId ?? null,
    kind: isJobKindFilter(kind) ? kind : "all",
  };
}

/** Shareable `/jobs` link; default values are omitted. */
export function jobsHref(filter: JobListFilter): string {
  const parts: string[] = [];
  if (filter.source !== "all") {
    parts.push(`source=${encodeURIComponent(filter.source)}`);
  }
  if (filter.triggerId) {
    parts.push(`trigger=${encodeURIComponent(filter.triggerId)}`);
  }
  if (filter.kind !== "all") {
    parts.push(`kind=${encodeURIComponent(filter.kind)}`);
  }
  return parts.length === 0 ? "/jobs" : `/jobs?${parts.join("&")}`;
}

export function hasActiveJobFilter(filter: JobListFilter): boolean {
  return (
    filter.source !== "all" ||
    filter.triggerId !== null ||
    filter.kind !== "all"
  );
}

/** Detail stays on the existing job hub so `/jobs` never forks lifecycle UI. */
export function jobDetailHref(jobId: string): string {
  return `/world?run=${encodeURIComponent(jobId)}&tab=hub`;
}
