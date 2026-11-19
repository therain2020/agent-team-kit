"use client";

import type { AtlasNode } from "@/lib/atlas";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { STATUS_THEME, formatCost, formatSpan, truncateLabel } from "./theme";

interface Row {
  node: AtlasNode;
  start: number | null;
  end: number | null;
  left: number;
  width: number;
}

export function TraceWaterfall({
  nodes,
  now,
  selectedId,
  onSelect,
}: {
  nodes: AtlasNode[];
  now: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("atlas");
  const statusT = useTranslations("status");

  const { rows, t0, span } = useMemo(() => {
    const nowMs = Date.parse(now);
    const timed = nodes
      .map((node) => {
        const start = node.startedAt ? Date.parse(node.startedAt) : null;
        const end = node.endedAt
          ? Date.parse(node.endedAt)
          : start !== null &&
              (node.status === "running" || node.status === "waiting")
            ? nowMs
            : start;
        return { node, start, end };
      })
      .filter(
        (row): row is { node: AtlasNode; start: number; end: number } =>
          row.start !== null &&
          row.end !== null &&
          Number.isFinite(row.start) &&
          Number.isFinite(row.end),
      );

    const start =
      timed.length > 0
        ? Math.min(...timed.map((row) => row.start))
        : nowMs - 60_000;
    const end =
      timed.length > 0 ? Math.max(...timed.map((row) => row.end)) : nowMs;
    const total = Math.max(60_000, end - start);

    const all: Row[] = nodes.map((node) => {
      const found = timed.find((row) => row.node.id === node.id);
      if (!found) {
        return { node, start: null, end: null, left: 0, width: 0 };
      }
      return {
        node,
        start: found.start,
        end: found.end,
        left: ((found.start - start) / total) * 100,
        width: Math.max(1.2, ((found.end - found.start) / total) * 100),
      };
    });

    return { rows: all, t0: start, span: total };
  }, [nodes, now]);

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <section className="border border-px-line bg-px-panel">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-px-line bg-px-panel2 px-3 py-2">
        <div>
          <h2 className="font-mono text-[11px] font-bold tracking-[0.16em] text-px-strong uppercase">
            {t("waterfallTitle")}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-px-muted">
            {t("waterfallHint")}
          </p>
        </div>
        <span className="font-mono text-[10px] text-px-muted">
          {formatSpan(span)}
        </span>
      </header>

      <div className="px-3 pt-2">
        <div className="pl-[9.5rem] pr-12">
          <div className="relative h-4 border-b border-px-line">
            {ticks.map((tick) => (
              <span
                key={tick}
                className="absolute top-0 -translate-x-1/2 font-mono text-[9px] text-px-faint"
                style={{ left: `${tick * 100}%` }}
              >
                {tick === 0 ? "0m" : `+${Math.round((span * tick) / 60_000)}m`}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-1 space-y-0.5">
          {rows.map((row, index) => {
            const theme = STATUS_THEME[row.node.status];
            const pending = row.start === null;
            const selected = selectedId === row.node.id;
            const durationMs =
              row.start !== null && row.end !== null
                ? row.end - row.start
                : null;
            return (
              <div
                key={row.node.id}
                id={`atlas-row-${row.node.id}`}
                className={cn(
                  "grid grid-cols-[9.5rem_minmax(0,1fr)_3rem] items-center gap-2 px-1 py-1",
                  selected && "bg-px-hi/70",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(row.node.id)}
                  className="flex min-w-0 items-center gap-2 px-1.5 py-1 text-left"
                >
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", theme.dot)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11px] text-px-text">
                      {truncateLabel(row.node.name, 16)}
                      {row.node.current ? (
                        <span className="text-px-accent"> ◂</span>
                      ) : null}
                    </span>
                    <span className="block truncate font-mono text-[9px] text-px-faint">
                      {row.node.agentId ?? "—"} ·{" "}
                      {pending ? t("awaiting") : statusT(row.node.status)}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => onSelect(row.node.id)}
                  className="group relative h-8 w-full"
                  aria-label={`${row.node.name} ${
                    durationMs === null ? t("awaiting") : formatSpan(durationMs)
                  }`}
                >
                  <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-px-line/70" />
                  {pending ? (
                    <span className="absolute inset-y-2 left-0 right-0 border border-dashed border-px-line2" />
                  ) : (
                    <>
                      <span
                        className="atlas-bar absolute top-1/2 h-4 -translate-y-1/2"
                        style={{
                          left: `${row.left}%`,
                          width: `${row.width}%`,
                          backgroundImage: `linear-gradient(90deg, ${theme.line}, ${theme.line}66)`,
                          animationDelay: `${index * 45}ms`,
                        }}
                      />
                      {row.node.artifactTimes
                        .slice(0, 12)
                        .map((time, artifactIndex) => {
                          const at = Date.parse(time);
                          if (!Number.isFinite(at)) {
                            return null;
                          }
                          const pct = ((at - t0) / span) * 100;
                          if (pct < 0 || pct > 100) {
                            return null;
                          }
                          return (
                            <span
                              key={`${row.node.id}-artifact-${artifactIndex}`}
                              className="absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full border border-px-ink bg-[#4dd08a]"
                              style={{ left: `calc(${pct}% - 3px)` }}
                            />
                          );
                        })}
                      {row.node.gatePass !== undefined ? (
                        <span
                          className="absolute top-1/2 size-2 -translate-y-1/2 rotate-45 border border-px-ink"
                          style={{
                            left: `calc(${(row.left ?? 0) + (row.width ?? 0)}% - 4px)`,
                            background: row.node.gatePass
                              ? "#4dd08a"
                              : "#e0555a",
                          }}
                        />
                      ) : null}
                    </>
                  )}
                </button>
                <span className="text-right font-mono text-[9px] text-px-faint">
                  {durationMs === null ? "—" : formatSpan(durationMs)}
                </span>
              </div>
            );
          })}
        </div>

        <footer className="mt-2 flex flex-wrap items-center gap-4 border-t border-px-line pt-2 pb-2 font-mono text-[9px] text-px-faint">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-[#4dd08a]" />
            {t("legendArtifact")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rotate-45 bg-[#4dd08a]" />
            {t("legendGate")}
          </span>
        </footer>

        <details className="border-t border-px-line px-1 py-2 font-mono text-[10px] text-px-muted">
          <summary className="cursor-pointer text-px-faint hover:text-px-text">
            {t("tableView")}
          </summary>
          <table className="mt-2 w-full border-collapse text-left">
            <caption className="sr-only">{t("waterfallTitle")}</caption>
            <thead>
              <tr className="text-px-faint">
                <th scope="col" className="border border-px-line px-1.5 py-1">
                  {t("tableStage")}
                </th>
                <th scope="col" className="border border-px-line px-1.5 py-1">
                  {t("tableStatus")}
                </th>
                <th scope="col" className="border border-px-line px-1.5 py-1">
                  {t("tableAgent")}
                </th>
                <th scope="col" className="border border-px-line px-1.5 py-1">
                  {t("elapsed")}
                </th>
                <th scope="col" className="border border-px-line px-1.5 py-1">
                  {t("cost")}
                </th>
                <th scope="col" className="border border-px-line px-1.5 py-1">
                  {t("artifacts")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`table-${row.node.id}`}>
                  <th
                    scope="row"
                    className="border border-px-line px-1.5 py-1 text-px-text"
                  >
                    {row.node.name}
                  </th>
                  <td className="border border-px-line px-1.5 py-1">
                    {statusT(row.node.status)}
                  </td>
                  <td className="border border-px-line px-1.5 py-1">
                    {row.node.agentId ?? "—"}
                  </td>
                  <td className="border border-px-line px-1.5 py-1">
                    {row.start !== null && row.end !== null
                      ? formatSpan(row.end - row.start)
                      : t("awaiting")}
                  </td>
                  <td className="border border-px-line px-1.5 py-1">
                    {formatCost(row.node.costCny)}
                  </td>
                  <td className="border border-px-line px-1.5 py-1">
                    {row.node.artifacts}
                    {row.node.gatePass !== undefined
                      ? ` · ${row.node.gatePass ? t("pass") : t("fail")}`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </section>
  );
}
