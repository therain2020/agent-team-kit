"use client";

import { PendingChanges } from "@/components/iterations/pending-changes";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  IterationDetail,
  IterationEventView,
  IterationTaskView,
  IterationTurnView,
} from "@/lib/iteration-types";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Radio,
  Square,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type EventFilter = "all" | "tools" | "text" | "errors";

export function IterationDetailView({
  iterationId,
  initialTask,
}: {
  iterationId: string;
  initialTask: string | null;
}) {
  const [detail, setDetail] = useState<IterationDetail | null>(null);
  const [events, setEvents] = useState<IterationEventView[]>([]);
  const [turns, setTurns] = useState<IterationTurnView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState(initialTask ?? "all");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [follow, setFollow] = useState(true);
  const [connection, setConnection] = useState<"live" | "reconnecting">("live");
  const reloadRef = useRef<() => void>(() => {});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const lastEventIdRef = useRef(0);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/iterations/${encodeURIComponent(iterationId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "iteration not found"
              : `HTTP ${response.status}`,
          );
        }
        const data = (await response.json()) as IterationDetail;
        if (stopped) {
          return;
        }
        setDetail(data);
        setEvents(data.events);
        setTurns(data.turns);
        lastEventIdRef.current = data.lastEventId;
        setError(null);
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    reloadRef.current = load;
    void load();
    return () => {
      stopped = true;
    };
  }, [iterationId]);

  const abort = async () => {
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(iterationId)}/abort?kind=iteration`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      toast.success("Abort requested");
      reloadRef.current();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "failed to abort iteration",
      );
    }
  };

  const refreshSummary = () => {
    if (summaryTimer.current) {
      clearTimeout(summaryTimer.current);
    }
    summaryTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/iterations/${encodeURIComponent(iterationId)}?events=1`,
            { cache: "no-store" },
          );
          if (!response.ok) {
            return;
          }
          const next = (await response.json()) as IterationDetail;
          setDetail((previous) =>
            previous
              ? { ...previous, run: next.run, tasks: next.tasks }
              : previous,
          );
          setTurns((previous) => mergeTurns(previous, next.turns));
        } catch {
          // a later event will retry
        }
      })();
    }, 500);
  };

  const appendEvent = (event: IterationEventView) => {
    if (event.eventId <= lastEventIdRef.current) {
      return;
    }
    lastEventIdRef.current = event.eventId;
    setEvents((previous) => [...previous, event].slice(-5_000));
    setTurns((previous) => applyTurnEvent(previous, event));
    if (
      !event.kind.startsWith("coder.") ||
      event.kind === "coder.started" ||
      event.kind === "coder.finished" ||
      event.kind === "coder.step_end" ||
      event.kind === "coder.turn_end" ||
      event.kind === "coder.final"
    ) {
      refreshSummary();
    }
  };

  const appendEventRef = useRef(appendEvent);
  appendEventRef.current = appendEvent;
  const streamKey = detail?.run.iterationId;
  useEffect(() => {
    if (!streamKey) {
      return;
    }
    const source = new EventSource(
      `/api/iterations/stream?iterationId=${encodeURIComponent(streamKey)}&after=${lastEventIdRef.current}`,
    );
    source.addEventListener("iteration", (message) => {
      try {
        appendEventRef.current(
          JSON.parse((message as MessageEvent).data) as IterationEventView,
        );
      } catch {
        // ignore malformed events
      }
    });
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("reconnecting");
    return () => source.close();
  }, [streamKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new events arrive
  useEffect(() => {
    if (follow) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [events.length, follow]);

  useEffect(
    () => () => {
      if (summaryTimer.current) {
        clearTimeout(summaryTimer.current);
      }
    },
    [],
  );

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          {error}
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="h-40 animate-pulse rounded-lg border border-border bg-card" />
      </div>
    );
  }

  const run = detail.run;
  const tasks = detail.tasks.filter(
    (task) => taskFilter === "all" || task.taskId === taskFilter,
  );
  const runEvents = events.filter(
    (event) =>
      event.taskId === null &&
      taskFilter === "all" &&
      matchesFilter(event, eventFilter),
  );

  const loadOlder = async () => {
    const oldest = events[0]?.eventId;
    if (!oldest || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    try {
      const response = await fetch(
        `/api/iterations/${encodeURIComponent(iterationId)}/events?before=${oldest}&limit=200`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        return;
      }
      const page = (await response.json()) as {
        events: IterationEventView[];
        hasMore: boolean;
      };
      setEvents((previous) => [...page.events, ...previous]);
      setDetail((previous) =>
        previous ? { ...previous, hasMoreBefore: page.hasMore } : previous,
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <BackLink />
        <PageHeader
          className="mt-3"
          title={run.goal}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
              <Badge variant="outline">{run.phase}</Badge>
              {run.stalled ? <Badge variant="warning">stalled</Badge> : null}
              <span className="font-mono text-[10px] text-zinc-500">
                {run.iterationId}
              </span>
              <span className="text-[10px] text-zinc-500">
                {run.runMode} / apply {run.applyMode}
              </span>
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              <Badge variant={connection === "live" ? "success" : "warning"}>
                <Radio className="size-2.5" />
                {connection === "live" ? "live" : "reconnecting"}
              </Badge>
              {["running", "paused", "queued"].includes(run.status) ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void abort()}
                >
                  <Square className="size-3.5" />
                  Abort
                </Button>
              ) : null}
              <Button size="sm" variant="outline" asChild>
                <Link href="/iterations">
                  <ArrowLeft className="size-3.5" />
                  All iterations
                </Link>
              </Button>
            </div>
          }
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
          <span>{run.tokens.toLocaleString()} tokens</span>
          <span>{run.turnCount} turns</span>
          <span>{run.toolCalls} tools</span>
          <span>
            elapsed {elapsed(run.startedAt, run.finishedAt ?? run.updatedAt)}
          </span>
          <span>
            heartbeat{" "}
            {run.lastHeartbeatAt ? timeAgo(run.lastHeartbeatAt) : "none"}
          </span>
          {run.error ? <span className="text-red-400">{run.error}</span> : null}
          <RunArtifactLinks run={run} />
        </div>
      </div>

      <PendingChanges iterationId={iterationId} />

      <div className="flex flex-wrap items-center gap-2">
        <TaskFilter
          tasks={detail.tasks}
          value={taskFilter}
          onChange={(value) => setTaskFilter(value)}
        />
        <div className="flex items-center gap-1">
          {(["all", "tools", "text", "errors"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setEventFilter(filter)}
              className={cn(
                "rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-zinc-200",
                eventFilter === filter && "bg-accent text-zinc-100",
              )}
            >
              {filter}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant={follow ? "outline" : "default"}
            onClick={() => setFollow((value) => !value)}
          >
            {follow ? "Following live" : "Jump to latest"}
          </Button>
        </div>
      </div>

      {detail.hasMoreBefore ? (
        <div className="text-center">
          <Button
            size="sm"
            variant="outline"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? "Loading..." : "Load older events"}
          </Button>
        </div>
      ) : null}

      {runEvents.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-xs uppercase tracking-wider text-zinc-500">
              Run events
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {runEvents.map((event) => (
              <EventRow key={event.eventId} event={event} toolName={null} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {tasks.map((task) => (
        <TaskSection
          key={task.taskId}
          task={task}
          turns={turns.filter((turn) => turn.taskId === task.taskId)}
          events={events.filter((event) => event.taskId === task.taskId)}
          eventFilter={eventFilter}
          runId={iterationId}
        />
      ))}

      {tasks.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
          No matching task.
        </div>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/iterations"
      className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"
    >
      <ArrowLeft className="size-3" />
      Iterations
    </Link>
  );
}

function TaskFilter({
  tasks,
  value,
  onChange,
}: {
  tasks: IterationTaskView[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn(
          "rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-zinc-200",
          value === "all" && "bg-accent text-zinc-100",
        )}
      >
        all tasks
      </button>
      {tasks.map((task) => (
        <button
          key={task.taskId}
          type="button"
          onClick={() => onChange(task.taskId)}
          className={cn(
            "rounded-md px-2 py-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-zinc-200",
            value === task.taskId && "bg-accent text-zinc-100",
          )}
        >
          {task.taskId}
        </button>
      ))}
    </div>
  );
}

function TaskSection({
  task,
  turns,
  events,
  eventFilter,
  runId,
}: {
  task: IterationTaskView;
  turns: IterationTurnView[];
  events: IterationEventView[];
  eventFilter: EventFilter;
  runId: string;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-sm text-zinc-200">
            {task.taskId}
          </CardTitle>
          <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
          <Badge variant="outline">{task.phase}</Badge>
          <Badge variant="violet">{task.domain}</Badge>
          {task.risk ? (
            <Badge variant={task.risk === "high" ? "danger" : "outline"}>
              risk {task.risk}
            </Badge>
          ) : null}
          {task.stalled ? <Badge variant="warning">stalled</Badge> : null}
          <span className="ml-auto text-[10px] text-zinc-500">
            {task.tokens.toLocaleString()} tokens · {task.toolCalls} tools ·{" "}
            {turns.length} turns
          </span>
        </div>
        <p className="text-xs text-zinc-400">{task.goal}</p>
        <div className="flex flex-wrap items-center gap-3 text-[10px]">
          <TaskArtifactLinks runId={runId} task={task} />
          {task.commit ? (
            <span className="font-mono text-zinc-500">
              commit {task.commit.slice(0, 10)}
            </span>
          ) : null}
        </div>
        {task.changedFiles.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {task.changedFiles.map((file) => (
              <span
                key={file}
                className="rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
              >
                {file}
              </span>
            ))}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {(() => {
          const phaseEvents = events.filter(
            (event) => event.turn === null && matchesFilter(event, eventFilter),
          );
          return phaseEvents.length > 0 ? (
            <div className="space-y-1.5 rounded-md border border-border/60 bg-background/30 px-3 py-2">
              <p className="text-[9px] uppercase tracking-wider text-zinc-600">
                Task events
              </p>
              {phaseEvents.map((event) => (
                <EventRow key={event.eventId} event={event} toolName={null} />
              ))}
            </div>
          ) : null;
        })()}
        {turns.length === 0 ? (
          <p className="py-3 text-center text-[11px] text-muted-foreground">
            Waiting for the coder's first turn...
          </p>
        ) : (
          turns.map((turn, index) => (
            <TurnCard
              key={`${turn.taskId}:${turn.turn}`}
              turn={turn}
              events={events.filter((event) => event.turn === turn.turn)}
              eventFilter={eventFilter}
              defaultOpen={
                index === turns.length - 1 || turn.status === "running"
              }
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function TurnCard({
  turn,
  events,
  eventFilter,
  defaultOpen,
}: {
  turn: IterationTurnView;
  events: IterationEventView[];
  eventFilter: EventFilter;
  defaultOpen: boolean;
}) {
  const visible = events.filter((event) => matchesFilter(event, eventFilter));
  const toolNames = new Map<string, string | null>(
    events
      .filter((event) => event.kind === "coder.tool_call")
      .map((event) => [
        String(event.payload.callId ?? event.eventId),
        event.tool,
      ]),
  );
  return (
    <details
      open={defaultOpen}
      className="group rounded-md border border-border bg-background/40"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
        <ChevronDown className="size-3.5 text-zinc-500 transition-transform group-open:rotate-180" />
        <span className="font-mono text-xs text-zinc-200">
          turn {turn.turn}
        </span>
        <Badge variant={statusVariant(turn.status)}>{turn.status}</Badge>
        <span className="text-[10px] text-zinc-500">
          {turn.steps} steps · {turn.toolCalls} tools ·{" "}
          {turn.tokens.toLocaleString()} tokens ·{" "}
          {elapsed(turn.startedAt, turn.finishedAt ?? new Date().toISOString())}
        </span>
        {turn.summary ? (
          <span className="ml-2 min-w-0 flex-1 truncate text-[11px] text-zinc-500">
            {turn.summary}
          </span>
        ) : null}
      </summary>
      <div className="space-y-1.5 border-t border-border px-3 py-2">
        {turn.error ? (
          <p className="text-[11px] text-red-400">{turn.error}</p>
        ) : null}
        {visible.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            No events for this filter.
          </p>
        ) : (
          visible.map((event) => (
            <EventRow
              key={event.eventId}
              event={event}
              toolName={
                toolNames.get(String(event.payload.callId ?? "")) ?? event.tool
              }
            />
          ))
        )}
      </div>
    </details>
  );
}

function EventRow({
  event,
  toolName,
}: {
  event: IterationEventView;
  toolName: string | null | undefined;
}) {
  if (event.kind === "coder.tool_call") {
    return (
      <div className="rounded border border-sky-500/20 bg-sky-500/5 px-2 py-1.5">
        <div className="flex items-center gap-2 text-[11px]">
          <Wrench className="size-3 text-sky-400" />
          <Badge variant="info">{event.tool ?? "tool"}</Badge>
          <span className="text-zinc-300">{event.summary}</span>
          <span className="ml-auto text-[9px] text-zinc-600">
            {timeOnly(event.createdAt)}
          </span>
        </div>
        <PayloadDetails label="input" value={event.payload.input} />
      </div>
    );
  }
  if (event.kind === "coder.tool_result") {
    const failed = event.status === "failed";
    return (
      <div
        className={cn(
          "rounded border px-2 py-1.5",
          failed
            ? "border-red-500/20 bg-red-500/5"
            : "border-emerald-500/15 bg-emerald-500/5",
        )}
      >
        <div className="flex items-center gap-2 text-[11px]">
          <CircleDot
            className={cn(
              "size-3",
              failed ? "text-red-400" : "text-emerald-400",
            )}
          />
          <Badge variant={failed ? "danger" : "success"}>
            {event.status ?? "completed"}
          </Badge>
          <span className="text-zinc-400">
            {toolName ?? event.tool ?? "tool"} result
          </span>
          <span className="ml-auto text-[9px] text-zinc-600">
            {timeOnly(event.createdAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[10px] text-zinc-500">
          {event.summary}
        </p>
        <PayloadDetails label="result" value={event.payload.result} />
      </div>
    );
  }
  if (
    event.kind === "coder.thinking" ||
    event.kind === "coder.text" ||
    event.kind === "coder.final"
  ) {
    const text =
      typeof event.payload.text === "string"
        ? event.payload.text
        : (event.summary ?? "");
    return (
      <div className="px-1 py-0.5 text-[11px] text-zinc-400">
        <span className="mr-2 text-[9px] uppercase tracking-wider text-zinc-600">
          {event.kind.replace("coder.", "")}
        </span>
        <span className="whitespace-pre-wrap">{text.slice(0, 800)}</span>
      </div>
    );
  }
  if (
    event.kind === "coder.step_start" ||
    event.kind === "coder.step_end" ||
    event.kind === "coder.turn_start" ||
    event.kind === "coder.turn_end"
  ) {
    return (
      <div className="flex items-center gap-2 px-1 text-[10px] text-zinc-600">
        <span className="font-mono">{event.kind.replace("coder.", "")}</span>
        {event.step ? <span>step {event.step}</span> : null}
        {event.status ? <span>{event.status}</span> : null}
        <span className="ml-auto">{timeOnly(event.createdAt)}</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex items-start gap-2 px-1 py-0.5 text-[11px]",
        event.status === "failed" ? "text-red-400" : "text-zinc-400",
      )}
    >
      <Badge variant={statusVariant(event.status ?? event.kind)}>
        {event.kind}
      </Badge>
      <span className="min-w-0 flex-1">{event.summary}</span>
      <span className="text-[9px] text-zinc-600">
        {timeOnly(event.createdAt)}
      </span>
    </div>
  );
}

function PayloadDetails({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (value === undefined || value === null) {
    return null;
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text === "{}") {
    return null;
  }
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[9px] text-zinc-500 hover:text-zinc-300">
        {label}
      </summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-[9px] text-zinc-500">
        {text.slice(0, 8_000)}
      </pre>
    </details>
  );
}

function RunArtifactLinks({ run }: { run: IterationDetail["run"] }) {
  return (
    <span className="flex items-center gap-3">
      <ArtifactLink
        iterationId={run.iterationId}
        artifactId={run.planArtifactId}
        label="plan"
      />
      <ArtifactLink
        iterationId={run.iterationId}
        artifactId={run.reportArtifactId}
        label="report"
      />
    </span>
  );
}

function TaskArtifactLinks({
  runId,
  task,
}: {
  runId: string;
  task: IterationTaskView;
}) {
  return (
    <>
      <ArtifactLink
        iterationId={runId}
        artifactId={task.diffArtifactId}
        label="diff"
      />
      <ArtifactLink
        iterationId={runId}
        artifactId={task.transcriptArtifactId}
        label="transcript"
      />
      <ArtifactLink
        iterationId={runId}
        artifactId={task.verificationArtifactId}
        label="verification"
      />
      <ArtifactLink
        iterationId={runId}
        artifactId={task.applyArtifactId}
        label="apply"
      />
    </>
  );
}

function ArtifactLink({
  iterationId,
  artifactId,
  label,
}: {
  iterationId: string;
  artifactId: string | null;
  label: string;
}) {
  if (!artifactId) {
    return null;
  }
  return (
    <a
      href={`/api/iterations/${encodeURIComponent(iterationId)}/artifact?artifactId=${encodeURIComponent(artifactId)}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-sky-300 hover:text-sky-200"
    >
      {label}
      <ExternalLink className="size-2.5" />
    </a>
  );
}

function matchesFilter(
  event: IterationEventView,
  filter: EventFilter,
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "tools") {
    return (
      event.kind === "coder.tool_call" || event.kind === "coder.tool_result"
    );
  }
  if (filter === "text") {
    return (
      event.kind === "coder.thinking" ||
      event.kind === "coder.text" ||
      event.kind === "coder.final"
    );
  }
  return (
    event.kind === "coder.error" ||
    event.status === "failed" ||
    event.status === "blocked" ||
    event.status === "reverted"
  );
}

function applyTurnEvent(
  previous: IterationTurnView[],
  event: IterationEventView,
): IterationTurnView[] {
  if (event.taskId === null || event.turn === null) {
    return previous;
  }
  const index = previous.findIndex(
    (turn) => turn.taskId === event.taskId && turn.turn === event.turn,
  );
  const current = index >= 0 ? previous[index] : undefined;
  const base: IterationTurnView = current
    ? { ...current }
    : {
        iterationId: event.iterationId,
        taskId: event.taskId,
        turn: event.turn,
        status: "running",
        startedAt: event.createdAt,
        finishedAt: null,
        steps: 0,
        toolCalls: 0,
        tokens: 0,
        summary: null,
        error: null,
        lastEventId: 0,
      };
  if (event.kind === "coder.turn_start") {
    base.status = "running";
    base.startedAt = event.createdAt;
  }
  if (event.kind === "coder.step_start") {
    base.steps = Math.max(base.steps, event.step ?? 1);
  }
  if (event.kind === "coder.tool_call") {
    base.toolCalls += 1;
  }
  if (event.kind === "coder.step_end") {
    base.tokens = Math.max(base.tokens, Number(event.payload.tokens ?? 0));
  }
  if (
    event.kind === "coder.turn_end" ||
    event.kind === "coder.final" ||
    event.kind === "coder.error"
  ) {
    base.status = event.status ?? "completed";
    base.finishedAt = event.createdAt;
  }
  if (event.summary) {
    base.summary = event.summary;
  }
  if (event.kind === "coder.error" && event.summary) {
    base.error = event.summary;
  }
  base.lastEventId = event.eventId;
  if (index >= 0) {
    const next = [...previous];
    next[index] = base;
    return next;
  }
  return [...previous, base];
}

function mergeTurns(
  previous: IterationTurnView[],
  next: IterationTurnView[],
): IterationTurnView[] {
  const byKey = new Map(
    previous.map((turn) => [`${turn.taskId}:${turn.turn}`, turn]),
  );
  for (const turn of next) {
    const key = `${turn.taskId}:${turn.turn}`;
    const current = byKey.get(key);
    if (!current || current.lastEventId <= turn.lastEventId) {
      byKey.set(key, turn);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.taskId.localeCompare(b.taskId) || a.turn - b.turn,
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

function timeOnly(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}
