"use client";

import { NewMissionDialog } from "@/components/office/new-mission-dialog";
import { OfficeChat } from "@/components/office/office-chat";
import {
  ConveyorBelt,
  PixelAgent,
  PixelClockControls,
  PixelCrate,
  PixelMotionProvider,
  TOOL_BUBBLE_MS,
  ToolBubble,
  usePixelMotion,
} from "@/components/pixel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SinceLabel, WorldStatus } from "@/components/world/world-status";
import type { OfficeData } from "@/lib/office";
import {
  type LiveAgent,
  type LiveMission,
  type OptimisticMission,
  deriveLiveAgents,
  deriveLiveMissions,
} from "@/lib/office-live";
import {
  type PixelCue,
  cueFromActivity,
  pixelStateFromStatus,
  pushCrate,
} from "@/lib/pixel-events";
import { usePixelLive } from "@/lib/use-pixel-live";
import { useTicker } from "@/lib/use-ticker";
import { cn } from "@/lib/utils";
import { useWorld } from "@/lib/world-client";
import { shortStage } from "@/lib/world-state";
import type { UIMessage } from "ai";
import {
  ArrowUpRight,
  Bot,
  Coffee,
  Gamepad2,
  MessageSquare,
  Monitor,
  Package,
  Pencil,
  Plus,
  ShieldCheck,
  Users,
  Wifi,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

/** Crates drawn on the office belt; the rest are summarised as a count. */
const OFFICE_BELT_VISIBLE = 8;

type BeltCrate = Extract<PixelCue, { type: "crate" }>;

/** Seed the belt from the missions the server already knows about. */
function seedCrates(missions: readonly { runId: string }[]): BeltCrate[] {
  return missions.slice(0, 4).map((mission, index) => ({
    type: "crate" as const,
    runId: mission.runId,
    label: mission.runId.slice(-6),
    bad: false,
    seq: -(index + 1),
  }));
}

/** Optimistic missions are dropped if the stream never materializes the run. */
const OPTIMISTIC_TTL_MS = 120_000;

const ROLE_I18N = {
  builder: "roleBuilder",
  seller: "roleSeller",
  manager: "roleManager",
  specialist: "roleSpecialist",
} as const;

const STATUS_I18N = {
  idle: "statusIdle",
  working: "statusWorking",
  blocked: "statusBlocked",
  waiting: "statusWaiting",
  error: "statusError",
} as const;

const STATUS_STYLE: Record<LiveAgent["status"], { dot: string; text: string }> =
  {
    working: {
      dot: "bg-emerald-400",
      text: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    },
    waiting: {
      dot: "bg-amber-300",
      text: "border-amber-400/50 bg-amber-400/15 text-amber-100",
    },
    blocked: {
      dot: "bg-orange-400",
      text: "border-orange-500/40 bg-orange-500/10 text-orange-200",
    },
    error: {
      dot: "bg-red-400",
      text: "border-red-500/40 bg-red-500/10 text-red-200",
    },
    idle: {
      dot: "bg-zinc-500",
      text: "border-border bg-zinc-900 text-zinc-400",
    },
  };

export function OfficeScene(props: {
  data: OfficeData;
  initialMessages: UIMessage[];
  stubMode: boolean;
}) {
  return (
    <PixelMotionProvider>
      <OfficeSceneBody {...props} />
    </PixelMotionProvider>
  );
}

function OfficeSceneBody({
  data,
  initialMessages,
  stubMode,
  initialPanel = "agent",
}: {
  data: OfficeData;
  initialMessages: UIMessage[];
  stubMode: boolean;
  initialPanel?: "agent" | "chat";
}) {
  const t = useTranslations("office");
  const router = useRouter();
  const world = useWorld();
  const active = data.active;
  const [selectedId, setSelectedId] = useState(
    active?.agents[0]?.id ?? "manager",
  );
  const [tab, setTab] = useState<"agent" | "chat">(initialPanel);
  const [missionOpen, setMissionOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<OptimisticMission[]>([]);

  const baseMissions = active?.missions ?? [];
  const baseAgents = active?.agents ?? [];

  // The stream wins: drop optimistic missions as soon as the projection has
  // the run, and expire anything the stream never acknowledged.
  useEffect(() => {
    if (optimistic.length === 0) {
      return;
    }
    const runs = new Set(world.world?.runs.map((run) => run.runId) ?? []);
    const cutoff = Date.now() - OPTIMISTIC_TTL_MS;
    const next = optimistic.filter(
      (mission) =>
        !runs.has(mission.runId) && Date.parse(mission.createdAt) > cutoff,
    );
    if (next.length !== optimistic.length) {
      setOptimistic(next);
    }
  }, [optimistic, world.world]);

  useEffect(() => {
    if (optimistic.length === 0) {
      return;
    }
    const id = setInterval(() => {
      const cutoff = Date.now() - OPTIMISTIC_TTL_MS;
      setOptimistic((current) =>
        current.every((mission) => Date.parse(mission.createdAt) > cutoff)
          ? current
          : current.filter((mission) => Date.parse(mission.createdAt) > cutoff),
      );
    }, 5_000);
    return () => clearInterval(id);
  }, [optimistic.length]);

  const agents = useMemo(
    () => deriveLiveAgents(baseAgents, world.world, baseMissions, optimistic),
    [baseAgents, baseMissions, world.world, optimistic],
  );
  const missions = useMemo(
    () => deriveLiveMissions(baseMissions, world.world, optimistic),
    [baseMissions, world.world, optimistic],
  );

  const { enabled: motionEnabled } = usePixelMotion();
  const ticker = useTicker();
  const [crates, setCrates] = useState<BeltCrate[]>(() => seedCrates(missions));
  const [bubbles, setBubbles] = useState<
    Record<string, { text: string; seq: number }>
  >({});
  const bubbleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = bubbleTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // Ephemeral motion only: live presence already comes from the world stream,
  // so activity frames are used solely for tool bubbles and belt crates. A
  // quiet workspace delivers no frames and the floor stays still.
  usePixelLive({
    onEvent: (event) => {
      const cues = cueFromActivity(event);
      if (cues.length === 0) {
        return;
      }
      ticker.pulse();
      for (const cue of cues) {
        if (cue.type === "crate") {
          setCrates((current) => pushCrate(current, cue) as BeltCrate[]);
        }
        if (cue.type === "tool") {
          const { agentId } = cue;
          setBubbles((current) => ({
            ...current,
            [agentId]: { text: cue.tool, seq: cue.seq },
          }));
          const previous = bubbleTimers.current.get(agentId);
          if (previous) {
            clearTimeout(previous);
          }
          bubbleTimers.current.set(
            agentId,
            setTimeout(() => {
              bubbleTimers.current.delete(agentId);
              setBubbles((current) => {
                if (current[agentId]?.seq !== cue.seq) {
                  return current;
                }
                const next = { ...current };
                delete next[agentId];
                return next;
              });
            }, TOOL_BUBBLE_MS + 200),
          );
        }
      }
    },
  });

  // Reduced motion / the motion toggle freeze stepping: state changes still
  // land, they just do not animate through tick parity.
  const motionTick = motionEnabled ? ticker.tick : 0;
  const beltCrates = crates.slice(-OFFICE_BELT_VISIBLE);

  function selectPanel(next: "agent" | "chat") {
    setTab(next);
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    if (next === "chat") {
      url.searchParams.set("panel", "manager");
    } else {
      url.searchParams.delete("panel");
    }
    window.history.replaceState(null, "", url);
  }

  if (!active) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-xs text-zinc-500">
          {t("noPack")}{" "}
          <Link href="/packs/new" className="text-emerald-300 hover:underline">
            {t("createPack")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const selected = agents.find((agent) => agent.id === selectedId) ?? agents[0];
  const manager = agents.find((agent) => agent.isManager);
  const employees = agents.filter((agent) => !agent.isManager);
  const working = agents.filter((agent) => agent.status === "working").length;
  const waiting = agents.filter((agent) => agent.status === "waiting").length;
  const blocked = agents.filter((agent) => agent.status === "blocked").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={active.dirName}
            onChange={(event) =>
              router.push(
                `/office?pack=${encodeURIComponent(event.target.value)}${
                  tab === "chat" ? "&panel=manager" : ""
                }`,
              )
            }
            className="h-8 rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200"
          >
            {data.packs.map((pack) => (
              <option key={pack.dirName} value={pack.dirName}>
                {pack.name}
              </option>
            ))}
          </select>
          <Badge variant="outline" className="gap-1">
            <Users className="size-3" />
            {t("teamSize", { count: agents.length })}
          </Badge>
          <Badge variant={working > 0 ? "success" : "outline"}>
            {t("working", { count: working })}
          </Badge>
          {waiting > 0 ? (
            <Badge variant="info">{t("waiting", { count: waiting })}</Badge>
          ) : null}
          {blocked > 0 ? (
            <Badge variant="warning">{t("blocked", { count: blocked })}</Badge>
          ) : null}
          <WorldStatus />
          <PixelClockControls ticker={ticker} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link href="/autopilot">
              <ShieldCheck className="size-3.5" />
              {t("autopilot")}
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/packs/${encodeURIComponent(active.dirName)}/studio`}>
              <Pencil className="size-3.5" />
              {t("customize")}
            </Link>
          </Button>
          <Button size="sm" onClick={() => setMissionOpen(true)}>
            <Plus className="size-3.5" />
            {t("newMission")}
          </Button>
        </div>
      </div>

      <TaskBoard missions={missions} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-3">
          <div className="office-room relative overflow-hidden rounded-2xl border border-zinc-800 bg-[#0b0f19] p-4 shadow-[inset_0_0_80px_rgba(0,0,0,0.6)]">
            <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(122,162,247,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(122,162,247,0.12)_1px,transparent_1px)] [background-size:32px_32px]" />
            <div className="relative">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded bg-zinc-800/80 font-mono text-[10px] text-emerald-300">
                    KIT
                  </span>
                  <div>
                    <p className="text-[11px] font-medium text-zinc-200">
                      {active.name} · {t("room")}
                    </p>
                    <p className="font-mono text-[9px] text-zinc-500">
                      {t("floor")}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[9px] text-zinc-500">
                  <span className="flex items-center gap-1">
                    <Wifi className="size-3 text-emerald-400" />
                    {t("local")}
                  </span>
                  <span className="flex items-center gap-1">
                    <Coffee className="size-3 text-amber-300" />
                    {t("coffee")}
                  </span>
                </div>
              </div>

              <div className="relative rounded-xl border border-zinc-800/80 bg-[#0e1420] px-3 pb-3 pt-2 shadow-[inset_0_8px_20px_rgba(0,0,0,0.45)]">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex gap-1.5">
                    {[0, 1, 2].map((index) => (
                      <span
                        key={index}
                        className="size-1.5 rounded-full bg-amber-300/70"
                      />
                    ))}
                  </div>
                  <div className="flex items-end gap-1 opacity-70">
                    {[8, 14, 10, 18, 12, 20, 9].map((height) => (
                      <span
                        key={height}
                        className="w-1 rounded-sm bg-sky-400/50"
                        style={{ height }}
                      />
                    ))}
                  </div>
                  <span className="font-mono text-[8px] text-zinc-600">
                    {t("city")}
                  </span>
                </div>

                <div className="relative grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {manager ? (
                    <div className="flex justify-center sm:col-span-2 lg:col-span-3">
                      <Station
                        agent={manager}
                        tick={motionTick}
                        bubble={bubbles[manager.id]}
                        selected={selected?.id === manager.id}
                        onSelect={() => {
                          setSelectedId(manager.id);
                          setTab("agent");
                        }}
                        manager
                      />
                    </div>
                  ) : null}
                  {employees.map((agent, index) => (
                    <Station
                      key={agent.id}
                      agent={agent}
                      tick={motionTick}
                      bubble={bubbles[agent.id]}
                      selected={selected?.id === agent.id}
                      onSelect={() => {
                        setSelectedId(agent.id);
                        setTab("agent");
                      }}
                      index={index}
                    />
                  ))}
                </div>

                <div className="mt-3 border-t border-zinc-800/60 pt-2">
                  <div className="mb-1 flex items-center justify-between text-[9px] text-zinc-500">
                    <span className="flex items-center gap-1">
                      <Package className="size-3" />
                      {t("artifactBelt")}
                    </span>
                    <span className="font-mono text-zinc-600">
                      {t("beltCount", { count: beltCrates.length })}
                    </span>
                  </div>
                  <div
                    className="relative h-16 overflow-hidden rounded border border-zinc-800/80 bg-[#0a0e15]"
                    aria-hidden="true"
                  >
                    <ConveyorBelt
                      tick={motionTick}
                      className="absolute inset-x-0 bottom-0 h-3"
                    />
                    {beltCrates.length === 0 ? (
                      <span className="absolute inset-0 flex items-center justify-center font-mono text-[9px] uppercase tracking-widest text-zinc-700">
                        {t("beltEmpty")}
                      </span>
                    ) : (
                      beltCrates.map((crate, index) => (
                        <div
                          key={crate.runId}
                          className="absolute bottom-4 left-3 flex flex-col items-center"
                          style={{
                            transform: `translate3d(${index * 56}px, 0, 0)`,
                            transition: motionEnabled
                              ? "transform 320ms steps(3, end)"
                              : "none",
                          }}
                        >
                          <PixelCrate
                            tone={crate.bad ? "bad" : "low"}
                            size={22}
                          />
                          <span className="mt-0.5 w-12 truncate text-center font-mono text-[8px] text-zinc-500">
                            {crate.label}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="mt-3 flex items-end justify-between border-t border-zinc-800/60 pt-2">
                  <div className="flex items-end gap-2 opacity-80">
                    <Plant />
                    <div className="flex items-end gap-1">
                      <span className="h-8 w-2 rounded-sm bg-zinc-700" />
                      <span className="h-11 w-2 rounded-sm bg-zinc-700" />
                      <span className="h-6 w-2 rounded-sm bg-zinc-700" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] text-zinc-600">
                    <span className="flex items-center gap-1">
                      <Monitor className="size-3" />
                      {t("desks")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Gamepad2 className="size-3" />
                      {t("gameMode")}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex min-h-[34rem] flex-col rounded-xl border border-border bg-card">
          <div className="flex items-center gap-1 border-b border-border p-1.5">
            <button
              type="button"
              onClick={() => selectPanel("agent")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-zinc-400",
                tab === "agent" && "bg-zinc-800 text-zinc-100",
              )}
            >
              <Bot className="size-3.5" />
              {t("roster")}
            </button>
            <button
              type="button"
              onClick={() => selectPanel("chat")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-zinc-400",
                tab === "chat" && "bg-zinc-800 text-zinc-100",
              )}
            >
              <MessageSquare className="size-3.5" />
              {t("managerChat")}
            </button>
          </div>

          {tab === "chat" ? (
            <div className="min-h-0 flex-1">
              <OfficeChat
                packDir={active.dirName}
                initialMessages={initialMessages}
                stubMode={stubMode}
              />
            </div>
          ) : selected ? (
            <AgentPanel
              agent={selected}
              tick={motionTick}
              packDir={active.dirName}
              team={employees}
              onSelectAgent={(id) => {
                setSelectedId(id);
                setTab("agent");
              }}
              onChat={() => selectPanel("chat")}
            />
          ) : null}
        </div>
      </div>

      <NewMissionDialog
        open={missionOpen}
        onOpenChange={setMissionOpen}
        packDir={active.dirName}
        workflows={active.workflows}
        agents={agents}
        roleRules={active.roleRules}
        onStarted={(mission) =>
          setOptimistic((current) =>
            current.some((entry) => entry.runId === mission.runId)
              ? current
              : [mission, ...current],
          )
        }
      />
    </div>
  );
}

function Station({
  agent,
  tick,
  bubble,
  selected,
  onSelect,
  manager = false,
  index = 0,
}: {
  agent: LiveAgent;
  tick: number;
  bubble?: { text: string; seq: number };
  selected: boolean;
  onSelect: () => void;
  manager?: boolean;
  index?: number;
}) {
  const t = useTranslations("office");
  const status = STATUS_STYLE[agent.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex flex-col items-center rounded-xl border border-transparent px-2 pb-2 pt-1 transition-colors hover:border-zinc-700/70",
        selected && "border-emerald-500/30 bg-emerald-500/[0.04]",
        manager &&
          "bg-[radial-gradient(ellipse_at_center,rgba(45,212,191,0.08),transparent_70%)]",
      )}
      aria-label={`${agent.id} · ${t(STATUS_I18N[agent.status])} · ${t("clickToInspect")}`}
    >
      <span className="relative z-10 mb-1 flex max-w-[11rem] items-center gap-1">
        <span
          className={cn(
            "max-w-[9rem] truncate rounded border px-1.5 py-0.5 text-[9px]",
            status.text,
          )}
        >
          <ActivityText agent={agent} />
        </span>
        {agent.status !== "idle" ? <SinceLabel since={agent.since} /> : null}
      </span>
      <span className="relative mb-1">
        <PixelAgent
          seed={index + (manager ? 7 : 0)}
          manager={manager}
          state={pixelStateFromStatus(agent.status)}
          tick={tick}
          tone={agent.status === "error" ? "red" : undefined}
        />
        {bubble ? <ToolBubble text={bubble.text} seq={bubble.seq} /> : null}
        <span
          className={cn(
            "absolute -bottom-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full ring-2 ring-[#0e1420]",
            status.dot,
          )}
        />
      </span>
      <div className="relative w-full max-w-[10rem]">
        <div className="mx-auto h-1.5 w-full rounded-sm bg-[#2b3446]" />
        <div className="mx-auto -mt-0.5 flex h-6 w-[86%] items-center justify-center rounded-sm border border-[#1c2433] bg-[#1f2839] shadow-[0_4px_0_#141b28]">
          <span className="office-screen h-2.5 w-8 rounded-[1px] bg-sky-400/40" />
        </div>
        <div className="mx-auto mt-0.5 h-1 w-[40%] rounded bg-zinc-700" />
        <ProgressBar progress={agent.progress} className="mt-1" />
      </div>
      <span className="mt-1 max-w-full truncate font-mono text-[9px] text-zinc-400">
        {agent.id}
        {manager ? " · manager" : ` · ${t(ROLE_I18N[agent.role])}`}
      </span>
    </button>
  );
}

/**
 * Visual progress for the current run stage. Decorative: the status chip and
 * the stage/percent text carry the same information for screen readers.
 */
function ProgressBar({
  progress,
  className,
}: {
  progress?: number;
  className?: string;
}) {
  if (typeof progress !== "number") {
    return null;
  }
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <span
      className={cn("block h-1 w-full rounded bg-zinc-800", className)}
      aria-hidden="true"
    >
      <span
        className="block h-full rounded bg-emerald-400/80 motion-safe:transition-[width] motion-safe:duration-500"
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

function ActivityText({ agent }: { agent: LiveAgent }) {
  const t = useTranslations("office");
  switch (agent.activityKind) {
    case "waitingApproval":
      return <>{t("activityWaitingApproval")}</>;
    case "liveTool":
      return (
        <>{t("activityUsingTool", { tool: agent.activityDetail ?? "—" })}</>
      );
    case "liveStage":
      return (
        <>
          {t("activityWorkingStage", {
            stage: shortStage(agent.activityDetail) || "—",
          })}
        </>
      );
    case "teamIdle":
      return <>{t("activityTeamIdle")}</>;
    case "waitingDecision":
      return <>{t("activityWaitingDecision")}</>;
    case "supervising":
      return (
        <>
          {t("activitySupervising", { workflow: agent.activityDetail ?? "—" })}
        </>
      );
    case "lastActive":
      return (
        <>
          {t("activityLastActive", { workflow: agent.activityDetail ?? "—" })}
        </>
      );
    case "assigned":
      return (
        <>{t("activityAssigned", { workflow: agent.activityDetail ?? "—" })}</>
      );
    case "waitingMission":
      return <>{t("activityWaitingMission")}</>;
    case "mission":
      return <>{agent.activityDetail ?? agent.activity}</>;
    default:
      return <>{agent.activity}</>;
  }
}

function Plant() {
  return (
    <div className="flex flex-col items-center">
      <div className="flex gap-0.5">
        <span className="h-2 w-2 rounded-sm bg-emerald-700" />
        <span className="h-3 w-2 rounded-sm bg-emerald-600" />
        <span className="h-2 w-2 rounded-sm bg-emerald-800" />
      </div>
      <span className="h-3 w-4 rounded-b-sm bg-amber-900/80" />
    </div>
  );
}

function AgentPanel({
  agent,
  tick,
  packDir,
  onChat,
  team,
  onSelectAgent,
}: {
  agent: LiveAgent;
  tick: number;
  packDir: string;
  onChat: () => void;
  team: LiveAgent[];
  onSelectAgent: (id: string) => void;
}) {
  const t = useTranslations("office");
  const status = STATUS_STYLE[agent.status];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-border bg-zinc-950/60 p-1.5">
          <PixelAgent
            seed={agent.id.length}
            manager={agent.isManager}
            state={pixelStateFromStatus(agent.status)}
            tick={tick}
            tone={agent.status === "error" ? "red" : undefined}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm text-zinc-100">{agent.id}</p>
          <p className="mt-0.5 text-[10px] text-zinc-500">
            {agent.description}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px]",
                status.text,
              )}
            >
              <span className={cn("size-1.5 rounded-full", status.dot)} />
              {t(STATUS_I18N[agent.status])}
            </span>
            {agent.since ? <SinceLabel since={agent.since} /> : null}
            {agent.isManager ? (
              <Badge variant="violet">{t("manager")}</Badge>
            ) : (
              <Badge variant="outline">{t(ROLE_I18N[agent.role])}</Badge>
            )}
            <Badge variant="outline" className="font-mono">
              {agent.model}
            </Badge>
          </div>
        </div>
      </div>

      <p className="mt-3 rounded border border-border bg-zinc-950/40 px-2 py-1.5 text-[11px] text-zinc-300">
        <ActivityText agent={agent} />
      </p>

      {agent.stageId ? (
        <div className="mt-2 rounded border border-border/70 px-2 py-1.5 text-[10px]">
          <p className="text-zinc-500">{t("currentStage")}</p>
          <p className="mt-0.5 font-mono text-zinc-300">{agent.stageId}</p>
          <ProgressBar progress={agent.progress} className="mt-1.5" />
          {typeof agent.progress === "number" ? (
            <p className="mt-1 text-right font-mono text-[9px] text-zinc-500">
              {Math.round(agent.progress * 100)}%
            </p>
          ) : null}
        </div>
      ) : null}

      {agent.isManager ? (
        <div className="mt-3">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
            {t("directReports", { count: team.length })}
          </p>
          <ul className="space-y-1">
            {team.map((member) => {
              const memberStatus = STATUS_STYLE[member.status];
              return (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => onSelectAgent(member.id)}
                    className="flex w-full items-center gap-2 rounded border border-border px-2 py-1.5 text-left text-[10px] text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
                  >
                    <span
                      className={cn("size-1.5 rounded-full", memberStatus.dot)}
                    />
                    <span className="flex-1 font-mono">{member.id}</span>
                    <span className="max-w-[9rem] truncate text-zinc-500">
                      <ActivityText agent={member} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-zinc-600">{t("reportsTo")}</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div className="rounded border border-border px-2 py-1.5">
          <p className="text-zinc-500">{t("tools")}</p>
          <p className="mt-0.5 break-words font-mono text-zinc-300">
            {agent.tools.join(", ") || "—"}
          </p>
        </div>
        <div className="rounded border border-border px-2 py-1.5">
          <p className="text-zinc-500">{t("skills")}</p>
          <p className="mt-0.5 break-words font-mono text-zinc-300">
            {agent.skills.join(", ") || "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" onClick={onChat}>
          <MessageSquare className="size-3.5" />
          {t("askManager")}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link
            href={`/packs/${encodeURIComponent(packDir)}/studio?agent=${encodeURIComponent(agent.id)}`}
          >
            <Pencil className="size-3.5" />
            {t("editAgent")}
          </Link>
        </Button>
        {agent.runId ? (
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/runs/${encodeURIComponent(agent.runId)}`}>
              <ArrowUpRight className="size-3.5" />
              {t("openRun")}
            </Link>
          </Button>
        ) : null}
      </div>

      <div className="mt-auto pt-3">
        <p className="text-[9px] leading-relaxed text-zinc-600">
          {t("agentHint")}
        </p>
      </div>
    </div>
  );
}

const TASK_LANES: Array<{
  phase: LiveMission["phase"];
  labelKey: string;
  accent: string;
}> = [
  { phase: "demand", labelKey: "laneDemand", accent: "text-sky-300" },
  { phase: "build", labelKey: "laneBuild", accent: "text-emerald-300" },
  { phase: "deliver", labelKey: "laneDeliver", accent: "text-violet-300" },
  { phase: "blocked", labelKey: "laneBlocked", accent: "text-amber-300" },
  { phase: "done", labelKey: "laneDone", accent: "text-zinc-400" },
];

function TaskBoard({ missions }: { missions: LiveMission[] }) {
  const t = useTranslations("office");
  return (
    <section className="rounded-xl border border-border bg-card/60 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-medium text-zinc-200">
            {t("taskBoard")}
          </h2>
          <p className="text-[10px] text-zinc-500">{t("taskBoardHint")}</p>
        </div>
        <span className="font-mono text-[10px] text-zinc-600">
          {t("taskCount", { count: missions.length })}
        </span>
      </div>
      <div className="grid grid-flow-col auto-cols-[minmax(13.5rem,1fr)] gap-2 overflow-x-auto pb-1">
        {TASK_LANES.map((lane) => {
          const items = missions.filter(
            (mission) => mission.phase === lane.phase,
          );
          return (
            <div
              key={lane.phase}
              className="min-h-[8rem] rounded-lg border border-border bg-zinc-950/40 p-2"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span
                  className={`text-[10px] uppercase tracking-wider ${lane.accent}`}
                >
                  {t(lane.labelKey)}
                </span>
                <span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
                  {items.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {items.map((mission) => (
                  <TaskCard key={mission.runId} mission={mission} />
                ))}
                {items.length === 0 ? (
                  <p className="rounded border border-dashed border-border/70 px-2 py-4 text-center text-[9px] text-zinc-600">
                    {t("laneEmpty")}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TaskCard({ mission }: { mission: LiveMission }) {
  const t = useTranslations("office");
  const statusVariant =
    mission.status === "succeeded"
      ? "success"
      : mission.status === "failed"
        ? "danger"
        : mission.status === "paused"
          ? "warning"
          : "info";
  return (
    <Link
      href={`/runs/${encodeURIComponent(mission.runId)}`}
      className="block rounded-md border border-border bg-card px-2 py-1.5 transition-colors hover:border-zinc-600"
      title={mission.acceptance}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] text-zinc-500">
          {mission.runId.slice(-8)}
        </span>
        <span className="flex items-center gap-1">
          {mission.optimistic ? (
            <span className="rounded border border-sky-500/30 px-1 py-0.5 text-[8px] text-sky-300">
              {t("starting")}
            </span>
          ) : null}
          <Badge variant={statusVariant}>{mission.status}</Badge>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-200">
        {mission.goal}
      </p>
      {mission.currentStage || typeof mission.progress === "number" ? (
        <p className="mt-1 flex items-center justify-between gap-2 font-mono text-[9px] text-sky-300/80">
          <span className="truncate">
            {mission.currentStage ? shortStage(mission.currentStage) : "…"}
          </span>
          {typeof mission.progress === "number" ? (
            <span className="shrink-0 text-zinc-500">
              {Math.round(mission.progress * 100)}%
            </span>
          ) : null}
        </p>
      ) : null}
      <ProgressBar progress={mission.progress} className="mt-1" />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {mission.sellers.length > 0 ? (
          <span className="rounded border border-sky-500/25 bg-sky-500/5 px-1 py-0.5 text-[9px] text-sky-300">
            {t("sellerShort")} {mission.sellers.join(", ")}
          </span>
        ) : null}
        {mission.builders.length > 0 ? (
          <span className="rounded border border-emerald-500/25 bg-emerald-500/5 px-1 py-0.5 text-[9px] text-emerald-300">
            {t("builderShort")} {mission.builders.join(", ")}
          </span>
        ) : null}
        {mission.specialists.length > 0 ? (
          <span className="rounded border border-violet-500/25 bg-violet-500/5 px-1 py-0.5 text-[9px] text-violet-300">
            {t("specialistShort")} {mission.specialists.join(", ")}
          </span>
        ) : null}
      </div>
      <p className="mt-1 truncate font-mono text-[9px] text-zinc-600">
        {mission.workflowId}
        {mission.latestAgent ? ` · ${mission.latestAgent}` : ""}
      </p>
    </Link>
  );
}
