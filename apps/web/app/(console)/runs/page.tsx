import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { RunModeBadge, RunStatusBadge } from "@/components/kit/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { loadRunSummaries } from "@/lib/runs";
import { cn, formatCny, formatDuration, timeAgo } from "@/lib/utils";
import { ArrowRight, Play } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

const FILTERS = [
  { id: "all", labelKey: "filterAll" },
  { id: "running", labelKey: "filterRunning" },
  { id: "paused", labelKey: "filterPaused" },
  { id: "succeeded", labelKey: "filterSucceeded" },
  { id: "failed", labelKey: "filterFailed" },
];

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = "all" } = await searchParams;
  const t = await getTranslations("runs");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const summaries = await loadRunSummaries(50);
  const filtered =
    status === "all"
      ? summaries
      : summaries.filter((item) => item.run.status === status);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        description={t("description", { count: summaries.length })}
        actions={
          <Button asChild size="sm">
            <Link href="/packs">
              <Play className="size-3.5" />
              {common("startRun")}
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((filter) => (
          <Link
            key={filter.id}
            href={filter.id === "all" ? "/runs" : `/runs?status=${filter.id}`}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-zinc-200",
              status === filter.id && "bg-accent text-zinc-100",
            )}
          >
            {t(filter.labelKey)}
          </Link>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Play}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/packs">{t("browsePacks")}</Link>
            </Button>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_5rem_4.5rem] gap-3 border-b border-border px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500 lg:grid-cols-[minmax(0,1fr)_7rem_7rem_7rem_6rem_5rem]">
            <span>{common("run")}</span>
            <span>{common("status")}</span>
            <span className="hidden lg:block">{common("workflow")}</span>
            <span>{common("mode")}</span>
            <span className="text-right">{common("cost")}</span>
            <span className="text-right">{common("age")}</span>
          </div>
          <ul className="divide-y divide-border">
            {filtered.map(({ run, costCny, artifactCount }) => (
              <li key={run.runId}>
                <Link
                  href={`/runs/${encodeURIComponent(run.runId)}`}
                  className="grid grid-cols-[minmax(0,1fr)_6rem_6rem_5rem_4.5rem] items-center gap-3 px-4 py-3 text-xs transition-colors hover:bg-accent/60 lg:grid-cols-[minmax(0,1fr)_7rem_7rem_7rem_6rem_5rem]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[13px] text-zinc-200">
                      {run.runId}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                      {common("artifactCount", { count: artifactCount })} ·{" "}
                      {formatDuration(run.createdAt, run.updatedAt, locale)} ·{" "}
                      {timeAgo(run.createdAt, locale)}
                    </p>
                  </div>
                  <span>
                    <RunStatusBadge status={run.status} />
                  </span>
                  <span className="hidden truncate font-mono text-[11px] text-zinc-400 lg:block">
                    {run.workflowId}
                  </span>
                  <span>
                    <RunModeBadge mode={run.runMode} />
                  </span>
                  <span className="text-right font-mono text-[11px] text-zinc-400">
                    {formatCny(costCny)}
                  </span>
                  <span className="flex items-center justify-end gap-1 text-[11px] text-zinc-500">
                    {timeAgo(run.createdAt, locale)}
                    <ArrowRight className="size-3" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
