"use client";

import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  TriggerConsoleData,
  TriggerPackView,
  TriggerView,
} from "@/lib/triggers";
import { formatCny } from "@/lib/utils";
import {
  Activity,
  CalendarClock,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export function TriggersConsole({
  initial,
  error,
}: {
  initial: TriggerConsoleData | null;
  error: string | null;
}) {
  const t = useTranslations("triggers");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function togglePack(pack: TriggerPackView) {
    setBusy(`pack:${pack.dirName}`);
    try {
      const response = await fetch("/api/autopilot", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packDir: pack.dirName, enabled: !pack.enabled }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("actionFailed"));
      }
      toast.success(pack.enabled ? t("packPaused") : t("packEnabled"));
      router.refresh();
    } catch (toggleError) {
      toast.error(
        toggleError instanceof Error ? toggleError.message : t("actionFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  function budgetLabel(trigger: TriggerView): string {
    const { budget, usage } = trigger;
    const usageText = usage.costTracked
      ? t("usageCost", {
          runs: usage.runs,
          cost: formatCny(usage.costCny),
        })
      : t("usageRuns", { runs: usage.runs });
    if (!budget) {
      return `${usageText} · ${t("noBudget")}`;
    }
    const caps: string[] = [];
    if (budget.dailyRuns !== undefined) {
      caps.push(t("capRuns", { used: usage.runs, cap: budget.dailyRuns }));
    }
    if (budget.dailyCostCny !== undefined) {
      caps.push(
        t("capCost", {
          used: formatCny(usage.costCny),
          cap: formatCny(budget.dailyCostCny),
        }),
      );
    }
    return `${usageText} · ${caps.join(" · ") || t("noBudget")}`;
  }

  async function fire(trigger: TriggerView) {
    if (
      trigger.runMode === "LIVE" &&
      !window.confirm(t("confirmLive", { triggerId: trigger.triggerId }))
    ) {
      return;
    }
    setBusy(`fire:${trigger.triggerId}`);
    try {
      const response = await fetch("/api/triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          triggerId: trigger.triggerId,
          ...(trigger.runMode === "LIVE" ? { confirmLive: true } : {}),
        }),
      });
      const payload = (await response.json()) as {
        dispatch?: "STARTED" | "USE_EXISTING" | "SKIPPED" | "FAILED";
        jobId?: string | null;
        gate?: string | null;
        reason?: string | null;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? payload.reason ?? t("fireFailed"));
      }
      if (payload.dispatch === "STARTED") {
        toast.success(t("fireStarted", { jobId: payload.jobId ?? "—" }));
      } else if (payload.dispatch === "USE_EXISTING") {
        toast.info(t("fireExisting", { jobId: payload.jobId ?? "—" }));
      } else if (payload.dispatch === "SKIPPED") {
        toast.warning(
          t("fireSkipped", {
            gate: payload.gate ?? "—",
            reason: payload.reason ?? "",
          }),
        );
      } else {
        toast.error(payload.reason ?? t("fireFailed"));
      }
      router.refresh();
    } catch (fireError) {
      toast.error(
        fireError instanceof Error ? fireError.message : t("fireFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("title")} description={t("description")} />
        <Card className="border-red-500/30 bg-red-500/5 p-6 text-center">
          <p className="text-sm text-red-200">{t("errorTitle")}</p>
          <p className="mt-1 font-mono text-[11px] text-red-300/70">{error}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => router.refresh()}
          >
            <RefreshCw className="size-3.5" />
            {t("reload")}
          </Button>
        </Card>
      </div>
    );
  }

  const packs = initial?.packs ?? [];
  const allTriggers = packs.flatMap((pack) => pack.triggers);
  const enabledTriggers = allTriggers.filter(
    (trigger) => trigger.enabled,
  ).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/jobs">{t("openJobs")}</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/ops?section=control">{t("openOps")}</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-2 sm:grid-cols-3">
        <Stat
          icon={Activity}
          label={t("daemon")}
          value={initial?.online ? t("online") : t("offline")}
          hint={
            initial?.heartbeat
              ? new Date(initial.heartbeat).toLocaleString(locale)
              : t("noHeartbeat")
          }
          tone={initial?.online ? "ok" : "warn"}
        />
        <Stat
          icon={Zap}
          label={t("triggers")}
          value={`${enabledTriggers} / ${allTriggers.length}`}
          hint={t("triggersHint")}
        />
        <Stat
          icon={CalendarClock}
          label={t("packs")}
          value={String(packs.length)}
          hint={t("packsHint")}
        />
      </div>

      {initial && initial.errors.length > 0 ? (
        <Card className="border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
            {t("errorsTitle")}
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-amber-200/80">
            {initial.errors.slice(0, 6).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {packs.length === 0 ? (
        <Card className="flex flex-col items-center justify-center border-dashed px-4 py-12 text-center">
          <Zap className="size-6 text-zinc-600" />
          <p className="mt-2 text-sm text-zinc-300">{t("empty")}</p>
          <p className="mt-1 text-[11px] text-zinc-500">{t("emptyHint")}</p>
          <Button size="sm" variant="outline" className="mt-3" asChild>
            <Link href="/packs">{t("browsePacks")}</Link>
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {packs.map((pack) => (
            <Card key={pack.dirName} className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                <span className="text-sm font-semibold text-zinc-100">
                  {pack.name}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">
                  packs/{pack.dirName}
                </span>
                <Badge variant={pack.enabled ? "success" : "outline"}>
                  {pack.enabled ? t("packOn") : t("packOff")}
                </Badge>
                <span className="font-mono text-[10px] text-zinc-500">
                  {pack.lastTickAt
                    ? t("lastTick", {
                        time: new Date(pack.lastTickAt).toLocaleString(locale),
                      })
                    : t("noHeartbeat")}
                </span>
                <Button
                  size="sm"
                  variant={pack.enabled ? "outline" : "default"}
                  className="ml-auto"
                  disabled={busy !== null}
                  onClick={() => togglePack(pack)}
                >
                  {pack.enabled ? (
                    <Pause className="size-3.5" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  {pack.enabled ? t("pausePack") : t("enablePack")}
                </Button>
              </div>
              <p className="border-b border-border/60 px-3 py-1.5 text-[10px] text-zinc-500">
                {t("packSwitchHint")}
              </p>
              {pack.lastError ? (
                <p className="border-b border-red-500/20 bg-red-500/5 px-3 py-1.5 font-mono text-[10px] text-red-300">
                  {t("lastError", { message: pack.lastError })}
                </p>
              ) : null}
              {pack.triggers.length === 0 ? (
                <p className="px-3 py-6 text-center text-[11px] text-zinc-500">
                  {t("noTriggers")}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {pack.triggers.map((trigger) => (
                    <li
                      key={trigger.triggerId}
                      id={`trigger-${trigger.triggerId}`}
                      className="scroll-mt-20 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-mono text-[12px] text-zinc-200">
                              {trigger.triggerId}
                            </span>
                            <Badge variant="info">
                              {t(`kind_${trigger.kind}`)}
                            </Badge>
                            <Badge variant="outline">
                              {t(`jobKind_${trigger.jobKind}`)}
                            </Badge>
                            {trigger.runMode === "LIVE" ? (
                              <Badge variant="danger">LIVE</Badge>
                            ) : null}
                            <Badge
                              variant={trigger.enabled ? "success" : "outline"}
                            >
                              {trigger.enabled ? t("enabled") : t("disabled")}
                            </Badge>
                          </div>
                          <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                            {t("target", { target: trigger.target })}
                            {" · "}
                            {trigger.routeId}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
                            {trigger.schedule ? (
                              <span className="flex items-center gap-1">
                                <CalendarClock className="size-3" />
                                {trigger.schedule.cron}
                                {" · "}
                                {trigger.schedule.nextRun
                                  ? t("nextFire", {
                                      time: new Date(
                                        trigger.schedule.nextRun,
                                      ).toLocaleString(locale),
                                    })
                                  : t("noNextFire")}
                              </span>
                            ) : (
                              <span>{t("eventDriven")}</span>
                            )}
                            <span>{budgetLabel(trigger)}</span>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button size="sm" variant="ghost" asChild>
                            <Link
                              href={`/jobs?trigger=${encodeURIComponent(trigger.triggerId)}`}
                              title={t("viewJobs")}
                            >
                              <ExternalLink className="size-3.5" />
                              {t("viewJobs")}
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => fire(trigger)}
                          >
                            <Zap className="size-3.5" />
                            {busy === `fire:${trigger.triggerId}`
                              ? t("firing")
                              : t("fire")}
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint: string;
  tone?: "ok" | "warn";
}) {
  return (
    <Card className="p-3">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <Icon className="size-3" />
        {label}
      </p>
      <p
        className={`mt-1 text-sm ${
          tone === "warn" ? "text-amber-300" : "text-zinc-200"
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
        {hint}
      </p>
    </Card>
  );
}
