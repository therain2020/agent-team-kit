"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AutopilotOverview } from "@/lib/autopilot";
import { formatCny } from "@/lib/utils";
import {
  Activity,
  Clock3,
  Coffee,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export function AutopilotConsole({
  overview,
}: {
  overview: AutopilotOverview;
}) {
  const t = useTranslations("autopilot");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const enabledPacks = overview.packs.filter((pack) => pack.enabled);

  async function toggle(packDir: string, enabled: boolean) {
    setBusy(packDir);
    try {
      const response = await fetch("/api/autopilot", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packDir, enabled }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("actionFailed"));
      }
      toast.success(enabled ? t("enabledToast") : t("disabledToast"));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function toggleAll(enabled: boolean) {
    setBusy("__all__");
    try {
      await Promise.all(
        overview.packs.map(async (pack) => {
          const response = await fetch("/api/autopilot", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ packDir: pack.dirName, enabled }),
          });
          if (!response.ok) {
            const payload = (await response.json()) as { error?: string };
            throw new Error(payload.error ?? t("actionFailed"));
          }
        }),
      );
      toast.success(enabled ? t("enabledToast") : t("disabledToast"));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function runTick() {
    setBusy("__tick__");
    try {
      const response = await fetch("/api/autopilot/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as {
        error?: string;
        launched?: unknown[];
        autoApproved?: unknown[];
        errors?: string[];
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("tickFailed"));
      }
      toast.success(
        t("tickDone", {
          launched: payload.launched?.length ?? 0,
          approved: payload.autoApproved?.length ?? 0,
        }),
        {
          description: payload.errors?.slice(0, 2).join(" · "),
        },
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("tickFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <Activity className="size-3" />
              {t("daemon")}
            </p>
            <p className="mt-1 flex items-center gap-2 text-sm text-zinc-200">
              <span
                className={`size-2 rounded-full ${overview.online ? "bg-emerald-400" : "bg-amber-400"}`}
              />
              {overview.online ? t("online") : t("offline")}
            </p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
              {overview.heartbeat
                ? new Date(overview.heartbeat).toLocaleString()
                : t("noHeartbeat")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <Zap className="size-3" />
              {t("activePacks")}
            </p>
            <p className="mt-1 text-sm text-zinc-200">
              {enabledPacks.length} / {overview.packs.length}
            </p>
            <p className="mt-0.5 text-[10px] text-zinc-600">
              {t("activePacksHint")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <ShieldCheck className="size-3" />
              {t("autoApprovals")}
            </p>
            <p className="mt-1 text-sm text-zinc-200">
              {overview.decisions.length}
            </p>
            <p className="mt-0.5 text-[10px] text-zinc-600">
              {t("autoApprovalsHint")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex h-full flex-col p-3">
            <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <TerminalSquare className="size-3" />
              {t("controls")}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={runTick}
                disabled={busy !== null}
              >
                <RefreshCw className="size-3.5" />
                {t("tick")}
              </Button>
              <Button
                size="sm"
                variant={enabledPacks.length > 0 ? "destructive" : "default"}
                onClick={() => toggleAll(enabledPacks.length === 0)}
                disabled={busy !== null || overview.packs.length === 0}
              >
                {enabledPacks.length > 0 ? (
                  <Pause className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {enabledPacks.length > 0 ? t("stopAll") : t("startAll")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {!overview.online ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[11px] text-amber-200/90">
          <Coffee className="mt-0.5 size-4 shrink-0" />
          <div>
            <p>{t("offlineHint")}</p>
            <code className="mt-1 block font-mono text-[10px] text-amber-100/80">
              bun run autopilot
            </code>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)]">
        <div className="space-y-3">
          {overview.packs.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-[11px] text-zinc-500">
                {t("noPacks")}
                <div className="mt-2">
                  <Link
                    className="text-emerald-300 hover:underline"
                    href="/packs"
                  >
                    {t("browsePacks")}
                  </Link>
                </div>
              </CardContent>
            </Card>
          ) : (
            overview.packs.map((pack) => (
              <Card key={pack.dirName}>
                <CardHeader className="flex-row items-start justify-between">
                  <div>
                    <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                      {pack.name}
                      <Badge variant={pack.enabled ? "success" : "outline"}>
                        {pack.enabled ? t("running") : t("paused")}
                      </Badge>
                      <span className="font-mono text-[10px] text-zinc-600">
                        packs/{pack.dirName}
                      </span>
                    </CardTitle>
                    <p className="mt-1 text-[10px] text-zinc-500">
                      {t("budgetToday", {
                        runs: pack.state.runsToday,
                        cost: formatCny(pack.state.spentToday),
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/packs/${encodeURIComponent(pack.dirName)}/studio`}
                    >
                      <Button size="sm" variant="ghost">
                        {t("edit")}
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant={pack.enabled ? "outline" : "default"}
                      onClick={() => toggle(pack.dirName, !pack.enabled)}
                      disabled={busy !== null}
                    >
                      {pack.enabled ? (
                        <Pause className="size-3.5" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      {pack.enabled ? t("pause") : t("start")}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  {pack.schedules.length === 0 ? (
                    <p className="text-[11px] text-zinc-500">
                      {t("noSchedules")}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {pack.schedules.map((schedule) => (
                        <div
                          key={schedule.id}
                          className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded border border-border px-2 py-1.5 text-[11px]"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-mono text-zinc-300">
                              {schedule.workflow}
                            </p>
                            <p className="font-mono text-[10px] text-zinc-600">
                              {schedule.cron} · {schedule.mode}
                            </p>
                          </div>
                          <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                            <Clock3 className="size-3" />
                            {schedule.nextRun
                              ? new Date(schedule.nextRun).toLocaleString()
                              : "—"}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-600">
                            {schedule.dailyRuns
                              ? `${schedule.dailyRuns}/day`
                              : ""}
                            {schedule.dailyCostCny !== undefined
                              ? ` · ¥${schedule.dailyCostCny}`
                              : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 text-[10px]">
                    {pack.autoApprove ? (
                      <span
                        className={`rounded border px-1.5 py-0.5 ${
                          pack.autoApprove.enabled
                            ? "border-emerald-500/30 text-emerald-300"
                            : "border-border text-zinc-500"
                        }`}
                      >
                        {t("autoApprove", {
                          risk: pack.autoApprove.maxRisk,
                          cost:
                            pack.autoApprove.maxRunCostCny !== undefined
                              ? formatCny(pack.autoApprove.maxRunCostCny)
                              : t("noCap"),
                        })}
                      </span>
                    ) : null}
                    {pack.evolution?.enabled ? (
                      <span className="flex items-center gap-1 rounded border border-violet-500/30 px-1.5 py-0.5 text-violet-300">
                        <Sparkles className="size-3" />
                        {t("evolution", {
                          cadence: pack.evolution.cadence,
                          mode: pack.evolution.autoApply
                            ? t("autoApply")
                            : t("review"),
                        })}
                      </span>
                    ) : null}
                    {pack.state.lastError ? (
                      <span className="max-w-full truncate rounded border border-red-500/25 px-1.5 py-0.5 text-red-300">
                        {pack.state.lastError}
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-emerald-400" />
              {t("recentAuto")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview.decisions.length === 0 ? (
              <p className="text-[11px] text-zinc-500">{t("noAuto")}</p>
            ) : (
              <ul className="space-y-2">
                {overview.decisions.map((decision, index) => (
                  <li
                    key={`${decision.runId}-${index}`}
                    className="rounded border border-border px-2 py-1.5 text-[10px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-zinc-300">
                        {decision.stageName || decision.runId}
                      </span>
                      <Badge variant="success">{decision.decision}</Badge>
                    </div>
                    <p className="mt-1 text-zinc-500">{decision.rationale}</p>
                    <p className="mt-1 font-mono text-[9px] text-zinc-600">
                      {decision.actor} ·{" "}
                      {new Date(decision.createdAt).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
