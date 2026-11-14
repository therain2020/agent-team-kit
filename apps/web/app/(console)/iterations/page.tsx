"use client";

import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  IterationData,
  IterationRunWithTasks,
  IterationTaskView,
} from "@/lib/iteration-types";
import { cn } from "@/lib/utils";
import { Activity, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

export default function IterationsPage() {
  const [data, setData] = useState<IterationData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/api/iterations", {
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
      if (!stopped) {
        timer = setTimeout(load, 2_000);
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  const runs = data?.runs ?? [];
  const active = runs.filter((item) => item.run.status === "running");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Iterations"
        description={
          <span className="flex items-center gap-2">
            Live coder, verification and apply progress.
            <Badge variant="info">auto-refresh 2s</Badge>
            {active.length > 0 ? (
              <Badge variant="warning">{active.length} running</Badge>
            ) : null}
          </span>
        }
      />

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          Failed to load iterations: {error}
        </div>
      ) : null}

      {runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No iterations yet"
          description="Run `kit iterate` and its phases, tokens, changed files and artifacts will appear here."
        />
      ) : (
        <div className="space-y-4">
          {runs.map((item) => (
            <RunCard key={item.run.iterationId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({ item }: { item: IterationRunWithTasks }) {
  const { run, tasks } = item;
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="min-w-0 text-sm leading-relaxed text-zinc-200">
            {run.goal}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
            <Badge variant="outline">{run.phase}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
          <span className="font-mono">{run.iterationId}</span>
          <span>
            {run.runMode} / apply {run.applyMode}
          </span>
          <span>{run.tokens.toLocaleString()} tokens</span>
          <span>
            elapsed {elapsed(run.startedAt, run.finishedAt ?? run.updatedAt)}
          </span>
          <span>updated {timeAgo(run.updatedAt)}</span>
          {run.error ? <span className="text-red-400">{run.error}</span> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {tasks.map((task) => (
          <TaskRow key={task.taskId} run={run} task={task} />
        ))}
      </CardContent>
    </Card>
  );
}

function TaskRow({
  run,
  task,
}: {
  run: IterationRunWithTasks["run"];
  task: IterationTaskView;
}) {
  const active = task.status === "running";
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-background/40 px-3 py-2.5",
        active && "border-sky-500/40 bg-sky-500/5",
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
        <span className="ml-auto text-[10px] text-zinc-500">
          {task.coder ?? "coder"} · {task.tokens.toLocaleString()} tokens ·{" "}
          {elapsed(task.startedAt, task.finishedAt ?? task.updatedAt)}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-zinc-300">{task.goal}</p>

      {task.changedFiles.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.changedFiles.slice(0, 12).map((file) => (
            <span
              key={file}
              className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
            >
              {file}
            </span>
          ))}
          {task.changedFiles.length > 12 ? (
            <span className="text-[10px] text-zinc-500">
              +{task.changedFiles.length - 12} more
            </span>
          ) : null}
        </div>
      ) : null}

      {task.coderSummary ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] text-zinc-500">
          {task.coderSummary}
        </p>
      ) : null}

      {task.error ? (
        <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-[11px] text-red-400">
          {task.error}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px]">
        <ArtifactLink
          run={run}
          task={task}
          id={task.diffArtifactId}
          label="diff"
        />
        <ArtifactLink
          run={run}
          task={task}
          id={task.transcriptArtifactId}
          label="transcript"
        />
        <ArtifactLink
          run={run}
          task={task}
          id={task.verificationArtifactId}
          label="verification"
        />
        <ArtifactLink
          run={run}
          task={task}
          id={task.applyArtifactId}
          label="apply"
        />
        {task.commit ? (
          <span className="font-mono text-zinc-500">
            commit {task.commit.slice(0, 10)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ArtifactLink({
  run,
  task,
  id,
  label,
}: {
  run: IterationRunWithTasks["run"];
  task: IterationTaskView;
  id: string | null;
  label: string;
}) {
  if (!id) {
    return null;
  }
  return (
    <a
      href={`/api/iterations/${encodeURIComponent(run.iterationId)}/artifact?artifactId=${encodeURIComponent(id)}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-sky-300 hover:text-sky-200"
      title={`${label} for ${task.taskId}`}
    >
      {label}
      <ExternalLink className="size-2.5" />
    </a>
  );
}

function statusVariant(status: string) {
  if (
    status === "applied" ||
    status === "succeeded" ||
    status === "passed" ||
    status === "done"
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
