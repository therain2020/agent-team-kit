import type { JobSummary } from "@kit/job";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_FILTER,
  countJobsBySource,
  filterJobs,
  hasActiveJobFilter,
  jobDetailHref,
  jobSource,
  jobsHref,
  parseJobListFilter,
  triggerOptions,
} from "../lib/jobs-view";

function job(
  jobId: string,
  originKind: JobSummary["originKind"],
  extra: Partial<JobSummary> = {},
): JobSummary {
  return {
    jobId,
    kind: "packRun",
    goal: null,
    status: "succeeded",
    phase: null,
    runMode: "DRY_RUN",
    workflowId: `wf-${jobId}`,
    originKind,
    triggerId: null,
    triggerRunId: null,
    reactionRuleId: null,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T01:00:00.000Z",
    finishedAt: null,
    ...extra,
  };
}

describe("job source mapping (96 §5.5)", () => {
  it("reads the persisted origin kind", () => {
    for (const source of [
      "manual",
      "schedule",
      "event",
      "information",
      "cli",
      "web",
      "api",
      "autopilot",
      "unknown",
    ] as const) {
      expect(jobSource(job("j", source))).toBe(source);
    }
  });

  it("falls back to unknown for unrecognised historical values", () => {
    expect(jobSource(job("j", "whatever" as never))).toBe("unknown");
  });

  it("counts each source", () => {
    const counts = countJobsBySource([
      job("a", "manual"),
      job("b", "manual"),
      job("c", "schedule"),
      job("d", "unknown"),
    ]);
    expect(counts.manual).toBe(2);
    expect(counts.schedule).toBe(1);
    expect(counts.unknown).toBe(1);
    expect(counts.event).toBe(0);
  });
});

describe("job list filters", () => {
  const jobs = [
    job("run_1", "manual", { kind: "packRun" }),
    job("it_1", "schedule", { kind: "iteration", triggerId: "nightly" }),
    job("run_2", "event", { triggerId: "webhook" }),
    job("it_2", "schedule", { kind: "iteration", triggerId: "nightly" }),
  ];

  it("filters by source, kind and trigger together", () => {
    expect(
      filterJobs(jobs, { ...DEFAULT_JOB_FILTER, source: "schedule" }).map(
        (item) => item.jobId,
      ),
    ).toEqual(["it_1", "it_2"]);
    expect(
      filterJobs(jobs, { ...DEFAULT_JOB_FILTER, kind: "iteration" }).map(
        (item) => item.jobId,
      ),
    ).toEqual(["it_1", "it_2"]);
    expect(
      filterJobs(jobs, { ...DEFAULT_JOB_FILTER, triggerId: "nightly" }).map(
        (item) => item.jobId,
      ),
    ).toEqual(["it_1", "it_2"]);
    expect(
      filterJobs(jobs, {
        source: "schedule",
        kind: "packRun",
        triggerId: null,
      }),
    ).toEqual([]);
  });

  it("lists trigger options most used first", () => {
    expect(triggerOptions(jobs)).toEqual([
      { triggerId: "nightly", count: 2 },
      { triggerId: "webhook", count: 1 },
    ]);
  });

  it("parses and serialises shareable filters", () => {
    const filter = parseJobListFilter({
      source: "event",
      trigger: ["webhook"],
      kind: "packRun",
    });
    expect(filter).toEqual({
      source: "event",
      triggerId: "webhook",
      kind: "packRun",
    });
    expect(jobsHref(filter)).toBe(
      "/jobs?source=event&trigger=webhook&kind=packRun",
    );
    expect(hasActiveJobFilter(filter)).toBe(true);
    expect(jobsHref(DEFAULT_JOB_FILTER)).toBe("/jobs");
    expect(hasActiveJobFilter(DEFAULT_JOB_FILTER)).toBe(false);
  });

  it("ignores unknown query values", () => {
    expect(
      parseJobListFilter({ source: "bogus", kind: "nope", trigger: " " }),
    ).toEqual(DEFAULT_JOB_FILTER);
  });

  it("links detail into the existing job hub", () => {
    expect(jobDetailHref("it/1")).toBe("/world?run=it%2F1&tab=hub");
  });
});
