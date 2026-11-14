"use client";

import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  IterationData,
  IterationRunWithTasks,
  IterationTaskView,
} from "@/lib/iteration-types";
import { cn } from "@/lib/utils";
import { Activity, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const STATUSES = ["all", "running", "succeeded", "failed", "paused"];

export default function IterationsPage() {
  const [data, setData] = useState<IterationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [connection, setConnection] = useState<"live" | "reconnecting">("live");
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Iterations"
        description={
          <span className="flex flex-wrap items-center gap-2">
            Live coder turns, verification and apply progress.
            <Badge variant={connection === "live" ? "success" : "warning"}>
              {connection === "live" ? "live" : "reconnecting"}
            </Badge>
          </span>
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
              {item}
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
              placeholder="goal or iteration id"
              className="w-52 bg-transparent text-xs text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          Failed to load iterations: {error}
        </div>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No iterations yet"
          description="Run `kit iterate` in a pack domain. Turns, tools and diffs will appear here in real time."
        />
      ) : (
        <div className="space-y-4">
          {runs.map((item) => (
            <RunCard key={item.run.iterationId} item={item} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>offset {offset}</span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.hasMore}
            onClick={() => setOffset(offset + 20)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function RunCard({ item }: { item: IterationRunWithTasks }) {
  const { run, tasks, turns } = item;
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
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
            <Badge variant="outline">{run.phase}</Badge>
            {run.stalled ? <Badge variant="warning">stalled</Badge> : null}
            <Link
              href={`/iterations/${encodeURIComponent(run.iterationId)}`}
              className="rounded p-1 text-zinc-500 hover:bg-accent hover:text-zinc-200"
              aria-label="Open iteration"
            >
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
          <span className="font-mono">{run.iterationId}</span>
          <span>
            {run.runMode} / apply {run.applyMode}
          </span>
          <span>{run.tokens.toLocaleString()} tokens</span>
          <span>{run.turnCount} turns</span>
          <span>{run.toolCalls} tools</span>
          <span>
            elapsed {elapsed(run.startedAt, run.finishedAt ?? run.updatedAt)}
          </span>
          <span>updated {timeAgo(run.updatedAt)}</span>
          <span>
            heartbeat{" "}
            {run.lastHeartbeatAt ? timeAgo(run.lastHeartbeatAt) : "none"}
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
        <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
        <Badge variant="outline">{task.phase}</Badge>
        <Badge variant="violet">{task.domain}</Badge>
        {task.risk ? (
          <Badge variant={task.risk === "high" ? "danger" : "outline"}>
            risk {task.risk}
          </Badge>
        ) : null}
        {task.applyStatus ? (
          <Badge variant={statusVariant(task.applyStatus)}>
            apply {task.applyStatus}
          </Badge>
        ) : null}
        {task.stalled ? <Badge variant="warning">stalled</Badge> : null}
        <span className="ml-auto text-[10px] text-zinc-500">
          {task.coder ?? "coder"} · {task.tokens.toLocaleString()} tokens ·{" "}
          {turns} turns · {task.toolCalls} tools
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
              +{task.changedFiles.length - 8} more
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

function elapsed(start: string, end: string | null): string {
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "unknown";
  }
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${rest}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function timeAgo(value: string): string {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return "just now";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.round(minutes / 60)}h ago`;
}
