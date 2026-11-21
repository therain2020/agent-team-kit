"use client";

import { OfficeListView } from "@/components/office/office-list-view";
import { StationGrid } from "@/components/office/station-grid";
import { STATUS_DOT, STATUS_I18N } from "@/components/office/status";
import {
  ConveyorBelt,
  PixelAgent,
  PixelCrate,
  PixelDesk,
  PixelDoor,
  PixelPlant,
  PixelWorld,
  StampEffect,
  ToolBubble,
  WorldHud,
  agentSeed,
  useConveyorReverse,
  usePixelMotion,
} from "@/components/pixel";
import { SinceLabel } from "@/components/world/world-status";
import type { FactoryLinkItem } from "@/lib/factory";
import { FACTORY_ROOM_HREF } from "@/lib/office-deeplink";
import { floorKeyAction } from "@/lib/office-keys";
import type { LiveAgent } from "@/lib/office-live";
import { floorBreakpointClass } from "@/lib/office-responsive";
import {
  type PixelAgentState,
  type PresenceMap,
  floorMotionTick,
  floorTransition,
  pixelStateFromStatus,
} from "@/lib/pixel-events";
import type { Ticker } from "@/lib/use-ticker";
import { cn, formatCny, formatNumber } from "@/lib/utils";
import type { WorldCrate } from "@/lib/world-cues";
import { shortStage } from "@/lib/world-state";
import {
  Coffee,
  Factory,
  Gamepad2,
  Lock,
  Monitor,
  Package,
  Wifi,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

const ROLE_I18N = {
  builder: "roleBuilder",
  seller: "roleSeller",
  manager: "roleManager",
  specialist: "roleSpecialist",
} as const;

export interface FloorBubble {
  text: string;
  seq: number;
}

export interface FloorFlow {
  tokens: number;
  costCny: number;
  delta: { tokens: number; costCny: number; seq: number } | null;
}

/**
 * Interactive pixel factory floor (issue #156 ① 可交互 agent ② 流动的信息).
 *
 * Everything on the floor renders from the world stream: crate positions,
 * bubbles, stamps, the belt direction and the flow meter all change only when
 * `useWorld` delivers a delta. Hover reports stage/tool/elapsed; click selects,
 * locks a slight camera pan and opens the stage drawer; Enter/right-click open
 * it too, and J/K walk the stations with a visible focus ring.
 */
export function FactoryFloor({
  packName,
  pendingCount,
  pendingItems,
  manager,
  employees,
  agents,
  spriteStates,
  ticker,
  visible,
  selectedId,
  locked,
  hoveredId,
  bubbles,
  crates,
  stamp,
  reverseSeq,
  flow,
  suspended,
  onHover,
  onSelect,
  onOpen,
  onEscape,
}: {
  packName: string;
  /** Door plate count, kept in sync with the factory gate (97 §3.5). */
  pendingCount: number;
  /** First pending workpieces, shown in the door plate tooltip. */
  pendingItems: readonly FactoryLinkItem[];
  manager?: LiveAgent;
  employees: LiveAgent[];
  agents: LiveAgent[];
  /** Per-agent sprite state, already throttled for 500ms (97 §3.2). */
  spriteStates: PresenceMap;
  ticker: Ticker;
  /** Hidden tabs freeze the clock and transforms; data still updates. */
  visible: boolean;
  selectedId: string | null;
  locked: boolean;
  hoveredId: string | null;
  bubbles: Record<string, FloorBubble>;
  crates: WorldCrate[];
  stamp: { outcome: "passed" | "failed"; seq: number } | null;
  reverseSeq: number;
  flow: FloorFlow;
  /** Drawer open: the floor stops consuming J/K/Enter (Esc belongs to it). */
  suspended: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onOpen: (agent: LiveAgent) => void;
  onEscape: () => void;
}) {
  const t = useTranslations("office");
  const { enabled: motionEnabled } = usePixelMotion();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stationRefs = useRef(new Map<string, HTMLButtonElement>());
  const [camera, setCamera] = useState({ x: 0, y: 0 });

  const order = useMemo(() => agents.map((agent) => agent.id), [agents]);
  // Manager first so the roving tab order matches the floor's visual order.
  const ordered = useMemo(
    () => (manager ? [manager, ...employees] : employees),
    [manager, employees],
  );
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  const hovered = agents.find((agent) => agent.id === hoveredId) ?? null;
  const reversed = useConveyorReverse(reverseSeq);
  const motionTick = floorMotionTick(ticker.tick, motionEnabled, visible);
  const waitingCount = agents.filter(
    (agent) => agent.status === "waiting",
  ).length;

  // Slight camera pan toward the locked station; reset when motion is off so
  // reduced-motion users get a perfectly still floor.
  useEffect(() => {
    if (!locked || !selectedId || !motionEnabled || !visible) {
      setCamera({ x: 0, y: 0 });
      return;
    }
    const stage = stageRef.current;
    const station = stationRefs.current.get(selectedId);
    if (!stage || !station) {
      setCamera({ x: 0, y: 0 });
      return;
    }
    const stationRect = station.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const dx =
      stationRect.left +
      stationRect.width / 2 -
      (stageRect.left + stageRect.width / 2);
    const dy =
      stationRect.top +
      stationRect.height / 2 -
      (stageRect.top + stageRect.height / 2);
    setCamera({
      x: Math.max(-14, Math.min(14, -dx * 0.06)),
      y: Math.max(-10, Math.min(10, -dy * 0.06)),
    });
  }, [locked, selectedId, motionEnabled, visible]);

  // Keyboard-first floor: J/K walk the roster, Enter opens, Esc unlocks.
  useEffect(() => {
    if (suspended) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const action = floorKeyAction(event, {
        suspended,
        hasAgents: order.length > 0,
        hasSelection: selected !== null,
      });
      if (!action) {
        return;
      }
      if (action.kind === "step") {
        event.preventDefault();
        const index = selectedId ? order.indexOf(selectedId) : -1;
        const nextIndex = (index + action.delta + order.length) % order.length;
        const nextId = order[nextIndex];
        if (!nextId) {
          return;
        }
        onSelect(nextId);
        stationRefs.current.get(nextId)?.focus();
        return;
      }
      if (action.kind === "open") {
        event.preventDefault();
        if (selected) {
          onOpen(selected);
        }
        return;
      }
      onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selectedId, selected, suspended, onSelect, onOpen, onEscape]);

  const registerStation = (id: string) => (node: HTMLButtonElement | null) => {
    if (node) {
      stationRefs.current.set(id, node);
    } else {
      stationRefs.current.delete(id);
    }
  };

  return (
    <PixelWorld
      title={`${packName} · ${t("room")}`}
      subtitle={`${t("floor")} · ${t("gameMode")}`}
      hud={
        <WorldHud
          items={[
            {
              key: "pending",
              label: t("pendingApprovals"),
              value: pendingCount,
              tone: pendingCount > 0 ? "warn" : "default",
            },
            {
              key: "cost",
              label: t("flowCostLabel"),
              value: formatCny(flow.costCny),
            },
          ]}
        />
      }
      doors={
        <PixelDoor
          href={FACTORY_ROOM_HREF}
          label={t("factoryDoor")}
          count={pendingCount}
          icon={<Factory className="size-3.5" aria-hidden="true" />}
          shortcut="F"
          title={pendingItems.map((item) => item.summary).join("\n")}
        />
      }
    >
      <div className="mb-2 flex items-center justify-end gap-2 font-mono text-[9px] text-px-faint">
        {locked && selected ? (
          <span className="flex items-center gap-1 border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-200">
            <Lock className="size-3" />
            {t("lockedCamera", { agent: selected.id })}
          </span>
        ) : null}
        <span className="flex items-center gap-1">
          <Wifi className="size-3 text-emerald-400" />
          {t("local")}
        </span>
        <span className="flex items-center gap-1">
          <Coffee className="size-3 text-amber-300" />
          {t("coffee")}
        </span>
      </div>

      <HoverHud agent={hovered ?? selected} locked={locked} />

      <div className="relative mt-2 rounded-none border border-px-line2 bg-px-panel px-3 pb-3 pt-2 shadow-[inset_0_8px_20px_rgba(0,0,0,0.45)]">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="size-1.5 rounded-none bg-amber-300/70"
              />
            ))}
          </div>
          <div className="flex items-end gap-1 opacity-70" aria-hidden="true">
            {[8, 14, 10, 18, 12, 20, 9].map((height) => (
              <span
                key={height}
                className="w-1 rounded-none bg-sky-400/50"
                style={{ height }}
              />
            ))}
          </div>
          <span className="font-mono text-[8px] text-px-faint">
            {t("city")}
          </span>
        </div>

        <div
          ref={stageRef}
          className={cn("relative", floorBreakpointClass("stage"))}
          style={{
            transform: `translate3d(${camera.x}px, ${camera.y}px, 0)`,
            transition: floorTransition(
              motionEnabled,
              "transform 420ms steps(4, end)",
            ),
          }}
        >
          <StationGrid
            items={ordered}
            activeId={selectedId}
            onActivate={onSelect}
            label={t("desks")}
            className="md:grid-cols-2 lg:grid-cols-3"
            itemClassName={(agent) =>
              agent.isManager
                ? "flex justify-center md:col-span-2 lg:col-span-3"
                : undefined
            }
            renderItem={(agent, api) => (
              <Station
                agent={agent}
                spriteState={
                  spriteStates[agent.id]?.state ??
                  pixelStateFromStatus(agent.status)
                }
                tick={motionTick}
                animated={motionEnabled}
                bubble={bubbles[agent.id]}
                selected={selectedId === agent.id}
                locked={locked && selectedId === agent.id}
                hovered={hoveredId === agent.id}
                manager={agent.isManager}
                tabIndex={api.tabIndex}
                registerRef={(node) => {
                  api.registerRef(node);
                  registerStation(agent.id)(node);
                }}
                onHover={onHover}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            )}
          />
        </div>

        <div className="mt-3 border-t border-px-line pt-2">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2 font-mono text-[9px] text-px-faint">
            <span className="flex items-center gap-1 text-px-muted">
              <Package className="size-3" />
              {t("artifactBelt")}
              <span className="text-px-faint">
                {t("beltCount", { count: crates.length })}
              </span>
            </span>
            <FlowMeter flow={flow} />
          </div>
          <div className="relative h-20 overflow-hidden rounded-none border border-px-line bg-px-ink">
            <ConveyorBelt
              tick={motionTick}
              reversed={reversed}
              className="absolute inset-x-0 bottom-0 h-3"
            />
            <StampEffect
              trigger={stamp?.seq ?? 0}
              outcome={stamp?.outcome ?? "passed"}
              pressed={waitingCount > 0}
              className="absolute right-3 bottom-3 scale-75"
            />
            {crates.length === 0 ? (
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] uppercase tracking-widest text-px-faint">
                {t("beltEmpty")}
              </span>
            ) : (
              crates.map((crate, index) => (
                <div
                  key={crate.runId}
                  className="absolute bottom-4 left-3 flex flex-col items-center"
                  style={{
                    transform: `translate3d(${index * 48}px, 0, 0)`,
                    transition: floorTransition(
                      motionEnabled,
                      "transform 320ms steps(3, end)",
                    ),
                  }}
                >
                  <PixelCrate tone={crate.tone} size={20} />
                  <span className="mt-0.5 w-12 truncate text-center font-mono text-[8px] text-px-faint">
                    {crate.label}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-end justify-between gap-2 border-t border-px-line pt-2">
          <PixelPlant size={36} className="opacity-80" />
          <div className="flex flex-wrap items-center gap-2 font-mono text-[9px] text-px-faint">
            <span>{t("floorHint")}</span>
            <span className="flex items-center gap-1">
              <Monitor className="size-3" />
              {t("desks")}
            </span>
            <span className="flex items-center gap-1">
              <Gamepad2 className="size-3" />
              {t("keyboardHint")}
            </span>
          </div>
        </div>
      </div>

      <OfficeListView
        agents={agents}
        selectedId={selectedId}
        onSelect={onSelect}
        onOpen={onOpen}
        className={cn("mt-3", floorBreakpointClass("compactList"))}
      />
    </PixelWorld>
  );
}

function HoverHud({
  agent,
  locked,
}: {
  agent: LiveAgent | null;
  locked: boolean;
}) {
  const t = useTranslations("office");
  const stage = agent
    ? shortStage(agent.stageId ?? agent.activityDetail ?? null) || "—"
    : "—";
  const tool = agent?.currentTool ?? "—";
  return (
    <div
      aria-live="polite"
      className="flex min-h-6 flex-wrap items-center gap-1.5 font-mono text-[9px] text-px-faint"
    >
      {agent ? (
        <>
          <span className="border border-px-line bg-px-ink px-1.5 py-0.5 text-px-text">
            {t("hoverStage", { stage })}
          </span>
          <span className="border border-px-line bg-px-ink px-1.5 py-0.5 text-px-text">
            {t("hoverTool", { tool })}
          </span>
          <span className="border border-px-line bg-px-ink px-1.5 py-0.5 text-px-muted">
            {agent.since ? (
              <SinceLabel since={agent.since} />
            ) : (
              t("hoverElapsedUnknown")
            )}
          </span>
          {locked ? (
            <span className="text-emerald-300">{t("escToUnlock")}</span>
          ) : null}
        </>
      ) : (
        <span className="text-px-faint">{t("floorHint")}</span>
      )}
    </div>
  );
}

function FlowMeter({ flow }: { flow: FloorFlow }) {
  const t = useTranslations("office");
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-px-muted">
        {t("flowTokens", { tokens: formatNumber(flow.tokens) })}
      </span>
      <span className="text-px-faint">
        {t("flowCost", { cost: formatCny(flow.costCny) })}
      </span>
      {flow.delta ? (
        <span
          key={flow.delta.seq}
          className="border border-emerald-500/40 bg-emerald-500/10 px-1 text-emerald-200"
        >
          {t("flowDelta", {
            tokens: formatNumber(flow.delta.tokens),
            cost: formatCny(flow.delta.costCny),
          })}
        </span>
      ) : null}
    </span>
  );
}

function Station({
  agent,
  spriteState,
  tick,
  animated,
  bubble,
  selected,
  locked,
  hovered,
  manager = false,
  tabIndex,
  registerRef,
  onHover,
  onSelect,
  onOpen,
}: {
  agent: LiveAgent;
  spriteState: PixelAgentState;
  tick: number;
  animated: boolean;
  bubble?: FloorBubble;
  selected: boolean;
  locked: boolean;
  hovered: boolean;
  manager?: boolean;
  /** Roving tabindex supplied by `StationGrid`. */
  tabIndex: 0 | -1;
  registerRef: (node: HTMLButtonElement | null) => void;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onOpen: (agent: LiveAgent) => void;
}) {
  const t = useTranslations("office");
  return (
    <button
      ref={registerRef}
      type="button"
      tabIndex={tabIndex}
      onClick={() => {
        onSelect(agent.id);
        onOpen(agent);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(agent.id);
        onOpen(agent);
      }}
      onMouseEnter={() => onHover(agent.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(agent.id)}
      onBlur={() => onHover(null)}
      aria-pressed={selected}
      aria-keyshortcuts="Enter"
      aria-label={`${agent.id} · ${t(STATUS_I18N[agent.status])} · ${t("clickToInspect")}`}
      className={cn(
        "group relative flex flex-col items-center rounded-none border-2 px-2 pb-2 pt-1 outline-none transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-px-cream",
        selected
          ? "border-emerald-500/50 bg-emerald-500/[0.06]"
          : hovered
            ? "border-px-line3 bg-px-hi"
            : "border-transparent hover:border-px-line3",
        locked && "border-emerald-400/70",
        manager &&
          "bg-[radial-gradient(ellipse_at_center,rgba(45,212,191,0.08),transparent_70%)]",
      )}
    >
      <span className="relative z-10 mb-1 flex max-w-[11rem] items-center gap-1 font-mono text-[9px]">
        <span
          className={cn("size-1.5 rounded-none", STATUS_DOT[agent.status])}
        />
        <span className="text-px-muted">{t(STATUS_I18N[agent.status])}</span>
        {agent.since ? <SinceLabel since={agent.since} /> : null}
      </span>
      <span className="relative mb-1">
        <PixelAgent
          seed={agentSeed(agent.id)}
          manager={manager}
          state={spriteState}
          tick={tick}
          tone={agent.status === "error" ? "red" : undefined}
          avatar={agent.avatar}
        />
        {bubble ? <ToolBubble text={bubble.text} seq={bubble.seq} /> : null}
      </span>
      <PixelDesk progress={agent.progress} animated={animated} />
      <span className="mt-1 max-w-full truncate font-mono text-[9px] text-px-muted">
        {agent.id}
        {manager ? " · manager" : ` · ${t(ROLE_I18N[agent.role])}`}
      </span>
    </button>
  );
}
