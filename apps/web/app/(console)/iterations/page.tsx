"use client";

import { NewIterationDialog } from "@/components/iterations/new-iteration-dialog";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRiskLabel, useStatusLabel } from "@/lib/iteration-labels";
import type {
  IterationData,
  IterationRunWithTasks,
  IterationTaskView,
} from "@/lib/iteration-types";
import { cn, formatDuration, timeAgo } from "@/lib/utils";
import { Activity, ChevronRight, Search, Square } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const STATUSES = ["all", "running", "succeeded", "failed", "paused"] as const;

export default function IterationsPage() {
  return (
    <Suspense
      fallback={
        <div className="h-40 animate-pulse rounded-lg border border-border bg-card" />
      }
    >
      <IterationsContent />
    </Suspense>
  );
}

function IterationsContent() {
  const t = useTranslations("iterations");
  const common = useTranslations("common");
  const statusLabel = useStatusLabel();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<IterationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [connection, setConnection] = useState<"live" | "reconnecting">("live");
  const reloadRef = useRef<() => void>(() => {});
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const openNew = searchParams.get("new") === "1";

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({
          limit: "20",
          offset: String(offset),
        });
        if (status !== "all") {
          params.set("status", status);
        }
        if (query) {
          params.set("q", query);
        }
        const response = await fetch(`/api/iterations?${params}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const next = (await response.json()) as IterationData;
        if (!stopped) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    reloadRef.current = load;
    void load();
    const source = new EventSource(
      "/api/iterations/stream?iterationId=*&live=1",
    );
    source.addEventListener("iteration", () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
      }
      refreshTimer.current = setTimeout(() => {
        void load();
      }, 400);
    });
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("reconnecting");

    return () => {
      stopped = true;
      source.close();
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
      }
    };
  }, [status, query, offset]);

  const runs = data?.runs ?? [];

  const abortIteration = async (iterationId: string) => {
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(iterationId)}/abort?kind=iteration`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      toast.success(t("abortRequested", { iterationId }));
      reloadRef.current();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("abortFailed"));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {t("description")}
            <Badge variant={connection === "live" ? "success" : "warning"}>
              {connection === "live" ? t("live") : t("reconnecting")}
            </Badge>
          </span>
        }
        actions={
          <NewIterationDialog
            defaultOpen={openNew}
            onOpenChange={(next) => {
              if (!next && openNew) {
                router.replace("/iterations");
              }
            }}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {STATUSES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setStatus(item);
                setOffset(0);
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-zinc-200",
                status === item && "bg-accent text-zinc-100",
              )}
            >
              {item === "all" ? common("all") : statusLabel(item)}
            </button>
          ))}
        </div>
        <form
          className="ml-auto flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
            setOffset(0);
          }}
        >
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
            <Search className="size-3 text-zinc-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchPlaceholder")}
              className="w-52 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            {t("search")}
          </Button>
        </form>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          {t("loadFailed", { error })}
        </div>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={<NewIterationDialog triggerLabel={t("emptyAction")} />}
        />
      ) : (
        <div className="space-y-4">
          {runs.map((item) => (
            <RunCard
              key={item.run.iterationId}
              item={item}
              onAbort={abortIteration}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>{t("offset", { offset })}</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            {t("previous")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.hasMore}
            onClick={() => setOffset(offset + 20)}
          >
            {t("next")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RunCard({
  item,
  onAbort,
}: {
  item: IterationRunWithTasks;
  onAbort: (iterationId: string) => void;
}) {
  const t = useTranslations("iterations");
  const statusLabel = useStatusLabel();
  const locale = useLocale();
  const { run, tasks, turns } = item;
  const cancellable = ["running", "paused", "queued"].includes(run.status);
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="min-w-0 text-sm leading-relaxed text-zinc-200">
            <Link
              href={`/iterations/${encodeURIComponent(run.iterationId)}`}
              className="hover:text-zinc-50"
            >
              {run.goal}
            </Link>
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={statusVariant(run.status)}>
              {statusLabel(run.status)}
            </Badge>
            <Badge variant="outline">{run.phase}</Badge>
            {run.stalled ? (
              <Badge variant="warning">{statusLabel("stalled")}</Badge>
            ) : null}
            {cancellable ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAbort(run.iterationId)}
              >
                <Square className="size-3" />
                {t("abort")}
              </Button>
            ) : null}
            <Link
              href={`/iterations/${encodeURIComponent(run.iterationId)}`}
              className="rounded p-1 text-zinc-500 hover:bg-accent hover:text-zinc-200"
              aria-label={t("open")}
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
          <span className="font-mono">{run.iterationId}</span>
          <span>
            {t("runMeta", { mode: run.runMode, applyMode: run.applyMode })}
          </span>
          <span>{t("tokens", { tokens: run.tokens.toLocaleString() })}</span>
          <span>{t("turns", { turns: run.turnCount })}</span>
          <span>{t("tools", { tools: run.toolCalls })}</span>
          <span>
            {t("elapsed", {
              time: formatDuration(
                run.startedAt,
                run.finishedAt ?? run.updatedAt,
                locale,
              ),
            })}
          </span>
          <span>{t("updated", { time: timeAgo(run.updatedAt, locale) })}</span>
          <span>
            {run.lastHeartbeatAt
              ? t("heartbeat", { time: timeAgo(run.lastHeartbeatAt, locale) })
              : t("heartbeatNone")}
          </span>
          {run.error ? <span className="text-red-400">{run.error}</span> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {tasks.map((task) => (
          <TaskRow
            key={task.taskId}
            runId={run.iterationId}
            task={task}
            turns={turns.filter((turn) => turn.taskId === task.taskId).length}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function TaskRow({
  runId,
  task,
  turns,
}: {
  runId: string;
  task: IterationTaskView;
  turns: number;
}) {
  const t = useTranslations("iterations");
  const statusLabel = useStatusLabel();
  const riskLabel = useRiskLabel();
  return (
    <Link
      href={`/iterations/${encodeURIComponent(runId)}?task=${encodeURIComponent(task.taskId)}`}
      className={cn(
        "block rounded-md border border-border bg-background/40 px-3 py-2.5 transition-colors hover:border-zinc-600 hover:bg-accent/40",
        task.status === "running" && "border-sky-500/40 bg-sky-500/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-zinc-200">{task.taskId}</span>
        <Badge variant={statusVariant(task.status)}>
          {statusLabel(task.status)}
        </Badge>
        <Badge variant="outline">{task.phase}</Badge>
        <Badge variant="violet">{task.domain}</Badge>
        {task.risk ? (
          <Badge variant={task.risk === "high" ? "danger" : "outline"}>
            {t("risk", { level: riskLabel(task.risk) })}
          </Badge>
        ) : null}
        {task.applyStatus ? (
          <Badge variant={statusVariant(task.applyStatus)}>
            {t("apply", { status: statusLabel(task.applyStatus) })}
          </Badge>
        ) : null}
        {task.stalled ? (
          <Badge variant="warning">{statusLabel("stalled")}</Badge>
        ) : null}
        <span className="ml-auto text-[10px] text-zinc-500">
          {t("taskMeta", {
            tokens: task.tokens.toLocaleString(),
            turns,
            tools: task.toolCalls,
          })}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs text-zinc-400">{task.goal}</p>
      {task.changedFiles.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.changedFiles.slice(0, 8).map((file) => (
            <span
              key={file}
              className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
            >
              {file}
            </span>
          ))}
          {task.changedFiles.length > 8 ? (
            <span className="text-[10px] text-zinc-500">
              {t("more", { count: task.changedFiles.length - 8 })}
            </span>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}

function statusVariant(status: string) {
  if (
    status === "applied" ||
    status === "succeeded" ||
    status === "passed" ||
    status === "done" ||
    status === "completed"
  ) {
    return "success" as const;
  }
  if (status === "failed" || status === "blocked" || status === "reverted") {
    return "danger" as const;
  }
  if (status === "running" || status === "coder" || status === "applying") {
    return "info" as const;
  }
  if (status === "skipped" || status === "pending") {
    return "outline" as const;
  }
  return "warning" as const;
}
