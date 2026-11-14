"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Radio } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ActivityEvent {
  eventId: number;
  workspaceId: string;
  runId: string | null;
  stageId: string | null;
  agentId: string | null;
  kind: string;
  status: string | null;
  tool: string | null;
  summary: string | null;
  payload: unknown;
  createdAt: string;
}

const KIND_GROUPS = [
  "all",
  "stage",
  "model",
  "tool",
  "coder",
  "gate",
  "approval",
  "manager",
  "run",
];

export function ActivityFeed({
  runId,
  agentId,
  className,
  maxHeight = "34rem",
}: {
  runId?: string;
  agentId?: string;
  className?: string;
  maxHeight?: string;
}) {
  const t = useTranslations("activity");
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connection, setConnection] = useState<"live" | "reconnecting">("live");
  const [agent, setAgent] = useState(agentId ?? "all");
  const [group, setGroup] = useState("all");
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastIdRef = useRef(0);

  const merge = useCallback((incoming: ActivityEvent[]) => {
    setEvents((previous) => {
      const seen = new Set(previous.map((event) => event.eventId));
      const next = [...previous];
      for (const event of incoming) {
        if (!seen.has(event.eventId)) {
          next.push(event);
          lastIdRef.current = Math.max(lastIdRef.current, event.eventId);
        }
      }
      next.sort((a, b) => a.eventId - b.eventId);
      return next.slice(-2_000);
    });
  }, []);

  useEffect(() => {
    setAgent(agentId ?? "all");
  }, [agentId]);

  useEffect(() => {
    let stopped = false;
    setEvents([]);
    lastIdRef.current = 0;
    const query = new URLSearchParams({ limit: "300" });
    if (runId) {
      query.set("runId", runId);
    }
    const load = async () => {
      try {
        const response = await fetch(`/api/activity?${query}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as {
          events?: ActivityEvent[];
        };
        if (!stopped) {
          merge(payload.events ?? []);
          setError(null);
        }
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    void load();

    const streamQuery = new URLSearchParams();
    if (runId) {
      streamQuery.set("runId", runId);
    }
    const source = new EventSource(
      `/api/activity/stream?${streamQuery.toString()}&after=${lastIdRef.current}`,
    );
    source.addEventListener("activity", (event) => {
      try {
        merge([JSON.parse((event as MessageEvent).data) as ActivityEvent]);
      } catch {
        // ignore malformed events
      }
    });
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("reconnecting");

    return () => {
      stopped = true;
      source.close();
    };
  }, [runId, merge]);

  const agentOptions = useMemo(
    () =>
      [
        ...new Set(
          events
            .map((event) => event.agentId)
            .filter((value): value is string => Boolean(value)),
        ),
      ].sort(),
    [events],
  );

  const visible = useMemo(
    () =>
      events.filter((event) => {
        if (agent !== "all" && event.agentId !== agent) {
          return false;
        }
        if (group !== "all" && !event.kind.startsWith(group)) {
          return false;
        }
        return true;
      }),
    [events, agent, group],
  );

  useEffect(() => {
    if (follow && visible.length > 0) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [visible, follow]);

  const toggle = (eventId: number) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <Badge variant={connection === "live" ? "success" : "warning"}>
          <Radio className="size-2.5" />
          {connection === "live" ? "live" : "reconnecting"}
        </Badge>
        <span>{t("events", { count: visible.length })}</span>
        <select
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
          className="h-7 rounded-md border border-border bg-zinc-950 px-1.5 text-[10px] text-zinc-300"
          aria-label={t("allAgents")}
        >
          <option value="all">{t("allAgents")}</option>
          {agentOptions.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          className="h-7 rounded-md border border-border bg-zinc-950 px-1.5 text-[10px] text-zinc-300"
          aria-label={t("allKinds")}
        >
          {KIND_GROUPS.map((item) => (
            <option key={item} value={item}>
              {item === "all" ? t("allKinds") : item}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={follow ? "outline" : "default"}
          className="ml-auto h-7 text-[10px]"
          onClick={() => setFollow((value) => !value)}
        >
          {follow ? t("follow") : t("jump")}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {t("missing")} {error}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-[11px] text-zinc-500">
          {t("empty")}
        </div>
      ) : (
        <div
          className="overflow-y-auto rounded-md border border-border bg-zinc-950/40"
          style={{ maxHeight }}
          onScroll={(event) => {
            const target = event.currentTarget;
            const nearBottom =
              target.scrollHeight - target.scrollTop - target.clientHeight < 80;
            if (nearBottom !== follow) {
              setFollow(nearBottom);
            }
          }}
        >
          <div className="divide-y divide-zinc-900">
            {visible.map((event) => {
              const open = expanded.has(event.eventId);
              return (
                <button
                  key={event.eventId}
                  type="button"
                  onClick={() => toggle(event.eventId)}
                  className="block w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-accent/40"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-zinc-600">
                      {time(event.createdAt)}
                    </span>
                    <Badge variant={kindVariant(event.kind)}>
                      {event.kind}
                    </Badge>
                    {event.agentId ? (
                      <span className="text-emerald-300">{event.agentId}</span>
                    ) : null}
                    {event.tool ? (
                      <span className="text-violet-300">{event.tool}</span>
                    ) : null}
                    {event.stageId ? (
                      <span className="text-zinc-600">
                        {shortStage(event.stageId)}
                      </span>
                    ) : null}
                    {event.status ? (
                      <span className="ml-auto text-zinc-600">
                        {event.status}
                      </span>
                    ) : null}
                  </div>
                  {event.summary ? (
                    <p
                      className={cn(
                        "mt-0.5 whitespace-pre-wrap break-words text-zinc-400",
                        open ? "" : "line-clamp-2",
                      )}
                    >
                      {event.summary}
                    </p>
                  ) : null}
                  {open ? (
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/40 p-2 text-[10px] text-zinc-500">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  ) : null}
                </button>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function kindVariant(kind: string) {
  if (kind.startsWith("gate")) {
    return "warning" as const;
  }
  if (kind.startsWith("approval")) {
    return "warning" as const;
  }
  if (kind.startsWith("tool")) {
    return "violet" as const;
  }
  if (kind.startsWith("coder")) {
    return "info" as const;
  }
  if (kind.startsWith("stage")) {
    return "outline" as const;
  }
  if (kind.startsWith("manager")) {
    return "info" as const;
  }
  return "outline" as const;
}

function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.slice(11, 19)
    : date.toISOString().slice(11, 19);
}

function shortStage(stageId: string): string {
  const parts = stageId.split(":");
  return parts[1] ?? stageId;
}
