"use client";

import type { AtlasEdge, AtlasNode } from "@/lib/atlas";
import { cn } from "@/lib/utils";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  STATUS_THEME,
  agentColor,
  formatCost,
  formatSpan,
  truncateLabel,
} from "./theme";

const NODE_W = 156;
const NODE_H = 82;
const COL_GAP = 46;
const LANE_H = 118;
const PAD_X = 26;
const PAD_Y = 22;
const LOOP_ROOM = 46;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 1.8;

interface Positioned extends AtlasNode {
  x: number;
  y: number;
}

export function LivingFlow({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("atlas");
  const statusT = useTranslations("status");
  const [hovered, setHovered] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(() => {
    const maxColumn = Math.max(0, ...nodes.map((node) => node.column));
    const maxLane = Math.max(0, ...nodes.map((node) => node.lane));
    const contentW = PAD_X * 2 + (maxColumn + 1) * NODE_W + maxColumn * COL_GAP;
    const contentH = PAD_Y * 2 + (maxLane + 1) * LANE_H + LOOP_ROOM;

    const positioned: Positioned[] = nodes.map((node) => ({
      ...node,
      x: PAD_X + node.column * (NODE_W + COL_GAP),
      y: PAD_Y + node.lane * LANE_H + (LANE_H - NODE_H) / 2,
    }));
    const byId = new Map(positioned.map((node) => [node.id, node]));
    return { positioned, byId, contentW, contentH, maxLane };
  }, [nodes]);

  const { positioned, byId, contentW, contentH, maxLane } = layout;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const available = element.clientWidth - 8;
    if (available <= 0) {
      return;
    }
    const next = Math.min(1, available / contentW);
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(next.toFixed(2)))));
  }, [contentW]);

  const pathFor = (edge: AtlasEdge): string => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      return "";
    }
    if (edge.kind === "loop") {
      const baseY = PAD_Y + (maxLane + 1) * LANE_H + 12;
      const x1 = from.x + NODE_W / 2;
      const y1 = from.y + NODE_H;
      const x2 = to.x + NODE_W / 2;
      const y2 = to.y + NODE_H;
      return `M ${x1} ${y1} C ${x1} ${baseY}, ${x2} ${baseY}, ${x2} ${y2}`;
    }
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  };

  const fit = () => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const available = element.clientWidth - 8;
    const next = Math.min(1, available / contentW);
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(next.toFixed(2)))));
  };

  const focus = hovered;
  const isRelevant = (edge: AtlasEdge) =>
    !focus || edge.from === focus || edge.to === focus;

  return (
    <div className="relative">
      <div className="relative mb-2 flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - 0.1))}
          className="grid size-7 place-items-center border border-px-line bg-px-panel3 text-px-muted transition-colors hover:text-px-strong"
          aria-label={t("zoomOut")}
        >
          <Minus className="size-3.5" />
        </button>
        <span className="min-w-10 text-center font-mono text-[10px] text-px-faint">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + 0.1))}
          className="grid size-7 place-items-center border border-px-line bg-px-panel3 text-px-muted transition-colors hover:text-px-strong"
          aria-label={t("zoomIn")}
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={fit}
          className="grid size-7 place-items-center border border-px-line bg-px-panel3 text-px-muted transition-colors hover:text-px-strong"
          aria-label={t("fit")}
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative overflow-auto border border-px-line bg-px-ink/80"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(rgba(148,163,184,0.16)_1px,transparent_1px)] [background-size:22px_22px]"
          aria-hidden="true"
        />
        <svg
          viewBox={`0 0 ${contentW} ${contentH}`}
          style={{ width: contentW * zoom, height: contentH * zoom }}
          className="relative block"
          role="img"
          aria-label={t("flowAria")}
        >
          <defs>
            <linearGradient
              id="atlas-edge-complete"
              x1="0"
              y1="0"
              x2="1"
              y2="0"
            >
              <stop offset="0%" stopColor="#4dd08a" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#4f9dff" stopOpacity="0.45" />
            </linearGradient>
            <filter
              id="atlas-glow"
              x="-60%"
              y="-60%"
              width="220%"
              height="220%"
            >
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <marker
              id="atlas-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(148,163,184,0.55)" />
            </marker>
            <marker
              id="atlas-arrow-live"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#4f9dff" />
            </marker>
            <marker
              id="atlas-arrow-loop"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#e8a33d" />
            </marker>
          </defs>

          {edges.map((edge) => {
            const d = pathFor(edge);
            if (!d) {
              return null;
            }
            const loop = edge.kind === "loop";
            const color = loop
              ? "#e8a33d"
              : edge.active
                ? "#4f9dff"
                : "url(#atlas-edge-complete)";
            const marker = loop
              ? "url(#atlas-arrow-loop)"
              : edge.active
                ? "url(#atlas-arrow-live)"
                : "url(#atlas-arrow)";
            return (
              <g
                key={edge.id}
                opacity={isRelevant(edge) ? 1 : 0.18}
                className="transition-opacity duration-300"
              >
                <path
                  d={d}
                  fill="none"
                  stroke="rgba(148,163,184,0.22)"
                  strokeWidth={loop ? 1.2 : 1.5}
                  strokeDasharray={loop ? "5 5" : undefined}
                  markerEnd={marker}
                />
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={edge.active ? 2.2 : 1.6}
                  strokeLinecap="round"
                  markerEnd={marker}
                  opacity={edge.active ? 0.95 : 0.8}
                />
                {edge.active ? (
                  <path
                    d={d}
                    fill="none"
                    stroke={loop ? "#fde68a" : "#bae6fd"}
                    strokeWidth={3.4}
                    strokeLinecap="round"
                    strokeDasharray="0.5 13"
                    className="atlas-flow"
                    filter="url(#atlas-glow)"
                  />
                ) : null}
              </g>
            );
          })}

          {positioned.map((node) => (
            <FlowNode
              key={node.id}
              node={node}
              selected={selectedId === node.id}
              dimmed={Boolean(
                focus &&
                  focus !== node.id &&
                  !edges.some(
                    (edge) =>
                      (edge.from === focus && edge.to === node.id) ||
                      (edge.to === focus && edge.from === node.id),
                  ),
              )}
              onSelect={onSelect}
              onHover={setHovered}
              statusLabel={statusT(node.status)}
              artifactLabel={t("artifactCount", { count: node.artifacts })}
            />
          ))}
        </svg>
      </div>

      <details className="mt-2 border border-px-line bg-px-panel px-2 py-1.5 font-mono text-[10px] text-px-muted">
        <summary className="cursor-pointer text-px-faint hover:text-px-text">
          {t("flowTable")}
        </summary>
        <ul className="mt-1.5 grid gap-0.5">
          {edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            return (
              <li key={`edge-${edge.id}`} className="flex gap-1.5">
                <span className="text-px-text">{from?.name ?? edge.from}</span>
                <span className="text-px-faint">
                  {edge.kind === "loop" ? "↺" : "→"}
                </span>
                <span className="text-px-text">{to?.name ?? edge.to}</span>
                {edge.active ? (
                  <span className="text-[#4f9dff]">· {t("inFlight")}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

function FlowNode({
  node,
  selected,
  dimmed,
  onSelect,
  onHover,
  statusLabel,
  artifactLabel,
}: {
  node: Positioned;
  selected: boolean;
  dimmed: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  statusLabel: string;
  artifactLabel: string;
}) {
  const theme = STATUS_THEME[node.status];
  const accent = agentColor(node.agentId);
  const running = node.status === "running";
  const waiting = node.status === "waiting";

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      // biome-ignore lint/a11y/useSemanticElements: SVG <g> cannot be a native button; keyboard handlers are present.
      role="button"
      tabIndex={0}
      aria-label={`${node.name} · ${statusLabel} · ${artifactLabel}`}
      className={cn(
        "cursor-pointer outline-none transition-opacity duration-300",
        dimmed ? "opacity-35" : "opacity-100",
      )}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
    >
      <title>{`${node.name} · ${statusLabel}`}</title>

      {selected || running ? (
        <rect
          x={-4}
          y={-4}
          width={NODE_W + 8}
          height={NODE_H + 8}
          rx={4}
          fill="none"
          stroke={theme.line}
          strokeWidth={1.5}
          opacity={running ? 0.55 : 0.8}
          filter="url(#atlas-glow)"
          className={running ? "atlas-node-pulse" : undefined}
        />
      ) : null}

      <rect
        width={NODE_W}
        height={NODE_H}
        rx={2}
        fill="#070b13"
        stroke={selected ? theme.line : "#1e2a3f"}
        strokeWidth={selected ? 1.8 : 1}
      />
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={2}
        fill={theme.wash}
        opacity={running ? 1 : 0.55}
      />
      <rect
        x={0}
        y={12}
        width={3}
        height={NODE_H - 24}
        fill={node.current ? "#e8a33d" : accent}
        opacity={0.85}
      />

      <circle cx={20} cy={24} r={4} fill={theme.line} />
      {running ? (
        <circle
          cx={20}
          cy={24}
          r={7}
          fill="none"
          stroke={theme.line}
          strokeWidth={1}
          opacity={0.6}
          className="atlas-node-pulse"
        />
      ) : null}
      <text
        x={32}
        y={28}
        fill="#f2f6fb"
        fontSize={12.5}
        fontWeight={600}
        fontFamily="ui-monospace, monospace"
      >
        {truncateLabel(node.name, 14)}
      </text>

      {node.kind === "gate" ? (
        <g transform={`translate(${NODE_W - 20}, 18)`}>
          <rect
            x={-6}
            y={-6}
            width={12}
            height={12}
            rx={2}
            transform="rotate(45)"
            fill={node.gatePass ? "#34d399" : "#f87171"}
            opacity={0.9}
          />
        </g>
      ) : null}
      {node.kind === "approval" ? (
        <circle
          cx={NODE_W - 20}
          cy={18}
          r={5.5}
          fill="none"
          stroke="#e8a33d"
          strokeWidth={1.4}
          strokeDasharray="2 2"
          className={waiting ? "atlas-node-pulse" : undefined}
        />
      ) : null}
      {node.kind === "delivery" ? (
        <path
          d={`M ${NODE_W - 26} 18 l 6 0 l -3 5 z`}
          fill="#a1a1aa"
          opacity={0.8}
        />
      ) : null}

      <g transform="translate(14, 46)">
        <rect width={5} height={5} rx={1} y={-4} fill={accent} />
        <text
          x={10}
          y={0}
          fill={accent}
          fontSize={9.8}
          fontFamily="ui-monospace, monospace"
        >
          {truncateLabel(node.agentId ?? "—", 18)}
        </text>
      </g>

      <text
        x={14}
        y={63}
        fill="#8492a8"
        fontSize={9.3}
        fontFamily="ui-monospace, monospace"
      >
        {node.durationMs !== undefined
          ? formatSpan(node.durationMs)
          : statusLabel}
        {node.costCny > 0 ? ` · ${formatCost(node.costCny)}` : ""}
      </text>

      {node.artifacts > 0 ? (
        <g transform={`translate(${NODE_W - 46}, ${NODE_H - 23})`}>
          <rect
            width={38}
            height={16}
            rx={1}
            fill="rgba(255,255,255,0.05)"
            stroke="#1e2a3f"
          />
          <text
            x={19}
            y={11}
            textAnchor="middle"
            fill="#8492a8"
            fontSize={9}
            fontFamily="ui-monospace, monospace"
          >
            ×{node.artifacts}
          </text>
        </g>
      ) : null}
    </g>
  );
}
