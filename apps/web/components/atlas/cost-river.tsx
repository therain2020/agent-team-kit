"use client";

import { Badge } from "@/components/ui/badge";
import type {
  AtlasCostBucket,
  AtlasCostSource,
  AtlasFlow,
  AtlasNode,
} from "@/lib/atlas";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { STATUS_THEME, agentColor, formatCost, truncateLabel } from "./theme";

const PAD = 30;
const GAP = 9;
const X0 = 150;
const X1 = 610;
const W = 760;

interface Band {
  top: number;
  height: number;
}

export function CostRiver({
  flows,
  nodes,
  buckets,
  source,
}: {
  flows: AtlasFlow[];
  nodes: AtlasNode[];
  buckets: AtlasCostBucket[];
  source: AtlasCostSource;
}) {
  const t = useTranslations("atlas");
  const statusT = useTranslations("status");
  const [focus, setFocus] = useState<string | null>(null);

  const model = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const leftTotals = new Map<string, number>();
    const rightTotals = new Map<string, number>();
    let total = 0;

    for (const flow of flows) {
      if (flow.value <= 0) {
        continue;
      }
      total += flow.value;
      leftTotals.set(
        flow.agentId,
        (leftTotals.get(flow.agentId) ?? 0) + flow.value,
      );
      rightTotals.set(
        flow.nodeId,
        (rightTotals.get(flow.nodeId) ?? 0) + flow.value,
      );
    }

    const leftIds = [...leftTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const rightIds = [...rightTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const rows = Math.max(leftIds.length, rightIds.length);
    const height = Math.min(620, Math.max(360, rows * 48 + PAD * 2));
    const usableLeft = height - PAD * 2 - GAP * Math.max(0, leftIds.length - 1);
    const usableRight =
      height - PAD * 2 - GAP * Math.max(0, rightIds.length - 1);
    const scale = total > 0 ? Math.min(usableLeft, usableRight) / total : 0;

    const stack = (
      ids: string[],
      totals: Map<string, number>,
    ): Map<string, Band> => {
      let cursor = PAD;
      const bands = new Map<string, Band>();
      for (const id of ids) {
        const heightValue = (totals.get(id) ?? 0) * scale;
        bands.set(id, { top: cursor, height: heightValue });
        cursor += heightValue + GAP;
      }
      return bands;
    };

    const leftBands = stack(leftIds, leftTotals);
    const rightBands = stack(rightIds, rightTotals);
    const leftOrder = new Map(leftIds.map((id, index) => [id, index]));
    const rightOrder = new Map(rightIds.map((id, index) => [id, index]));

    const ordered = [...flows]
      .filter((flow) => flow.value > 0)
      .sort(
        (a, b) =>
          (leftOrder.get(a.agentId) ?? 99) - (leftOrder.get(b.agentId) ?? 99) ||
          (rightOrder.get(a.nodeId) ?? 99) - (rightOrder.get(b.nodeId) ?? 99),
      );

    const leftCursor = new Map(
      leftIds.map((id) => [id, leftBands.get(id)?.top ?? PAD]),
    );
    const rightCursor = new Map(
      rightIds.map((id) => [id, rightBands.get(id)?.top ?? PAD]),
    );

    const spreadLabels = (ids: string[], bands: Map<string, Band>) => {
      const count = ids.length;
      const step =
        count > 1 ? Math.min(58, (height - PAD * 2 - 16) / (count - 1)) : 0;
      const start = count > 1 ? PAD + 8 : height / 2;
      return new Map(
        ids.map((id, index) => {
          const band = bands.get(id);
          return [
            id,
            {
              y: start + index * step,
              bandY: (band?.top ?? PAD) + Math.max(6, (band?.height ?? 0) / 2),
            },
          ];
        }),
      );
    };

    const ribbons = ordered.flatMap((flow) => {
      const target = byId.get(flow.nodeId);
      if (!target) {
        return [];
      }
      const thickness = flow.value * scale;
      const sy = leftCursor.get(flow.agentId) ?? PAD;
      const ty = rightCursor.get(flow.nodeId) ?? PAD;
      leftCursor.set(flow.agentId, sy + thickness);
      rightCursor.set(flow.nodeId, ty + thickness);
      const mid = (X0 + X1) / 2;
      const d = [
        `M ${X0} ${sy}`,
        `C ${mid} ${sy}, ${mid} ${ty}, ${X1} ${ty}`,
        `L ${X1} ${ty + thickness}`,
        `C ${mid} ${ty + thickness}, ${mid} ${sy + thickness}, ${X0} ${sy + thickness}`,
        "Z",
      ].join(" ");
      return [
        {
          flow,
          target,
          d,
          color: STATUS_THEME[target.status].line,
        },
      ];
    });

    return {
      height,
      total,
      leftIds,
      rightIds,
      leftBands,
      rightBands,
      leftTotals,
      rightTotals,
      leftLabels: spreadLabels(leftIds, leftBands),
      rightLabels: spreadLabels(rightIds, rightBands),
      ribbons,
      byId,
    };
  }, [flows, nodes]);

  const sourceLabel =
    source === "charges"
      ? t("costSourceCharges")
      : source === "manifest"
        ? t("costSourceManifest")
        : source === "demo"
          ? t("costSourceDemo")
          : t("costSourceEmpty");
  const bucketMax = Math.max(0.0001, ...buckets.map((bucket) => bucket.cny));

  return (
    <section className="border border-px-line bg-px-panel">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-px-line bg-px-panel2 px-3 py-2">
        <div>
          <h2 className="font-mono text-[11px] font-bold tracking-[0.16em] text-px-strong uppercase">
            {t("riverTitle")}
          </h2>
          <p className="mt-0.5 font-mono text-[10px] text-px-muted">
            {t("riverHint")}
          </p>
        </div>
        <span className="flex items-center gap-2">
          <Badge variant={source === "charges" ? "success" : "default"}>
            {sourceLabel}
          </Badge>
          <span className="font-mono text-[10px] text-px-muted">
            {formatCost(model.total)}
          </span>
        </span>
      </header>

      {model.total <= 0 ? (
        <p className="px-3 py-3 font-mono text-[11px] text-px-muted">
          {t("riverEmpty")}
        </p>
      ) : (
        <div className="px-3 py-2">
          <svg
            viewBox={`0 0 ${W} ${model.height}`}
            className="block w-full"
            role="img"
            aria-label={t("riverAria")}
          >
            <defs>
              {model.rightIds.map((id) => {
                const node = model.byId.get(id);
                const color = node ? STATUS_THEME[node.status].line : "#75849b";
                return (
                  <linearGradient
                    key={id}
                    id={`atlas-river-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="0"
                  >
                    <stop offset="0%" stopColor="#8492a8" stopOpacity="0.22" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.68" />
                  </linearGradient>
                );
              })}
            </defs>

            <text
              x={X0 - 8}
              y={16}
              textAnchor="end"
              fontSize={9}
              fill="#75849b"
            >
              {t("agentColumn")}
            </text>
            <text x={X1 + 8} y={16} fontSize={9} fill="#75849b">
              {t("stageColumn")}
            </text>

            {model.ribbons.map(({ flow, d, target }) => {
              const active = !focus || focus === flow.id;
              return (
                <path
                  key={flow.id}
                  d={d}
                  fill={`url(#atlas-river-${flow.nodeId.replace(/[^a-zA-Z0-9_-]/g, "-")})`}
                  opacity={active ? 0.82 : 0.16}
                  onMouseEnter={() => setFocus(flow.id)}
                  onMouseLeave={() => setFocus(null)}
                  className="transition-opacity duration-200"
                >
                  <title>
                    {`${flow.agentId} → ${target.name}: ${formatCost(flow.value)}`}
                  </title>
                </path>
              );
            })}

            {model.leftIds.map((id) => {
              const band = model.leftBands.get(id);
              const label = model.leftLabels.get(id);
              if (!band || !label) {
                return null;
              }
              return (
                <g key={`agent-${id}`}>
                  <rect
                    x={X0 - 7}
                    y={band.top}
                    width={7}
                    height={Math.max(2, band.height)}
                    fill={agentColor(id === "unattributed" ? undefined : id)}
                    opacity={0.9}
                  />
                  <path
                    d={`M ${X0 - 12} ${label.y} L ${X0 - 9} ${label.bandY}`}
                    stroke="rgba(132,146,168,0.25)"
                    strokeWidth={0.8}
                    fill="none"
                  />
                  <text
                    x={X0 - 14}
                    y={label.y + 3}
                    textAnchor="end"
                    fontSize={10}
                    fill="#dbe4ee"
                    fontFamily="ui-monospace, monospace"
                  >
                    {id === "unattributed"
                      ? t("unattributed")
                      : truncateLabel(id, 14)}
                  </text>
                  <text
                    x={X0 - 14}
                    y={label.y + 14}
                    textAnchor="end"
                    fontSize={8.5}
                    fill="#75849b"
                    fontFamily="ui-monospace, monospace"
                  >
                    {formatCost(model.leftTotals.get(id) ?? 0)}
                  </text>
                </g>
              );
            })}

            {model.rightIds.map((id) => {
              const band = model.rightBands.get(id);
              const label = model.rightLabels.get(id);
              const node = model.byId.get(id);
              if (!band || !label || !node) {
                return null;
              }
              const theme = STATUS_THEME[node.status];
              return (
                <g key={`node-${id}`}>
                  <rect
                    x={X1}
                    y={band.top}
                    width={7}
                    height={Math.max(2, band.height)}
                    fill={theme.line}
                    opacity={0.85}
                  />
                  <path
                    d={`M ${X1 + 9} ${label.bandY} L ${X1 + 12} ${label.y}`}
                    stroke="rgba(132,146,168,0.25)"
                    strokeWidth={0.8}
                    fill="none"
                  />
                  <text
                    x={X1 + 14}
                    y={label.y + 3}
                    fontSize={10}
                    fill="#dbe4ee"
                  >
                    {truncateLabel(node.name, 14)}
                  </text>
                  <text
                    x={X1 + 14}
                    y={label.y + 14}
                    fontSize={8.5}
                    fill="#75849b"
                    fontFamily="ui-monospace, monospace"
                  >
                    {formatCost(model.rightTotals.get(id) ?? 0)}
                  </text>
                </g>
              );
            })}
          </svg>

          {buckets.length > 0 ? (
            <div className="mt-2 border-t border-px-line pt-2">
              <p className="mb-1 font-mono text-[9px] tracking-[0.14em] text-px-faint uppercase">
                {t("riverBuckets")}
              </p>
              <div
                className="flex h-6 items-end gap-0.5"
                role="img"
                aria-label={t("riverBucketsAria")}
              >
                {buckets.map((bucket) => (
                  <span
                    key={bucket.at}
                    className="min-w-0 flex-1 bg-px-accent/70"
                    style={{
                      height: `${Math.max(6, (bucket.cny / bucketMax) * 100)}%`,
                    }}
                    title={`${bucket.at} · ${formatCost(bucket.cny)}`}
                  />
                ))}
              </div>
            </div>
          ) : null}

          <details className="mt-2 border-t border-px-line pt-2 font-mono text-[10px] text-px-muted">
            <summary className="cursor-pointer text-px-faint hover:text-px-text">
              {t("tableView")}
            </summary>
            <table className="mt-2 w-full border-collapse text-left">
              <caption className="sr-only">{t("riverTitle")}</caption>
              <thead>
                <tr className="text-px-faint">
                  <th scope="col" className="border border-px-line px-1.5 py-1">
                    {t("tableAgent")}
                  </th>
                  <th scope="col" className="border border-px-line px-1.5 py-1">
                    {t("tableStage")}
                  </th>
                  <th scope="col" className="border border-px-line px-1.5 py-1">
                    {t("tableStatus")}
                  </th>
                  <th scope="col" className="border border-px-line px-1.5 py-1">
                    {t("cost")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {model.ribbons.map(({ flow, target }) => (
                  <tr key={`table-${flow.id}`}>
                    <th
                      scope="row"
                      className="border border-px-line px-1.5 py-1 text-px-text"
                    >
                      {flow.agentId === "unattributed"
                        ? t("unattributed")
                        : flow.agentId}
                    </th>
                    <td className="border border-px-line px-1.5 py-1">
                      {target.name}
                    </td>
                    <td className="border border-px-line px-1.5 py-1">
                      {statusT(target.status)}
                    </td>
                    <td className="border border-px-line px-1.5 py-1">
                      {formatCost(flow.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </section>
  );
}
