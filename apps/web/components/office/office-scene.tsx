"use client";

import { NewMissionDialog } from "@/components/office/new-mission-dialog";
import { OfficeChat } from "@/components/office/office-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  OfficeActivePack,
  OfficeAgentView,
  OfficeData,
  OfficeMissionView,
} from "@/lib/office";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import {
  ArrowUpRight,
  Bot,
  Coffee,
  Gamepad2,
  MessageSquare,
  Monitor,
  Pencil,
  Plus,
  ShieldCheck,
  Users,
  Wifi,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const PALETTES = [
  { hair: "#2f221c", shirt: "#4f7cff", pants: "#23304d", skin: "#f0c49f" },
  { hair: "#6b3f25", shirt: "#e8a33d", pants: "#3a2f2a", skin: "#e7b48d" },
  { hair: "#1e1e24", shirt: "#45b39d", pants: "#223b36", skin: "#f2c9a8" },
  { hair: "#7a4b2a", shirt: "#c96bce", pants: "#332744", skin: "#dfa77f" },
  { hair: "#2a2a33", shirt: "#d96c6c", pants: "#41252b", skin: "#f5d0b0" },
  { hair: "#4a2f24", shirt: "#63b3ed", pants: "#25384d", skin: "#e8b58c" },
];

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
  error: "statusError",
} as const;

const STATUS_STYLE: Record<
  OfficeAgentView["status"],
  { dot: string; label: string; text: string }
> = {
  working: {
    dot: "bg-emerald-400",
    label: "working",
    text: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  },
  blocked: {
    dot: "bg-amber-400",
    label: "blocked",
    text: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  },
  error: {
    dot: "bg-red-400",
    label: "error",
    text: "border-red-500/40 bg-red-500/10 text-red-200",
  },
  idle: {
    dot: "bg-zinc-500",
    label: "idle",
    text: "border-border bg-zinc-900 text-zinc-400",
  },
};

export function OfficeScene({
  data,
  initialMessages,
  stubMode,
}: {
  data: OfficeData;
  initialMessages: UIMessage[];
  stubMode: boolean;
}) {
  const t = useTranslations("office");
  const router = useRouter();
  const active = data.active;
  const [selectedId, setSelectedId] = useState(
    active?.agents[0]?.id ?? "manager",
  );
  const [tab, setTab] = useState<"agent" | "chat">("agent");
  const [missionOpen, setMissionOpen] = useState(false);

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

  const selected =
    active.agents.find((agent) => agent.id === selectedId) ?? active.agents[0];
  const manager = active.agents.find((agent) => agent.isManager);
  const employees = active.agents.filter((agent) => !agent.isManager);
  const working = active.agents.filter(
    (agent) => agent.status === "working",
  ).length;
  const blocked = active.agents.filter(
    (agent) => agent.status === "blocked",
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={active.dirName}
            onChange={(event) =>
              router.push(
                `/office?pack=${encodeURIComponent(event.target.value)}`,
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
            {t("teamSize", { count: active.agents.length })}
          </Badge>
          <Badge variant={working > 0 ? "success" : "outline"}>
            {t("working", { count: working })}
          </Badge>
          {blocked > 0 ? (
            <Badge variant="warning">{t("blocked", { count: blocked })}</Badge>
          ) : null}
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

      <TaskBoard missions={active.missions} />

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
                  <Wifi className="size-3 text-emerald-400" />
                  {t("local")}
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
                      selected={selected?.id === agent.id}
                      onSelect={() => {
                        setSelectedId(agent.id);
                        setTab("agent");
                      }}
                      index={index}
                    />
                  ))}
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
              onClick={() => setTab("agent")}
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
              onClick={() => setTab("chat")}
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
              packDir={active.dirName}
              team={employees}
              onSelectAgent={(id) => {
                setSelectedId(id);
                setTab("agent");
              }}
              onChat={() => setTab("chat")}
            />
          ) : null}
        </div>
      </div>

      <NewMissionDialog
        open={missionOpen}
        onOpenChange={setMissionOpen}
        packDir={active.dirName}
        workflows={active.workflows}
        agents={active.agents}
        roleRules={active.roleRules}
      />
    </div>
  );
}

function Station({
  agent,
  selected,
  onSelect,
  manager = false,
  index = 0,
}: {
  agent: OfficeAgentView;
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
      <span
        className={cn(
          "relative z-10 mb-1 max-w-[11rem] truncate rounded border px-1.5 py-0.5 text-[9px]",
          status.text,
        )}
      >
        <ActivityText agent={agent} />
      </span>
      <span className="relative mb-1">
        <PixelCharacter
          seed={index + (manager ? 7 : 0)}
          manager={manager}
          working={agent.status === "working"}
        />
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
      </div>
      <span className="mt-1 max-w-full truncate font-mono text-[9px] text-zinc-400">
        {agent.id}
        {manager ? " · manager" : ` · ${t(ROLE_I18N[agent.role])}`}
      </span>
    </button>
  );
}

function ActivityText({ agent }: { agent: OfficeAgentView }) {
  const t = useTranslations("office");
  switch (agent.activityKind) {
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

function PixelCharacter({
  seed,
  manager,
  working,
}: {
  seed: number;
  manager: boolean;
  working: boolean;
}) {
  const fallback = {
    hair: "#2f221c",
    shirt: "#4f7cff",
    pants: "#23304d",
    skin: "#f0c49f",
  };
  const palette = manager
    ? { hair: "#2b2b33", shirt: "#d4b45c", pants: "#1f2937", skin: "#f0c49f" }
    : (PALETTES[seed % PALETTES.length] ?? fallback);
  return (
    <svg
      viewBox="0 0 16 24"
      width={manager ? 54 : 42}
      height={manager ? 76 : 60}
      shapeRendering="crispEdges"
      className={cn(
        "drop-shadow-[0_6px_8px_rgba(0,0,0,0.45)]",
        working && "pixel-bob-idle",
      )}
      aria-hidden="true"
    >
      <ellipse cx="8" cy="23" rx="5" ry="1" fill="rgba(0,0,0,0.35)" />
      <rect x="5" y="18" width="2" height="4" fill={palette.pants} />
      <rect x="9" y="18" width="2" height="4" fill={palette.pants} />
      <rect x="4" y="22" width="3" height="1" fill="#111827" />
      <rect x="9" y="22" width="3" height="1" fill="#111827" />
      <rect x="4" y="11" width="8" height="7" fill={palette.shirt} />
      <rect x="3" y="12" width="1" height="5" fill={palette.shirt} />
      <rect x="12" y="12" width="1" height="5" fill={palette.shirt} />
      <rect x="4" y="9" width="8" height="2" fill={palette.shirt} />
      <rect x="5" y="4" width="6" height="6" fill={palette.skin} />
      <rect x="4" y="3" width="8" height="2" fill={palette.hair} />
      <rect x="4" y="4" width="2" height="3" fill={palette.hair} />
      <rect x="10" y="4" width="2" height="3" fill={palette.hair} />
      <rect x="6" y="7" width="1" height="1" fill="#1f2937" />
      <rect x="9" y="7" width="1" height="1" fill="#1f2937" />
      <rect x="7" y="9" width="2" height="0.5" fill="#b5766a" />
      {manager ? (
        <>
          <rect x="7" y="6" width="2" height="4" fill="#f5f5f4" />
          <rect x="7.5" y="7" width="1" height="3" fill="#9f1239" />
          <rect x="4" y="9" width="8" height="1" fill="#1f2937" />
        </>
      ) : null}
    </svg>
  );
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
  packDir,
  onChat,
  team,
  onSelectAgent,
}: {
  agent: OfficeAgentView;
  packDir: string;
  onChat: () => void;
  team: OfficeAgentView[];
  onSelectAgent: (id: string) => void;
}) {
  const t = useTranslations("office");
  const status = STATUS_STYLE[agent.status];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <div className="flex items-start gap-3">
        <div className="rounded-lg border border-border bg-zinc-950/60 p-1.5">
          <PixelCharacter
            seed={agent.id.length}
            manager={agent.isManager}
            working={agent.status === "working"}
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
  phase: OfficeMissionView["phase"];
  labelKey: string;
  accent: string;
}> = [
  { phase: "demand", labelKey: "laneDemand", accent: "text-sky-300" },
  { phase: "build", labelKey: "laneBuild", accent: "text-emerald-300" },
  { phase: "deliver", labelKey: "laneDeliver", accent: "text-violet-300" },
  { phase: "blocked", labelKey: "laneBlocked", accent: "text-amber-300" },
  { phase: "done", labelKey: "laneDone", accent: "text-zinc-400" },
];

function TaskBoard({ missions }: { missions: OfficeMissionView[] }) {
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

function TaskCard({ mission }: { mission: OfficeMissionView }) {
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
        <Badge variant={statusVariant}>{mission.status}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-200">
        {mission.goal}
      </p>
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
