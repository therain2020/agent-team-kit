"use client";

import { Badge } from "@/components/ui/badge";
import type { AtlasRun } from "@/lib/atlas";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { formatCost, formatSpan, formatTokens, minuteOfDay } from "./theme";

const BUCKETS = 32;

export function Vitals({ data }: { data: AtlasRun }) {
  const t = useTranslations("atlas");
  const statusT = useTranslations("status");

  const { completion, greenRate, spark, lastEvents } = useMemo(() => {
    const total = data.totals.total || 1;
    const completion = Math.round(
      Math.max(0, Math.min(1, data.progress)) * 100,
    );
    const started = data.nodes.filter(
      (node) =>
        node.status === "succeeded" ||
        node.status === "running" ||
        node.status === "failed" ||
        node.status === "waiting",
    ).length;
    const greenRate =
      started > 0
        ? Math.round(
            (data.nodes.filter((node) => node.status === "succeeded").length /
              started) *
              100,
          )
        : Math.round((data.totals.done / total) * 100);

    const now = Date.parse(data.now);
    const start = data.startedAt ? Date.parse(data.startedAt) : now;
    const end = data.endedAt ? Date.parse(data.endedAt) : now;
    const span = Math.max(60_000, end - start);
    const counts = new Array<number>(BUCKETS).fill(0);
    for (const event of data.events) {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at)) {
        continue;
      }
      const index = Math.min(
        BUCKETS - 1,
        Math.max(0, Math.floor(((at - start) / span) * BUCKETS)),
      );
      counts[index] = (counts[index] ?? 0) + 1;
    }
    const max = Math.max(1, ...counts);
    const points = counts
      .map((count, index) => {
        const x = (index / (BUCKETS - 1)) * 200;
        const y = 40 - (count / max) * 34;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const area = `M 0 44 L ${points.split(" ").join(" L ")} L 200 44 Z`;

    return {
      completion,
      greenRate,
      spark: { points, area },
      lastEvents: [...data.events].slice(-3).reverse(),
    };
  }, [data]);

  const stuck = data.waitReason !== null || data.status === "paused";
  const costLabel =
    data.costSource === "charges"
      ? t("costSourceCharges")
      : data.costSource === "manifest"
        ? t("costSourceManifest")
        : data.costSource === "empty"
          ? t("costSourceEmpty")
          : t("costSourceDemo");

  return (
    <section className="border border-px-line bg-px-panel">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-3 py-3">
        <div className="min-w-[11rem]">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={
                data.status === "running"
                  ? "info"
                  : data.status === "succeeded"
                    ? "success"
                    : data.status === "failed"
                      ? "danger"
                      : data.status === "paused"
                        ? "warning"
                        : "default"
              }
            >
              {statusT(data.status)}
            </Badge>
            {stuck ? <Badge variant="warning">{t("stuckBadge")}</Badge> : null}
          </div>
          <p className="mt-2 truncate font-mono text-sm text-px-strong">
            {data.workflowId}
          </p>
          <p className="mt-0.5 truncate font-mono text-[9px] text-px-faint">
            {data.runId}
          </p>
          {stuck && data.waitReason ? (
            <p className="mt-1 line-clamp-2 font-mono text-[10px] text-amber-300/90">
              {data.waitReason}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <Ring
            value={completion}
            label={t("completion")}
            color="#4dd08a"
            size="lg"
          />
          <Ring
            value={greenRate}
            label={t("greenRate")}
            color="#4f9dff"
            size="sm"
          />
        </div>

        <div className="grid min-w-[15rem] flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
          <Stat label={t("cost")} value={formatCost(data.totals.costCny)} />
          <Stat label={t("tokens")} value={formatTokens(data.totals.tokens)} />
          <Stat label={t("artifacts")} value={String(data.totals.artifacts)} />
          <Stat
            label={t("elapsed")}
            value={formatSpan(data.totals.durationMs)}
          />
          {data.totals.gateTotal > 0 ? (
            <Stat
              label={t("gatePass")}
              value={`${data.totals.gatePassed}/${data.totals.gateTotal}`}
              tone={
                data.totals.gatePassed === data.totals.gateTotal
                  ? "good"
                  : "warn"
              }
            />
          ) : null}
        </div>

        <div className="min-w-[14rem] flex-1">
          <div className="flex items-center justify-between font-mono text-[9px] text-px-muted">
            <span>{t("pulse")}</span>
            <span>
              {data.events.length} {t("events")}
            </span>
          </div>
          <svg
            viewBox="0 0 200 44"
            className="mt-1 block h-10 w-full"
            preserveAspectRatio="none"
            role="img"
            aria-label={t("pulse")}
          >
            <defs>
              <linearGradient id="atlas-spark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4f9dff" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#4f9dff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={spark.area} fill="url(#atlas-spark)" />
            <polyline
              points={spark.points}
              fill="none"
              stroke="#4f9dff"
              strokeWidth={1.3}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          <div className="mt-1 space-y-0.5">
            {lastEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center gap-2 font-mono text-[9px] text-px-muted"
              >
                <span className="text-px-faint">{minuteOfDay(event.at)}</span>
                <span className={cn("truncate", kindColor(event.kind))}>
                  {event.label}
                </span>
              </div>
            ))}
            {lastEvents.length === 0 ? (
              <p className="font-mono text-[9px] text-px-faint">
                {t("noEvents")}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t border-px-line px-3 py-1.5 font-mono text-[9px] text-px-faint">
        <span>
          {t("cursorLabel")} #{data.cursor.seq} ·{" "}
          {minuteOfDay(data.cursor.asOf)}
        </span>
        <span>
          {t("costSourceLabel")}: {costLabel}
        </span>
      </footer>
    </section>
  );
}

function Ring({
  value,
  label,
  color,
  size,
}: {
  value: number;
  label: string;
  color: string;
  size: "lg" | "sm";
}) {
  const dimension = size === "lg" ? 82 : 58;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="relative shrink-0 rounded-full"
      style={{
        width: dimension,
        height: dimension,
        background: `conic-gradient(${color} ${clamped * 3.6}deg, rgba(255,255,255,0.06) 0deg)`,
      }}
      role="img"
      aria-label={`${label} ${clamped}%`}
    >
      <div className="absolute inset-[5px] grid place-items-center rounded-full bg-px-panel">
        <div className="text-center">
          <p
            className={cn(
              "font-mono leading-none text-px-strong",
              size === "lg" ? "text-lg" : "text-sm",
            )}
          >
            {clamped}%
          </p>
          <p className="mt-0.5 text-[8px] leading-tight text-px-muted">
            {label}
          </p>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "warn";
}) {
  return (
    <div className="border border-px-line bg-px-ink/40 px-2.5 py-1.5">
      <p className="font-mono text-[9px] tracking-[0.14em] text-px-faint uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 font-mono text-sm",
          tone === "good"
            ? "text-emerald-300"
            : tone === "warn"
              ? "text-amber-300"
              : "text-px-strong",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function kindColor(kind: string): string {
  if (kind.includes("fail") || kind.includes("error")) {
    return "text-red-300";
  }
  if (kind.includes("gate")) {
    return "text-amber-300";
  }
  if (kind.includes("approval")) {
    return "text-amber-200";
  }
  if (kind.includes("artifact")) {
    return "text-emerald-300";
  }
  if (kind.includes("tool")) {
    return "text-violet-300";
  }
  if (kind.includes("model")) {
    return "text-sky-300";
  }
  return "text-px-muted";
}
