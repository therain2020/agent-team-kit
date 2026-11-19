"use client";

import { Badge } from "@/components/ui/badge";
import type { AtlasRun } from "@/lib/atlas";
import { cn } from "@/lib/utils";
import { atlasHref } from "@/lib/world-view";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { CostRiver } from "./cost-river";
import { EvidenceChain } from "./evidence-chain";
import { LivingFlow } from "./living-flow";
import {
  STATUS_THEME,
  agentColor,
  formatCost,
  formatTokens,
  truncateLabel,
} from "./theme";
import { TraceWaterfall } from "./trace-waterfall";
import { useReducedMotion } from "./use-reduced-motion";
import { Vitals } from "./vitals";

const LEGEND_STATUSES = [
  "succeeded",
  "running",
  "failed",
  "waiting",
  "pending",
] as const;

export function AtlasView({ data }: { data: AtlasRun }) {
  const t = useTranslations("atlas");
  const statusT = useTranslations("status");
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      data.nodes.find((node) => node.current)?.id ??
      data.nodes.find((node) => node.status === "running")?.id ??
      data.nodes.find((node) => node.status === "failed")?.id ??
      data.nodes[0]?.id ??
      null,
  );

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      const row = document.getElementById(`atlas-row-${id}`);
      row?.scrollIntoView({
        block: "nearest",
        behavior: reducedMotion ? "auto" : "smooth",
      });
      const node = data.nodes.find((entry) => entry.id === id);
      const artifactKey = node?.artifactKeys[0];
      if (artifactKey) {
        router.replace(atlasHref({ runId: data.runId, artifactKey }), {
          scroll: false,
        });
      }
    },
    [data.nodes, data.runId, reducedMotion, router],
  );

  const currentStage =
    data.nodes.find((node) => node.current) ??
    data.nodes.find((node) => node.status === "running") ??
    null;
  const topAgent = data.agents.find(
    (agent) => agent.id !== "unattributed" && agent.costCny > 0,
  );
  const stuck = data.status === "paused" || data.waitReason !== null;

  const runVariant =
    data.status === "running"
      ? "info"
      : data.status === "succeeded"
        ? "success"
        : data.status === "failed"
          ? "danger"
          : data.status === "paused"
            ? "warning"
            : "outline";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="atlas-run-select">
          {t("selectRun")}
        </label>
        <select
          id="atlas-run-select"
          value={
            data.runs.some((run) => run.runId === data.runId) ? data.runId : ""
          }
          onChange={(event) => {
            const value = event.target.value;
            if (value) {
              router.push(atlasHref({ runId: value }));
            }
          }}
          className="h-8 max-w-[24rem] border border-px-line2 bg-px-ink px-2 font-mono text-[11px] text-px-text"
        >
          {data.runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.workflowId} · {run.runId.slice(-12)} · {run.status} ·{" "}
              {Math.round(run.progress * 100)}%
            </option>
          ))}
          {data.demo && !data.runs.some((run) => run.runId === data.runId) ? (
            <option value={data.runId}>content-launch · demo</option>
          ) : null}
        </select>

        <Badge variant={runVariant}>{statusT(data.status)}</Badge>
        <span className="font-mono text-[10px] text-px-faint">
          {data.workflowId} · {data.runId}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {LEGEND_STATUSES.map((status) => (
            <span
              key={status}
              className="flex items-center gap-1 font-mono text-[9px] text-px-faint"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  STATUS_THEME[status].dot,
                )}
              />
              {statusT(status)}
            </span>
          ))}
        </span>
      </div>

      {data.demo ? (
        <div className="flex flex-wrap items-center gap-2 border border-amber-700 bg-px-warn-bg px-3 py-2 font-mono text-[10px] text-amber-200">
          <span className="border border-amber-600 px-1.5 py-0.5 text-[9px] tracking-[0.12em] text-amber-300 uppercase">
            {t("demoBadge")}
          </span>
          <span>{t("demoBody")}</span>
        </div>
      ) : null}

      {/* Five-second read: current stage, stuck state, biggest spender. */}
      <div className="grid gap-1.5 sm:grid-cols-3">
        <SummaryCell
          label={t("summaryCurrent")}
          value={currentStage ? currentStage.name : t("summaryNone")}
          tone={currentStage?.status === "failed" ? "bad" : "default"}
        />
        <SummaryCell
          label={t("summaryStuck")}
          value={
            stuck ? (data.waitReason ?? t("summaryPaused")) : t("summaryFlow")
          }
          tone={stuck ? "warn" : "good"}
        />
        <SummaryCell
          label={t("summaryTopCost")}
          value={
            topAgent
              ? `${truncateLabel(topAgent.id, 16)} · ${formatCost(topAgent.costCny)}`
              : t("summaryNoCost")
          }
        />
      </div>

      <section className="border border-px-line bg-px-panel">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-px-line bg-px-panel2 px-3 py-2">
          <div>
            <h2 className="font-mono text-[11px] font-bold tracking-[0.16em] text-px-strong uppercase">
              {t("flowTitle")}
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-px-muted">
              {t("flowHint")}
            </p>
          </div>
          <span className="font-mono text-[10px] text-px-faint">
            {data.nodes.length} {t("stages")} · {data.agents.length}{" "}
            {t("agents")}
          </span>
        </header>
        <div className="px-3 py-2.5">
          <LivingFlow
            nodes={data.nodes}
            edges={data.edges}
            selectedId={selectedId}
            onSelect={select}
          />
          <p className="mt-2 font-mono text-[9px] text-px-faint">
            {t("selectStage")}
          </p>
        </div>
      </section>

      <Vitals data={data} />

      <TraceWaterfall
        nodes={data.nodes}
        now={data.now}
        selectedId={selectedId}
        onSelect={select}
      />

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <CostRiver
          flows={data.flows}
          nodes={data.nodes}
          buckets={data.costBuckets}
          source={data.costSource}
        />
        <div className="grid content-start gap-3">
          <EvidenceChain evidence={data.evidence} runId={data.runId} />
          <AgentLedger data={data} />
        </div>
      </div>

      <p className="font-mono text-[9px] text-px-faint">
        {data.source === "store" ? t("sourceStore") : t("sourceDemo")}
      </p>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  return (
    <div className="border border-px-line bg-px-panel px-2.5 py-2">
      <p className="font-mono text-[9px] tracking-[0.14em] text-px-faint uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate font-mono text-[12px]",
          tone === "good"
            ? "text-emerald-300"
            : tone === "warn"
              ? "text-amber-300"
              : tone === "bad"
                ? "text-red-300"
                : "text-px-strong",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function AgentLedger({ data }: { data: AtlasRun }) {
  const t = useTranslations("atlas");
  const statusT = useTranslations("status");
  const max = useMemo(
    () => Math.max(0.0001, ...data.agents.map((agent) => agent.costCny)),
    [data.agents],
  );
  return (
    <section className="border border-px-line bg-px-panel">
      <header className="flex items-baseline justify-between gap-2 border-b border-px-line bg-px-panel2 px-3 py-2">
        <div>
          <h2 className="font-mono text-[11px] font-bold tracking-[0.16em] text-px-strong uppercase">
            {t("ledgerTitle")}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-px-muted">
            {t("ledgerHint")}
          </p>
        </div>
        <span className="font-mono text-[10px] text-px-faint">
          {data.agents.length}
        </span>
      </header>
      <ul className="space-y-2 px-3 py-2.5">
        {data.agents.map((agent) => {
          const theme = STATUS_THEME[agent.status];
          return (
            <li key={agent.id}>
              <div className="flex items-center gap-2">
                <span
                  className="size-1.5 rounded-full"
                  style={{
                    background: agentColor(
                      agent.id === "unattributed" ? undefined : agent.id,
                    ),
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-px-text">
                  {agent.id === "unattributed"
                    ? t("unattributed")
                    : truncateLabel(agent.id, 18)}
                </span>
                <span
                  className={cn("font-mono text-[9px] uppercase", theme.text)}
                >
                  {statusT(agent.status)}
                </span>
                <span className="w-14 text-right font-mono text-[10px] text-px-muted">
                  {formatCost(agent.costCny)}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden bg-px-line/60">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.max(2, (agent.costCny / max) * 100)}%`,
                      background: agentColor(
                        agent.id === "unattributed" ? undefined : agent.id,
                      ),
                      opacity: 0.75,
                    }}
                  />
                </div>
                <span className="w-14 text-right font-mono text-[9px] text-px-faint">
                  {formatTokens(agent.tokens)}
                </span>
              </div>
            </li>
          );
        })}
        {data.agents.length === 0 ? (
          <li className="font-mono text-[11px] text-px-faint">
            {t("noAgents")}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
