import { Badge } from "@/components/ui/badge";
import { jobDrawerHref } from "@/lib/job-hub-view";
import { timeAgo } from "@/lib/utils";
import type { ObserverTimelineEntry } from "@kit/activity";
import { ArrowRight, FileText, Radio } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

/**
 * Read-only information → reaction → job → artifact timeline (98 §3.5). The
 * reaction cell is the TriggerRun that linked back to the event; job and
 * artifact stay drill-down links into the existing job hub.
 */
export async function ObserverTimeline({
  entries,
}: {
  entries: ObserverTimelineEntry[];
}) {
  const t = await getTranslations("observer");
  const locale = await getLocale();

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 px-4 py-10 text-center text-[11px] text-zinc-500">
        {t("timelineEmpty")}
      </div>
    );
  }

  return (
    <ol className="space-y-2">
      {entries.map((entry) => (
        <li
          key={entry.event.eventId}
          className="rounded-lg border border-border bg-zinc-950/40 px-3 py-2.5"
        >
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)_auto_minmax(0,0.8fr)_auto_minmax(0,0.6fr)] lg:items-center">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                <Radio className="size-3 text-sky-400" />
                {t("informationStage")}
              </p>
              {entry.event.url ? (
                <a
                  href={entry.event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="line-clamp-2 text-[11px] text-zinc-200 hover:underline"
                >
                  {entry.event.title || entry.event.eventId}
                </a>
              ) : (
                <p className="line-clamp-2 text-[11px] text-zinc-200">
                  {entry.event.title || entry.event.eventId}
                </p>
              )}
              <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
                {entry.event.sourceId} ·{" "}
                {t("received", {
                  time: timeAgo(entry.event.receivedAt, locale),
                })}
              </p>
            </div>

            <ArrowRight className="hidden size-3.5 text-zinc-700 lg:block" />

            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("reactionStage")}
              </p>
              {entry.reaction ? (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={statusVariant(entry.reaction.status)}>
                      {entry.reaction.status}
                    </Badge>
                    <span className="truncate font-mono text-[10px] text-zinc-400">
                      {entry.reaction.ruleId}
                    </span>
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                    {entry.reaction.triggerId} · ≈
                    {entry.reaction.estimateCny.toFixed(2)} CNY
                  </p>
                  {entry.reaction.lastError ? (
                    <p className="mt-0.5 line-clamp-1 text-[10px] text-red-300">
                      {entry.reaction.lastError}
                    </p>
                  ) : null}
                </>
              ) : (
                <Badge variant="outline">{t("awaitingReaction")}</Badge>
              )}
            </div>

            <ArrowRight className="hidden size-3.5 text-zinc-700 lg:block" />

            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("jobStage")}
              </p>
              {entry.reaction?.jobId ? (
                <Link
                  href={jobDrawerHref(entry.reaction.jobId, "hub")}
                  className="block truncate font-mono text-[11px] text-sky-300 hover:underline"
                >
                  {entry.reaction.jobId}
                </Link>
              ) : (
                <span className="font-mono text-[11px] text-zinc-600">—</span>
              )}
              {entry.reaction?.jobId ? (
                <p className="truncate font-mono text-[10px] text-zinc-600">
                  {entry.reaction.jobKind}
                </p>
              ) : null}
            </div>

            <ArrowRight className="hidden size-3.5 text-zinc-700 lg:block" />

            <div className="min-w-0">
              <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
                <FileText className="size-3 text-violet-300" />
                {t("artifactStage")}
              </p>
              {entry.reaction?.jobId ? (
                <Link
                  href={jobDrawerHref(entry.reaction.jobId, "artifacts")}
                  className="text-[11px] text-violet-300 hover:underline"
                >
                  {t("openArtifacts")}
                </Link>
              ) : (
                <span className="font-mono text-[11px] text-zinc-600">—</span>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function statusVariant(status: string) {
  if (status === "started") {
    return "success" as const;
  }
  if (status === "existing") {
    return "info" as const;
  }
  if (status === "failed") {
    return "danger" as const;
  }
  return "outline" as const;
}
