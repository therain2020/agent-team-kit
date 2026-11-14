"use client";

import type { StudioStage } from "@/lib/pack-studio";
import { cn } from "@/lib/utils";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const NODE_WIDTH = 176;
const NODE_HEIGHT = 64;
const COLUMN_GAP = 72;
const ROW_GAP = 32;
const PADDING = 20;

interface Point {
  x: number;
  y: number;
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  origin: Point;
  current: Point;
  moved: boolean;
}

export function WorkflowGraph({
  dirName,
  file,
  stages,
  onSaved,
}: {
  dirName: string;
  file: string;
  stages: StudioStage[];
  onSaved?: (content: string) => void;
}) {
  const t = useTranslations("studio");
  const markerId = useId();
  const dragRef = useRef<DragState | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Point>>({});
  const [dragging, setDragging] = useState<string | null>(null);

  const basePositions = useMemo(() => layoutStages(stages), [stages]);
  const positions = useMemo(
    () => ({ ...basePositions, ...overrides }),
    [basePositions, overrides],
  );

  const edges = useMemo(() => {
    const known = new Set(stages.map((stage) => stage.id));
    return stages.flatMap((stage, index) =>
      dependenciesOf(stages, index)
        .filter((from) => known.has(from) && from !== stage.id)
        .map((from) => ({ from, to: stage.id })),
    );
  }, [stages]);

  const width =
    Math.max(
      NODE_WIDTH + PADDING * 2,
      ...Object.values(positions).map(
        (point) => point.x + NODE_WIDTH + PADDING,
      ),
    ) || NODE_WIDTH;
  const height =
    Math.max(
      NODE_HEIGHT + PADDING * 2,
      ...Object.values(positions).map(
        (point) => point.y + NODE_HEIGHT + PADDING,
      ),
    ) || NODE_HEIGHT;

  function handlePointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    stageId: string,
  ) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = positions[stageId] ?? { x: PADDING, y: PADDING };
    dragRef.current = {
      id: stageId,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      current: origin,
      moved: false,
    };
    setDragging(stageId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      drag.moved = true;
    }
    const next = {
      x: Math.max(0, Math.round(drag.origin.x + dx)),
      y: Math.max(0, Math.round(drag.origin.y + dy)),
    };
    drag.current = next;
    setOverrides((current) => ({ ...current, [drag.id]: next }));
  }

  async function handlePointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    if (!drag?.moved) {
      return;
    }

    const nextPositions = { ...positions, [drag.id]: drag.current };
    try {
      const response = await fetch(
        `/api/packs/${encodeURIComponent(dirName)}/workflow`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file, positions: nextPositions }),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        content?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("graphSaveFailed"));
      }
      if (payload.content) {
        onSaved?.(payload.content);
      }
      toast.success(t("graphSaved"));
    } catch (problem) {
      toast.error(
        problem instanceof Error ? problem.message : t("graphSaveFailed"),
      );
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          {t("graphTitle")}
        </span>
        <span className="text-[10px] text-zinc-600">{t("graphHint")}</span>
      </div>
      <div
        className="relative overflow-auto rounded-md border border-border bg-zinc-950/40"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(113,113,122,0.22) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      >
        <div className="relative" style={{ width, height }}>
          <svg
            className="pointer-events-none absolute inset-0"
            width={width}
            height={height}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="#52525b" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const from = positions[edge.from];
              const to = positions[edge.to];
              if (!from || !to) {
                return null;
              }
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_HEIGHT / 2;
              const bend = Math.max(24, Math.abs(x2 - x1) / 2);
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#52525b"
                  strokeWidth={1.5}
                  markerEnd={`url(#${markerId})`}
                />
              );
            })}
          </svg>
          {stages.map((stage) => {
            const position = positions[stage.id] ?? { x: PADDING, y: PADDING };
            return (
              <button
                key={stage.id}
                type="button"
                onPointerDown={(event) => handlePointerDown(event, stage.id)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                aria-label={t("graphNodeLabel", { id: stage.id })}
                className={cn(
                  "absolute flex cursor-grab touch-none select-none flex-col justify-between rounded-md border border-border bg-card px-3 py-2 text-left shadow-[3px_3px_0_#000] active:cursor-grabbing",
                  dragging === stage.id && "border-emerald-400/70",
                )}
                style={{
                  left: position.x,
                  top: position.y,
                  width: NODE_WIDTH,
                  height: NODE_HEIGHT,
                }}
              >
                <span className="flex items-center gap-1 font-mono text-[11px] text-zinc-100">
                  {stage.approval ? (
                    <Lock className="size-3 text-amber-300" />
                  ) : null}
                  <span className="truncate">{stage.id}</span>
                </span>
                <span className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
                  <span className="truncate">
                    {stage.agent ?? stage.coder ?? stage.type}
                  </span>
                  <span className="rounded border border-border px-1 text-[9px] uppercase text-zinc-500">
                    {stage.type}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function dependenciesOf(stages: StudioStage[], index: number): string[] {
  const stage = stages[index];
  if (!stage) {
    return [];
  }
  if (stage.inputsFrom && stage.inputsFrom.length > 0) {
    return stage.inputsFrom;
  }
  if (stage.inputFrom) {
    return [stage.inputFrom];
  }
  const previous = stages[index - 1];
  return previous ? [previous.id] : [];
}

function layoutStages(stages: StudioStage[]): Record<string, Point> {
  const depth = new Map<string, number>();
  const rowCursor = new Map<number, number>();
  const positions: Record<string, Point> = {};

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (!stage) {
      continue;
    }
    const dependencies = dependenciesOf(stages, index);
    let level = 0;
    for (const dependency of dependencies) {
      level = Math.max(level, (depth.get(dependency) ?? 0) + 1);
    }
    depth.set(stage.id, level);

    if (stage.position) {
      positions[stage.id] = stage.position;
      continue;
    }

    const row = rowCursor.get(level) ?? 0;
    rowCursor.set(level, row + 1);
    positions[stage.id] = {
      x: PADDING + level * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
    };
  }

  return positions;
}
