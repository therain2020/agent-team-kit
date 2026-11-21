"use client";

import {
  FactoryFloor,
  type FloorFlow,
} from "@/components/office/factory-floor";
import { NewMissionDialog } from "@/components/office/new-mission-dialog";
import { OfficeChat } from "@/components/office/office-chat";
import { OfficeListView } from "@/components/office/office-list-view";
import {
  StageDrawer,
  type StageTarget,
} from "@/components/office/stage-drawer";
import {
  PixelAgent,
  PixelClockControls,
  PixelMotionProvider,
  PixelProgress,
  TOOL_BUBBLE_MS,
} from "@/components/pixel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SinceLabel, WorldStatus } from "@/components/world/world-status";
import { factoryRunHref } from "@/lib/approvals-view";
import {
  type MissionPrefill,
  missionPrefillForAgent,
} from "@/lib/mission-prefill";
import type {
  OfficeActivePack,
  OfficeData,
  OfficeSnapshotPayload,
} from "@/lib/office";
import {
  type LiveAgent,
  type LiveMission,
  type OptimisticMission,
  deriveLiveAgents,
  deriveLiveMissions,
  missionRunIds,
} from "@/lib/office-live";
import type { OfficeView } from "@/lib/office-view";
import { type PixelAgentState, pixelStateFromStatus } from "@/lib/pixel-events";
import { useDocumentVisible } from "@/lib/use-document-visible";
import { useThrottledPresence } from "@/lib/use-throttled-presence";
import { useTicker } from "@/lib/use-ticker";
import { cn } from "@/lib/utils";
import { useWorld } from "@/lib/world-client";
import {
  type WorldCrate,
  appendCrate,
  diffWorldCues,
  seedBeltCrates,
} from "@/lib/world-cues";
import type { WorldSnapshot } from "@/lib/world-state";
import { shortStage } from "@/lib/world-state";
import type { UIMessage } from "ai";
import {
  ArrowUpRight,
  Bot,
  MessageSquare,
  Pencil,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Office floor v2 (issue #156): the pixel factory is back, rebuilt on the
 * shared world store. `useWorld` is the only live source — crates, bubbles,
 * stamps, belt direction and the flow meter all come from diffing stream
 * deltas, and clicking a station opens the stage drawer.
 */

/** Optimistic missions are dropped if the stream never materializes the run. */
const OPTIMISTIC_TTL_MS = 120_000;
/** How long a token/cost delta chip stays on screen. */
const FLOW_DELTA_MS = 4_000;
/** A run of this Pack unknown to SSR triggers one debounced snapshot fetch. */
const UNKNOWN_RUN_DEBOUNCE_MS = 1_500;
/** Never refetch the office snapshot more often than this. */
const SNAPSHOT_REFRESH_COOLDOWN_MS = 15_000;

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
  initialPanel?: "agent" | "chat";
  initialView?: OfficeView;
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
  initialView = "floor",
}: {
  data: OfficeData;
  initialMessages: UIMessage[];
  stubMode: boolean;
  initialPanel?: "agent" | "chat";
  initialView?: OfficeView;
}) {
  const t = useTranslations("office");
  const router = useRouter();
  const world = useWorld();
  const visible = useDocumentVisible();
  // The stream can reveal a run this Pack owns before SSR's mission list does;
  // a light `/api/office` snapshot then adds the mission without a page reload.
  const [activeSnapshot, setActiveSnapshot] = useState<OfficeActivePack | null>(
    null,
  );
  const active = activeSnapshot ?? data.active;
  const [selectedId, setSelectedId] = useState(
    active?.agents[0]?.id ?? "manager",
  );
  const [view, setView] = useState<OfficeView>(initialView);
  const [locked, setLocked] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [tab, setTab] = useState<"agent" | "chat">(initialPanel);
  const [missionOpen, setMissionOpen] = useState(false);
  const [missionIntent, setMissionIntent] = useState<string | undefined>(
    undefined,
  );
  const [missionPrefill, setMissionPrefill] = useState<
    MissionPrefill | undefined
  >(undefined);
  const [optimistic, setOptimistic] = useState<OptimisticMission[]>([]);
  const [stageTarget, setStageTarget] = useState<StageTarget | null>(null);
  const [crates, setCrates] = useState<WorldCrate[]>([]);
  const [bubbles, setBubbles] = useState<
    Record<string, { text: string; seq: number }>
  >({});
  const [stamp, setStamp] = useState<{
    outcome: "passed" | "failed";
    seq: number;
  } | null>(null);
  const [reverseSeq, setReverseSeq] = useState(0);
  const [flowDelta, setFlowDelta] = useState<{
    tokens: number;
    costCny: number;
    seq: number;
  } | null>(null);

  const baseMissions = active?.missions ?? [];
  const baseAgents = active?.agents ?? [];

  const ticker = useTicker();
  const pulse = ticker.pulse;
  const bubbleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cueSeq = useRef(0);
  const previousWorld = useRef<WorldSnapshot | null>(null);
  const snapshotFetchedAt = useRef(0);

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
  // 500ms per-agent sprite throttle (97 §3.2); status text stays immediate.
  const spriteStates = useThrottledPresence(agents);

  // Unknown run guard: the world stream is workspace-wide, so only runs that
  // use this Pack's workflows and are absent from the mission list count. A
  // debounced `/api/office` snapshot adds the mission card without reloading.
  useEffect(() => {
    const current = active;
    const runs = world.world?.runs;
    if (!current || !runs || runs.length === 0) {
      return;
    }
    const workflowIds = new Set(
      current.workflows.map((workflow) => workflow.id),
    );
    const known = new Set(current.missions.map((mission) => mission.runId));
    for (const mission of optimistic) {
      known.add(mission.runId);
    }
    const unknown = runs.some(
      (run) => workflowIds.has(run.workflowId) && !known.has(run.runId),
    );
    if (!unknown) {
      return;
    }
    if (Date.now() - snapshotFetchedAt.current < SNAPSHOT_REFRESH_COOLDOWN_MS) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      snapshotFetchedAt.current = Date.now();
      void (async () => {
        try {
          const response = await fetch(
            `/api/office?pack=${encodeURIComponent(current.dirName)}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) {
            return;
          }
          const payload = (await response.json()) as OfficeSnapshotPayload;
          if (payload.active && payload.active.dirName === current.dirName) {
            setActiveSnapshot(payload.active);
          }
        } catch {
          // The stream stays authoritative; the next delta retries.
        }
      })();
    }, UNKNOWN_RUN_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, world.world, optimistic]);

  useEffect(() => {
    const timers = bubbleTimers.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      if (flowTimer.current) {
        clearTimeout(flowTimer.current);
      }
    };
  }, []);

  // Every floor animation is a response to a world delta: the first snapshot
  // seeds the belt, later deltas yield crates/bubbles/stamps/flow cues. No
  // second EventSource — `useWorld` is the only transport.
  useEffect(() => {
    const next = world.world;
    const previous = previousWorld.current;
    previousWorld.current = next;
    if (!next) {
      return;
    }
    if (!previous) {
      setCrates((current) =>
        current.length > 0 ? current : seedBeltCrates(next.runs),
      );
      return;
    }
    const cues = diffWorldCues(previous, next);
    if (cues.length === 0) {
      return;
    }
    pulse();
    for (const cue of cues) {
      const seq = ++cueSeq.current;
      switch (cue.type) {
        case "crate":
          setCrates((current) =>
            appendCrate(current, {
              runId: cue.runId,
              label: cue.label,
              tone: cue.tone,
            }),
          );
          break;
        case "tool": {
          setBubbles((current) => ({
            ...current,
            [cue.agentId]: { text: cue.tool, seq },
          }));
          const previousTimer = bubbleTimers.current.get(cue.agentId);
          if (previousTimer) {
            clearTimeout(previousTimer);
          }
          bubbleTimers.current.set(
            cue.agentId,
            setTimeout(() => {
              bubbleTimers.current.delete(cue.agentId);
              setBubbles((current) => {
                if (current[cue.agentId]?.seq !== seq) {
                  return current;
                }
                const nextBubbles = { ...current };
                delete nextBubbles[cue.agentId];
                return nextBubbles;
              });
            }, TOOL_BUBBLE_MS + 200),
          );
          break;
        }
        case "stamp":
          setStamp({ outcome: cue.outcome, seq });
          break;
        case "reverse":
          setReverseSeq(seq);
          break;
        case "flow":
          setFlowDelta({ tokens: cue.tokens, costCny: cue.costCny, seq });
          if (flowTimer.current) {
            clearTimeout(flowTimer.current);
          }
          flowTimer.current = setTimeout(() => {
            setFlowDelta((current) => (current?.seq === seq ? null : current));
          }, FLOW_DELTA_MS);
          break;
      }
    }
  }, [world.world, pulse]);

  const scopedRunIds = useMemo(
    () => missionRunIds(missions, optimistic),
    [missions, optimistic],
  );
  const flow = useMemo<FloorFlow>(() => {
    const runs = (world.world?.runs ?? []).filter((run) =>
      scopedRunIds.has(run.runId),
    );
    return {
      tokens: runs.reduce((sum, run) => sum + run.tokens, 0),
      costCny: runs.reduce((sum, run) => sum + run.costCny, 0),
      delta: flowDelta,
    };
  }, [world.world, scopedRunIds, flowDelta]);

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

  function selectView(next: OfficeView) {
    setView(next);
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    if (next === "list") {
      url.searchParams.set("view", "list");
    } else {
      url.searchParams.delete("view");
    }
    window.history.replaceState(null, "", url);
  }

  function selectAgent(id: string) {
    setSelectedId(id);
    setLocked((current) => (selectedId === id ? !current : true));
    setTab("agent");
  }

  function openStage(agent: LiveAgent) {
    setSelectedId(agent.id);
    setLocked(true);
    setStageTarget({
      agentId: agent.id,
      runId: agent.runId ?? null,
      stageId: agent.stageId ?? null,
    });
  }

  function handleEscape() {
    if (stageTarget) {
      setStageTarget(null);
      return;
    }
    if (locked) {
      setLocked(false);
    }
  }

  if (!active) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-xs text-zinc-500">
          {t("noPack")}{" "}
          <Link
            href="/packs?new=1"
            className="text-emerald-300 hover:underline"
          >
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
          <fieldset
            className="flex min-w-0 border border-zinc-700"
            aria-label={t("viewToggleHint")}
          >
            {(["floor", "list"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => selectView(option)}
                aria-pressed={view === option}
                className={cn(
                  "px-2 py-1 font-mono text-[10px] uppercase",
                  view === option
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300",
                )}
              >
                {option === "floor" ? t("viewFloor") : t("viewList")}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link href="/ops?section=control">
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
          <Button
            size="sm"
            onClick={() => {
              setMissionIntent(undefined);
              setMissionPrefill(undefined);
              setMissionOpen(true);
            }}
          >
            <Plus className="size-3.5" />
            {t("newMission")}
          </Button>
        </div>
      </div>

      <TaskBoard missions={missions} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="min-w-0 space-y-3">
          {view === "list" ? (
            <div className="rounded-none border-2 border-px-line bg-px-bg p-3">
              <OfficeListView
                agents={agents}
                selectedId={selected?.id ?? null}
                onSelect={selectAgent}
                onOpen={openStage}
              />
            </div>
          ) : (
            <FactoryFloor
              packName={active.name}
              manager={manager}
              employees={employees}
              agents={agents}
              spriteStates={spriteStates}
              ticker={ticker}
              visible={visible}
              selectedId={selected?.id ?? null}
              locked={locked}
              hoveredId={hoveredId}
              bubbles={bubbles}
              crates={crates}
              stamp={stamp}
              reverseSeq={reverseSeq}
              flow={flow}
              suspended={stageTarget !== null}
              onHover={setHoveredId}
              onSelect={selectAgent}
              onOpen={openStage}
              onEscape={handleEscape}
            />
          )}
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
              spriteState={
                spriteStates[selected.id]?.state ??
                pixelStateFromStatus(selected.status)
              }
              tick={ticker.tick}
              packDir={active.dirName}
              team={employees}
              onSelectAgent={(id) => {
                setSelectedId(id);
                setTab("agent");
              }}
              onChat={() => selectPanel("chat")}
              onOpenStage={openStage}
              onStartMission={(agent) => {
                setMissionIntent(undefined);
                setMissionPrefill(missionPrefillForAgent(agent));
                setMissionOpen(true);
              }}
            />
          ) : null}
        </div>
      </div>

      <NewMissionDialog
        open={missionOpen}
        onOpenChange={(open) => {
          setMissionOpen(open);
          if (!open) {
            setMissionIntent(undefined);
            setMissionPrefill(undefined);
          }
        }}
        packDir={active.dirName}
        workflows={active.workflows}
        agents={agents}
        roleRules={active.roleRules}
        initialIntent={missionIntent}
        prefill={missionPrefill}
        onStarted={(mission) =>
          setOptimistic((current) =>
            current.some((entry) => entry.runId === mission.runId)
              ? current
              : [mission, ...current],
          )
        }
      />

      <StageDrawer
        packDir={active.dirName}
        target={stageTarget}
        onClose={() => setStageTarget(null)}
        onRerun={(workflow) => {
          setStageTarget(null);
          setMissionIntent(t("rerunIntent", { workflow: workflow ?? "—" }));
          setMissionPrefill(undefined);
          setMissionOpen(true);
        }}
      />
    </div>
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

function AgentPanel({
  agent,
  spriteState,
  tick,
  packDir,
  onChat,
  team,
  onSelectAgent,
  onOpenStage,
  onStartMission,
}: {
  agent: LiveAgent;
  /** Throttled sprite state; the text status still updates immediately. */
  spriteState: PixelAgentState;
  tick: number;
  packDir: string;
  onChat: () => void;
  team: LiveAgent[];
  onSelectAgent: (id: string) => void;
  onOpenStage: (agent: LiveAgent) => void;
  /** Opens the mission dialog seeded with this agent's role (97 §3.3). */
  onStartMission: (agent: LiveAgent) => void;
}) {
  const t = useTranslations("office");
  const router = useRouter();
  const status = STATUS_STYLE[agent.status];
  const runHref = agent.runId
    ? `/world?run=${encodeURIComponent(agent.runId)}`
    : null;
  const approvalHref =
    agent.runId && (agent.status === "blocked" || agent.status === "waiting")
      ? factoryRunHref(agent.runId)
      : null;

  /**
   * M/R/B only fire while focus is inside the panel, so they never shadow the
   * floor's J/K/Enter or the global console shortcuts. The handler sits on the
   * panel region and receives bubbled key events from its buttons and links.
   */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "m") {
      event.preventDefault();
      onStartMission(agent);
      return;
    }
    if (key === "r" && runHref) {
      event.preventDefault();
      router.push(runHref);
      return;
    }
    if (key === "b" && approvalHref) {
      event.preventDefault();
      router.push(approvalHref);
    }
  }

  return (
    <section
      aria-label={t("panelLabel", { agent: agent.id })}
      onKeyDown={handleKeyDown}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-border bg-zinc-950/60 p-1.5">
          <PixelAgent
            seed={agent.id.length}
            manager={agent.isManager}
            state={spriteState}
            tick={tick}
            tone={agent.status === "error" ? "red" : undefined}
            avatar={agent.avatar}
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
          <PixelProgress progress={agent.progress} className="mt-1.5" />
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => onStartMission(agent)}
          aria-keyshortcuts="M"
        >
          <Plus className="size-3.5" />
          {t("startMission")}
          <ShortcutKey>M</ShortcutKey>
        </Button>
        <Button size="sm" variant="outline" onClick={onChat}>
          <MessageSquare className="size-3.5" />
          {t("askManager")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onOpenStage(agent)}>
          <Bot className="size-3.5" />
          {t("openStageDetail")}
        </Button>
        {runHref ? (
          <Button size="sm" variant="ghost" asChild>
            <Link href={runHref} aria-keyshortcuts="R">
              <ArrowUpRight className="size-3.5" />
              {t("openRun")}
              <ShortcutKey>R</ShortcutKey>
            </Link>
          </Button>
        ) : null}
        {approvalHref ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={approvalHref} aria-keyshortcuts="B">
              <ShieldCheck className="size-3.5" />
              {t("handleApproval")}
              <ShortcutKey>B</ShortcutKey>
            </Link>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" asChild>
          <Link
            href={`/packs/${encodeURIComponent(packDir)}/studio?agent=${encodeURIComponent(agent.id)}`}
          >
            <Pencil className="size-3.5" />
            {t("editAgent")}
          </Link>
        </Button>
      </div>

      <p className="mt-2 text-[10px] text-zinc-500">{t("panelShortcuts")}</p>

      <div className="mt-auto pt-3">
        <p className="text-[9px] leading-relaxed text-zinc-600">
          {t("agentHint")}
        </p>
      </div>
    </section>
  );
}

/** Visible key hint next to a quick action; the shortcut is on the control. */
function ShortcutKey({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 font-mono text-[9px] leading-4 text-zinc-400">
      {children}
    </kbd>
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
      href={`/world?run=${encodeURIComponent(mission.runId)}`}
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
      <PixelProgress progress={mission.progress} className="mt-1" />
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
