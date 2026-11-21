"use client";

import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useStatusLabel } from "@/lib/iteration-labels";
import {
  DEFAULT_JOB_FILTER,
  JOB_SOURCES,
  type JobKindFilter,
  type JobListFilter,
  type JobSource,
  type JobSourceFilter,
  countJobsBySource,
  filterJobs,
  hasActiveJobFilter,
  jobDetailHref,
  jobSource,
  jobsHref,
  triggerOptions,
} from "@/lib/jobs-view";
import { timeAgo } from "@/lib/utils";
import type { JobSummary } from "@kit/job";
import { ArrowRight, Inbox, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

export interface JobsConsoleProps {
  initialJobs: JobSummary[];
  initialFilter: JobListFilter;
  limit: number;
  loadedAt: string | null;
  error: string | null;
}

/**
 * `/jobs` observation surface (96 §5.5): pack runs and iterations in one list,
 * with the origin column and source/trigger filters. Rows link into the job
 * hub so detail stays on the existing lifecycle view.
 */
export function JobsConsole({
  initialJobs,
  initialFilter,
  limit,
  loadedAt,
  error,
}: JobsConsoleProps) {
  const t = useTranslations("jobs");
  const statusLabel = useStatusLabel();
  const locale = useLocale();
  const router = useRouter();
  const [filter, setFilter] = useState<JobListFilter>(initialFilter);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const counts = useMemo(() => countJobsBySource(initialJobs), [initialJobs]);
  const triggers = useMemo(() => triggerOptions(initialJobs), [initialJobs]);
  const filtered = useMemo(
    () => filterJobs(initialJobs, filter),
    [initialJobs, filter],
  );

  function update(next: JobListFilter) {
    setFilter(next);
    router.replace(jobsHref(next), { scroll: false });
  }

  function updatePart(patch: Partial<JobListFilter>) {
    update({ ...filter, ...patch });
  }

  if (error) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("title")} description={t("description")} />
        <Card className="border-red-500/30 bg-red-500/5 p-6 text-center">
          <p className="text-sm text-red-200">{t("errorTitle")}</p>
          <p className="mt-1 font-mono text-[11px] text-red-300/70">{error}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => router.refresh()}
          >
            <RefreshCw className="size-3.5" />
            {t("reload")}
          </Button>
        </Card>
      </div>
    );
  }

  const selectedTriggerMissing =
    filter.triggerId !== null &&
    !triggers.some((option) => option.triggerId === filter.triggerId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/triggers">{t("openTriggers")}</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/workshop">{t("startRun")}</Link>
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <span className="flex items-center gap-1.5 pb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          <SlidersHorizontal className="size-3" />
          {t("filters")}
        </span>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
          {t("source")}
          <select
            aria-label={t("source")}
            value={filter.source}
            onChange={(event) =>
              updatePart({ source: event.target.value as JobSourceFilter })
            }
            className="h-7 rounded border border-border bg-zinc-950 px-2 font-mono text-[11px] text-zinc-200 outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
          >
            <option value="all">{t("allSources")}</option>
            {JOB_SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`source_${source}`)}
                {(counts[source] ?? 0) > 0 ? ` (${counts[source]})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
          {t("trigger")}
          <select
            aria-label={t("trigger")}
            value={filter.triggerId ?? ""}
            onChange={(event) =>
              updatePart({ triggerId: event.target.value || null })
            }
            className="h-7 max-w-48 rounded border border-border bg-zinc-950 px-2 font-mono text-[11px] text-zinc-200 outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
          >
            <option value="">{t("allTriggers")}</option>
            {triggers.map((option) => (
              <option key={option.triggerId} value={option.triggerId}>
                {option.triggerId} ({option.count})
              </option>
            ))}
            {selectedTriggerMissing && filter.triggerId ? (
              <option value={filter.triggerId}>{filter.triggerId}</option>
            ) : null}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
          {t("kind")}
          <select
            aria-label={t("kind")}
            value={filter.kind}
            onChange={(event) =>
              updatePart({ kind: event.target.value as JobKindFilter })
            }
            className="h-7 rounded border border-border bg-zinc-950 px-2 font-mono text-[11px] text-zinc-200 outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
          >
            <option value="all">{t("allKinds")}</option>
            <option value="packRun">{t("kindRun")}</option>
            <option value="iteration">{t("kindIteration")}</option>
          </select>
        </label>
        {hasActiveJobFilter(filter) ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update(DEFAULT_JOB_FILTER)}
          >
            {t("clearFilters")}
          </Button>
        ) : null}
        <span className="ml-auto pb-1 font-mono text-[10px] text-zinc-600">
          {t("count", {
            shown: filtered.length,
            total: initialJobs.length,
          })}
          {loadedAt
            ? ` · ${t("loaded", { time: timeAgo(loadedAt, locale, now) })}`
            : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <Card className="flex flex-col items-center justify-center border-dashed px-4 py-12 text-center">
          <Inbox className="size-6 text-zinc-600" />
          <p className="mt-2 text-sm text-zinc-300">
            {initialJobs.length === 0 ? t("empty") : t("emptyFiltered")}
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {initialJobs.length === 0 ? t("emptyHint") : t("emptyFilteredHint")}
          </p>
          {hasActiveJobFilter(filter) ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => update(DEFAULT_JOB_FILTER)}
            >
              {t("clearFilters")}
            </Button>
          ) : null}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_auto_auto] gap-3 border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500 md:grid">
            <span>{t("job")}</span>
            <span>{t("source")}</span>
            <span>{t("trigger")}</span>
            <span>{t("updated")}</span>
            <span className="text-right">{t("open")}</span>
          </div>
          <ul className="divide-y divide-border">
            {filtered.map((job) => {
              const source = jobSource(job);
              return (
                <li
                  key={`${job.kind}:${job.jobId}`}
                  className="flex items-stretch gap-2 px-3 py-2 transition-colors hover:bg-accent/40"
                >
                  <Link
                    href={jobDetailHref(job.jobId)}
                    className="grid min-w-0 flex-1 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_auto] md:items-center md:gap-3"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-mono text-[12px] text-zinc-200">
                          {job.jobId}
                        </span>
                        <Badge variant="outline">
                          {t(
                            job.kind === "iteration"
                              ? "kindIteration"
                              : "kindRun",
                          )}
                        </Badge>
                        <Badge variant={statusVariant(job.status)}>
                          {statusLabel(job.status)}
                        </Badge>
                        {job.runMode === "LIVE" ? (
                          <Badge variant="danger">LIVE</Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-zinc-500">
                        {job.workflowId ?? job.phase ?? t("noWorkflow")}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge variant={sourceVariant(source)}>
                        {t(`source_${source}`)}
                      </Badge>
                    </span>
                    <span className="truncate font-mono text-[10px] text-zinc-500">
                      {job.triggerId ?? t("noTrigger")}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500 md:text-right">
                      {timeAgo(job.updatedAt, locale, now)}
                    </span>
                  </Link>
                  {job.triggerId ? (
                    <Link
                      href={`/triggers#trigger-${encodeURIComponent(job.triggerId)}`}
                      className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
                      title={t("openTrigger")}
                    >
                      <ArrowRight className="size-3" />
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-zinc-600">
            {t("limitHint", { limit })}
          </p>
        </Card>
      )}
    </div>
  );
}

function sourceVariant(source: JobSource) {
  if (source === "schedule" || source === "autopilot") {
    return "info" as const;
  }
  if (source === "event" || source === "information") {
    return "violet" as const;
  }
  if (source === "manual") {
    return "warning" as const;
  }
  return "outline" as const;
}

function statusVariant(status: string) {
  if (status === "succeeded") {
    return "success" as const;
  }
  if (status === "failed") {
    return "danger" as const;
  }
  if (status === "paused") {
    return "warning" as const;
  }
  if (status === "running") {
    return "info" as const;
  }
  return "outline" as const;
}
