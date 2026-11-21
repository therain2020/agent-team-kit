"use client";

import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useStatusLabel } from "@/lib/iteration-labels";
import {
  cn,
  formatCny,
  formatDuration,
  formatNumber,
  timeAgo,
} from "@/lib/utils";
import { useWorld } from "@/lib/world-client";
import {
  type WorldKindFilter,
  type WorldRunMetaMap,
  type WorldRunView,
  isTerminalStatus,
  progressPercent,
  runKind,
  splitWorldRuns,
} from "@/lib/world-view";
import type { AgentState } from "@kit/store";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Inbox,
  Newspaper,
  Play,
  Sun,
  Zap,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { WorldStatus } from "./world-status";

export interface WorldConsoleProps {
  initialRuns: WorldRunView[];
  initialAgents: AgentState[];
  computedAt: string;
  metas: WorldRunMetaMap;
  initialKind: WorldKindFilter;
  activeRunId: string | null;
}

/**
 * `/world` one-layer view (82 §4.1): 进行中 / 需要你 / 今天, exception-first,
 * followed by the unified run + iteration list. Rows are links into the
 * server-rendered drawer, so stage detail stays one click away and the URL
 * remains the source of truth.
 */
export function WorldConsole({
  initialRuns,
  initialAgents,
  computedAt,
  metas,
  initialKind,
  activeRunId,
}: WorldConsoleProps) {
  const t = useTranslations("world");
  const common = useTranslations("common");
  const statusLabel = useStatusLabel();
  const locale = useLocale();

  // One shared subscription per tab (97 §3.2): the store already owns the
  // stream, backoff and resync, so this surface only derives its columns from
  // the latest world. Server-rendered rows cover the first paint.
  const { world } = useWorld();
  const runs = world?.runs ?? initialRuns;
  const agents = world?.agents ?? initialAgents;
  const snapshotAt = world?.computedAt ?? computedAt;

  const [kind, setKind] = useState<WorldKindFilter>(initialKind);
  const [now, setNow] = useState(() => Date.now());
  // Approximate start time for runs materialized after the snapshot; replaced
  // by the next full snapshot once the server knows the real metadata.
  const [startHints, setStartHints] = useState<Record<string, string>>({});

  useEffect(() => {
    setStartHints((current) => {
      let next: Record<string, string> | null = null;
      for (const run of runs) {
        if (metas[run.runId] || current[run.runId]) {
          continue;
        }
        next ??= { ...current };
        next[run.runId] = run.updatedAt;
      }
      return next ?? current;
    });
  }, [runs, metas]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const effectiveMetas = useMemo<WorldRunMetaMap>(() => {
    const hintIds = Object.keys(startHints);
    if (hintIds.length === 0) {
      return metas;
    }
    const merged: WorldRunMetaMap = { ...metas };
    for (const runId of hintIds) {
      if (!merged[runId]) {
        const startedAt = startHints[runId] ?? null;
        merged[runId] = {
          kind: runId.startsWith("it_") ? "iteration" : "run",
          startedAt,
        };
      }
    }
    return merged;
  }, [metas, startHints]);

  const split = useMemo(
    () => splitWorldRuns(runs, effectiveMetas, now),
    [runs, effectiveMetas, now],
  );

  const filtered = useMemo(
    () =>
      runs
        .filter(
          (run) =>
            kind === "all" || runKind(effectiveMetas, run.runId) === kind,
        )
        .slice(0, 80),
    [runs, effectiveMetas, kind],
  );

  const workingAgents = useMemo(
    () => agents.filter((agent) => agent.state === "running").slice(0, 8),
    [agents],
  );

  const elapsedOf = (run: WorldRunView) => {
    const startedAt = effectiveMetas[run.runId]?.startedAt;
    if (!startedAt) {
      return "—";
    }
    const end = isTerminalStatus(run.status)
      ? run.updatedAt
      : new Date(now).toISOString();
    return formatDuration(startedAt, end, locale);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <WorldStatus className="text-[11px]" />
            <span className="text-[11px] text-zinc-500">
              {t("snapshotAt", {
                time: timeAgo(snapshotAt, locale, now),
              })}
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/world?tab=information">
                <Newspaper className="size-3.5" />
                {t("openInformation")}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/world?tab=reactions">
                <Zap className="size-3.5" />
                {t("openReactions")}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/world?tab=activity">
                <Activity className="size-3.5" />
                {t("openActivity")}
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/packs">
                <Play className="size-3.5" />
                {common("startRun")}
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-3">
        <Column
          icon={CircleDashed}
          iconClass="text-sky-400"
          title={t("inProgress")}
          count={split.inProgress.length}
        >
          {split.inProgress.length === 0 ? (
            <ColumnEmpty title={t("noRunning")} hint={t("noRunningHint")} />
          ) : (
            split.inProgress.map((run) => (
              <ProgressCard
                key={run.runId}
                run={run}
                kindLabel={t(
                  runKind(effectiveMetas, run.runId) === "iteration"
                    ? "kindIteration"
                    : "kindRun",
                )}
                statusLabel={statusLabel(run.status)}
                elapsed={elapsedOf(run)}
                stageLabel={stageLabel(run.currentStage)}
                active={run.runId === activeRunId}
              />
            ))
          )}
          {workingAgents.length > 0 ? (
            <div className="mt-1 border-t border-border/60 pt-2">
              <p className="px-1 text-[10px] uppercase tracking-wider text-zinc-600">
                {t("agentsWorking", { count: workingAgents.length })}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {workingAgents.map((agent) => (
                  <span
                    key={agent.agentId}
                    className="inline-flex items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                  >
                    <span className="size-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
                    {agent.agentId}
                    {agent.currentTool ? (
                      <span className="text-zinc-500">{agent.currentTool}</span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </Column>

        <Column
          icon={AlertTriangle}
          iconClass="text-amber-400"
          title={t("needsYou")}
          count={split.needsYou.length}
        >
          {split.needsYou.length === 0 ? (
            <ColumnEmpty
              icon={CheckCircle2}
              title={t("allClear")}
              hint={t("allClearHint")}
            />
          ) : (
            split.needsYou.map((run) => (
              <NeedsYouCard
                key={run.runId}
                run={run}
                kindLabel={t(
                  runKind(effectiveMetas, run.runId) === "iteration"
                    ? "kindIteration"
                    : "kindRun",
                )}
                statusLabel={statusLabel(run.status)}
                elapsed={elapsedOf(run)}
                stageLabel={stageLabel(run.currentStage)}
                updated={timeAgo(run.updatedAt, locale, now)}
                active={run.runId === activeRunId}
              />
            ))
          )}
        </Column>

        <Column
          icon={Sun}
          iconClass="text-emerald-400"
          title={t("today")}
          count={split.startedToday.length}
        >
          <div className="grid grid-cols-2 gap-1.5">
            <MiniStat
              label={t("startedToday")}
              value={formatNumber(split.startedToday.length)}
            />
            <MiniStat
              label={t("passRate")}
              value={split.passRate === null ? "—" : `${split.passRate}%`}
            />
            <MiniStat
              label={t("spendToday")}
              value={formatCny(split.spendToday)}
            />
            <MiniStat
              label={t("tokensToday")}
              value={formatNumber(split.tokensToday)}
            />
          </div>
          <p className="mt-2 px-1 text-[10px] uppercase tracking-wider text-zinc-600">
            {t("finishedToday")}
          </p>
          {split.finishedToday.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-zinc-500">
              {t("noneToday")}
            </p>
          ) : (
            split.finishedToday.slice(0, 5).map((run) => (
              <Link
                key={run.runId}
                href={runHref(run.runId)}
                className="flex items-center gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-accent/40"
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    run.status === "succeeded"
                      ? "bg-emerald-400"
                      : "bg-red-400",
                  )}
                />
                <span className="truncate font-mono text-zinc-300">
                  {run.runId}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
                  {formatCny(run.costCny)}
                </span>
              </Link>
            ))
          )}
        </Column>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold text-zinc-100">
            {t("listTitle")}
          </h2>
          <span className="text-[11px] text-zinc-500">
            {t("listDescription", { count: runs.length })}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {(
              [
                ["all", t("filterAll")],
                ["run", t("filterRuns")],
                ["iteration", t("filterIterations")],
              ] as Array<[WorldKindFilter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-zinc-200",
                  kind === value && "bg-accent text-zinc-100",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-zinc-500">
            {t("emptyList")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((run) => (
              <li key={run.runId}>
                <Link
                  href={runHref(run.runId)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/50",
                    run.runId === activeRunId && "bg-accent/40",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-mono text-[12px] text-zinc-200">
                        {run.runId}
                      </span>
                      <Badge variant="outline">
                        {t(
                          runKind(effectiveMetas, run.runId) === "iteration"
                            ? "kindIteration"
                            : "kindRun",
                        )}
                      </Badge>
                      <Badge variant={statusVariant(run.status)}>
                        {statusLabel(run.status)}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                      {stageLabel(run.currentStage)}
                      {" · "}
                      {t("updated", {
                        time: timeAgo(run.updatedAt, locale, now),
                      })}
                      {blockedText(run) ? ` · ${blockedText(run)}` : ""}
                    </p>
                  </div>
                  <span className="hidden w-20 shrink-0 text-right font-mono text-[10px] text-zinc-500 sm:block">
                    {elapsedOf(run)}
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono text-[11px] text-zinc-400">
                    {formatCny(run.costCny)}
                  </span>
                  <ArrowRight className="size-3 shrink-0 text-zinc-600" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );

  function blockedText(run: WorldRunView): string {
    if (run.waitReason) {
      return run.waitReason;
    }
    if (run.status === "failed") {
      return t("blocked");
    }
    return "";
  }

  function stageLabel(stage: string | null): string {
    if (!stage) {
      return t("stageNone");
    }
    const parts = stage.split(":");
    return parts.length > 1 ? (parts[1] ?? stage) : stage;
  }
}

// Rows open the job detail hub (#107); the timeline is one tab away.
function runHref(runId: string): string {
  return `/world?run=${encodeURIComponent(runId)}&tab=hub`;
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

function Column({
  icon: Icon,
  iconClass,
  title,
  count,
  children,
}: {
  icon: typeof Activity;
  iconClass: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="flex max-h-[26rem] min-h-[12rem] flex-col rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className={cn("size-3.5", iconClass)} />
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
          {title}
        </h2>
        <span className="ml-auto font-mono text-[11px] text-zinc-500">
          {count}
        </span>
      </header>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {children}
      </div>
    </section>
  );
}

function ColumnEmpty({
  icon: Icon = Inbox,
  title,
  hint,
}: {
  icon?: typeof Inbox;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center">
      <Icon className="mb-2 size-5 text-zinc-600" />
      <p className="text-xs text-zinc-300">{title}</p>
      {hint ? <p className="mt-1 text-[10px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-xs text-zinc-200">{value}</p>
    </div>
  );
}

function ProgressCard({
  run,
  kindLabel,
  statusLabel,
  elapsed,
  stageLabel,
  active,
}: {
  run: WorldRunView;
  kindLabel: string;
  statusLabel: string;
  elapsed: string;
  stageLabel: string;
  active: boolean;
}) {
  const percent = progressPercent(run);
  return (
    <Link
      href={runHref(run.runId)}
      className={cn(
        "block rounded-md border border-border bg-background/40 px-2.5 py-2 transition-colors hover:border-zinc-600 hover:bg-accent/40",
        active && "border-sky-500/40 bg-sky-500/5",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[11px] text-zinc-200">
          {run.runId}
        </span>
        <span className="shrink-0 rounded bg-zinc-800/70 px-1 text-[9px] uppercase tracking-wide text-zinc-500">
          {kindLabel}
        </span>
        <Badge variant={statusVariant(run.status)} className="shrink-0">
          {statusLabel}
        </Badge>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
          {elapsed}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-sky-500/70 transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="w-8 text-right font-mono text-[10px] text-zinc-500">
          {percent}%
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-500">
        <span className="truncate">{stageLabel}</span>
        <span className="ml-auto shrink-0">{formatCny(run.costCny)}</span>
      </div>
    </Link>
  );
}

function NeedsYouCard({
  run,
  kindLabel,
  statusLabel,
  elapsed,
  stageLabel,
  updated,
  active,
}: {
  run: WorldRunView;
  kindLabel: string;
  statusLabel: string;
  elapsed: string;
  stageLabel: string;
  updated: string;
  active: boolean;
}) {
  const paused = run.status === "paused";
  return (
    <Link
      href={runHref(run.runId)}
      className={cn(
        "block rounded-md border px-2.5 py-2 transition-colors",
        paused
          ? "border-amber-500/25 bg-amber-500/5 hover:bg-amber-500/10"
          : "border-red-500/25 bg-red-500/5 hover:bg-red-500/10",
        active && "ring-1 ring-zinc-500/40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="truncate font-mono text-[11px] text-zinc-200">
          {run.runId}
        </span>
        <span className="shrink-0 rounded bg-zinc-800/70 px-1 text-[9px] uppercase tracking-wide text-zinc-500">
          {kindLabel}
        </span>
        <Badge variant={statusVariant(run.status)} className="shrink-0">
          {statusLabel}
        </Badge>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
          {elapsed}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 line-clamp-2 text-[10px]",
          paused ? "text-amber-200/80" : "text-red-200/80",
        )}
      >
        {run.waitReason ?? stageLabel}
      </p>
      <p className="mt-0.5 text-[9px] text-zinc-500">
        {formatCny(run.costCny)} · {updated}
      </p>
    </Link>
  );
}
