"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/utils";
import type {
  AlertChannel,
  AlertRecord,
  AlertTier,
  AutonomyPresetRecord,
  OnCallPolicy,
  OpsGate,
} from "@kit/ops";
import { Check, Gauge, Moon, Siren } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const TIERS: AlertTier[] = ["P0", "P1", "P2", "P3"];
const CHANNELS: AlertChannel[] = ["im", "email"];

export function OperationsConsole({
  initial,
}: {
  initial: {
    policy: OnCallPolicy;
    gate: OpsGate;
    alerts: AlertRecord[];
    autonomy: {
      level: "manual" | "self-hosted-live";
      preset: AutonomyPresetRecord | null;
      liveAllowed: boolean;
    };
  };
}) {
  const t = useTranslations("ops");
  const locale = useLocale();
  const router = useRouter();
  const autonomy = initial.autonomy;
  const [policy, setPolicy] = useState<OnCallPolicy>(initial.policy);
  const [gate, setGate] = useState<OpsGate>(initial.gate);
  const [alerts, setAlerts] = useState<AlertRecord[]>(initial.alerts);
  const [saving, setSaving] = useState(false);
  const [acking, setAcking] = useState<string | null>(null);

  function toggleChannel(
    tier: AlertTier,
    channel: AlertChannel,
    enabled: boolean,
  ) {
    setPolicy((current) => {
      const existing = current.channels[tier];
      const next = enabled
        ? [...existing, channel]
        : existing.filter((item) => item !== channel);
      return {
        ...current,
        channels: { ...current.channels, [tier]: next },
      };
    });
  }

  function patchNightMode(next: Partial<OnCallPolicy["nightMode"]>) {
    setPolicy((current) => ({
      ...current,
      nightMode: { ...current.nightMode, ...next },
    }));
  }

  function toggleQuietWindow(enabled: boolean) {
    setPolicy((current) => ({
      ...current,
      quietWindow: enabled
        ? {
            start: current.quietWindow?.start ?? "23:00",
            end: current.quietWindow?.end ?? "07:00",
            timezone: current.nightMode.timezone,
          }
        : null,
    }));
  }

  function patchQuietWindow(
    next: Partial<NonNullable<OnCallPolicy["quietWindow"]>>,
  ) {
    setPolicy((current) =>
      current.quietWindow
        ? {
            ...current,
            quietWindow: { ...current.quietWindow, ...next },
          }
        : current,
    );
  }

  function setTierMinutes(
    field: "aggregationMinutes" | "ackSlaMinutes",
    tier: AlertTier,
    value: number,
  ) {
    setPolicy((current) => {
      if (field === "aggregationMinutes") {
        return {
          ...current,
          aggregationMinutes: {
            ...current.aggregationMinutes,
            [tier]: value,
          },
        };
      }
      return {
        ...current,
        ackSlaMinutes: { ...current.ackSlaMinutes, [tier]: value },
      };
    });
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/ops/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      });
      const payload = (await response.json()) as {
        policy?: OnCallPolicy;
        gate?: OpsGate;
        error?: string;
      };
      if (!response.ok || !payload.policy || !payload.gate) {
        throw new Error(payload.error ?? t("saveFailed"));
      }
      setPolicy(payload.policy);
      setGate(payload.gate);
      toast.success(t("saved"));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function acknowledge(alertId: string) {
    setAcking(alertId);
    try {
      const response = await fetch(
        `/api/ops/alerts/${encodeURIComponent(alertId)}/ack`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actor: "operator" }),
        },
      );
      const payload = (await response.json()) as {
        alert?: AlertRecord;
        error?: string;
      };
      if (!response.ok || !payload.alert) {
        throw new Error(payload.error ?? t("ackFailed"));
      }
      const acknowledged = payload.alert;
      setAlerts((current) =>
        current.map((item) =>
          item.alertId === acknowledged.alertId ? acknowledged : item,
        ),
      );
      toast.success(t("acknowledged"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ackFailed"));
    } finally {
      setAcking(null);
    }
  }

  return (
    <div className="space-y-5">
      {gate.readOnly ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          <Moon className="mt-0.5 size-4 shrink-0" />
          <span>
            {t("nightModeActive", {
              reason: gate.reason ?? t("nightModeFallback"),
            })}
          </span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-4 text-emerald-400" />
            {t("autonomyTitle")}
            <Badge
              variant={
                autonomy.level === "self-hosted-live" ? "success" : "outline"
              }
            >
              {t(`autonomyLevel_${autonomy.level}`)}
            </Badge>
          </CardTitle>
          <CardDescription>{t("autonomyDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-zinc-300">
          {autonomy.preset ? (
            <>
              <p className="font-mono text-xs text-zinc-400">
                {autonomy.preset.presetId}
              </p>
              <p className="text-xs text-zinc-500">
                {t("autonomyApplied", {
                  actor: autonomy.preset.appliedBy,
                  time: autonomy.preset.appliedAt,
                })}
              </p>
              <div className="grid gap-1 sm:grid-cols-2">
                <span>
                  {t("autonomyApplyMode", {
                    mode: autonomy.preset.config.applyMode,
                  })}
                </span>
                <span>
                  {t("autonomyBudget", {
                    cny: autonomy.preset.config.dailyCostCny,
                    runs: autonomy.preset.config.dailyRuns,
                  })}
                </span>
                <span>
                  {t("autonomyMaxTasks", {
                    count: autonomy.preset.config.maxTasks,
                  })}
                </span>
                <span>
                  {t("autonomyNightException", {
                    state: autonomy.preset.config.allowNight
                      ? t("autonomyOn")
                      : t("autonomyOff"),
                  })}
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                {t("autonomyRollbackHint")}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-500">{t("autonomyManualHint")}</p>
              {!autonomy.liveAllowed ? (
                <p className="text-xs text-amber-300">
                  {t("autonomyLiveClosed")}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("policyTitle")}</CardTitle>
          <CardDescription>{t("policyDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {t("channelsTitle")}
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2 pr-4 font-medium">{t("tier")}</th>
                    {CHANNELS.map((channel) => (
                      <th key={channel} className="pb-2 pr-4 font-medium">
                        {t(channel)}
                      </th>
                    ))}
                    <th className="pb-2 pr-4 font-medium">
                      {t("aggregation")}
                    </th>
                    <th className="pb-2 font-medium">{t("ackSla")}</th>
                  </tr>
                </thead>
                <tbody>
                  {TIERS.map((tier) => (
                    <tr key={tier} className="border-t border-border/60">
                      <td className="py-2 pr-4 font-mono text-xs text-zinc-200">
                        {tier}
                      </td>
                      {CHANNELS.map((channel) => (
                        <td key={channel} className="py-2 pr-4">
                          <input
                            type="checkbox"
                            aria-label={`${tier} ${t(channel)}`}
                            checked={policy.channels[tier].includes(channel)}
                            onChange={(event) =>
                              toggleChannel(tier, channel, event.target.checked)
                            }
                            className="size-4 accent-emerald-500"
                          />
                        </td>
                      ))}
                      <td className="py-2 pr-4">
                        <Input
                          type="number"
                          min={0}
                          value={policy.aggregationMinutes[tier]}
                          onChange={(event) =>
                            setTierMinutes(
                              "aggregationMinutes",
                              tier,
                              Math.max(0, Number(event.target.value) || 0),
                            )
                          }
                          className="h-8 w-24"
                        />
                      </td>
                      <td className="py-2">
                        <Input
                          type="number"
                          min={1}
                          value={policy.ackSlaMinutes[tier]}
                          onChange={(event) =>
                            setTierMinutes(
                              "ackSlaMinutes",
                              tier,
                              Math.max(1, Number(event.target.value) || 1),
                            )
                          }
                          className="h-8 w-24"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 rounded-lg border border-border px-4 py-3">
              <label className="flex items-center gap-2 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={policy.nightMode.enabled}
                  onChange={(event) =>
                    patchNightMode({ enabled: event.target.checked })
                  }
                  className="size-4 accent-emerald-500"
                />
                {t("nightModeEnabled")}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label
                  htmlFor="ops-night-start"
                  className="space-y-1 text-xs text-zinc-500"
                >
                  <span>{t("start")}</span>
                  <Input
                    id="ops-night-start"
                    type="time"
                    value={policy.nightMode.start}
                    onChange={(event) =>
                      patchNightMode({ start: event.target.value })
                    }
                    disabled={!policy.nightMode.enabled}
                  />
                </label>
                <label
                  htmlFor="ops-night-end"
                  className="space-y-1 text-xs text-zinc-500"
                >
                  <span>{t("end")}</span>
                  <Input
                    id="ops-night-end"
                    type="time"
                    value={policy.nightMode.end}
                    onChange={(event) =>
                      patchNightMode({ end: event.target.value })
                    }
                    disabled={!policy.nightMode.enabled}
                  />
                </label>
              </div>
              <label
                htmlFor="ops-night-timezone"
                className="block space-y-1 text-xs text-zinc-500"
              >
                <span>{t("timezone")}</span>
                <Input
                  id="ops-night-timezone"
                  value={policy.nightMode.timezone}
                  onChange={(event) =>
                    patchNightMode({ timezone: event.target.value })
                  }
                  disabled={!policy.nightMode.enabled}
                />
              </label>
              <label
                htmlFor="ops-night-action"
                className="block space-y-1 text-xs text-zinc-500"
              >
                <span>{t("action")}</span>
                <select
                  id="ops-night-action"
                  value={policy.nightMode.action}
                  onChange={(event) =>
                    patchNightMode({
                      action: event.target.value as
                        | "read_only"
                        | "pause_side_effects",
                    })
                  }
                  disabled={!policy.nightMode.enabled}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-zinc-200 outline-none focus-visible:border-ring"
                >
                  <option value="read_only">{t("readOnly")}</option>
                  <option value="pause_side_effects">
                    {t("pauseSideEffects")}
                  </option>
                </select>
              </label>
            </div>

            <div className="space-y-3 rounded-lg border border-border px-4 py-3">
              <label className="flex items-center gap-2 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={policy.quietWindow !== null}
                  onChange={(event) => toggleQuietWindow(event.target.checked)}
                  className="size-4 accent-emerald-500"
                />
                {t("quietWindowEnabled")}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label
                  htmlFor="ops-quiet-start"
                  className="space-y-1 text-xs text-zinc-500"
                >
                  <span>{t("start")}</span>
                  <Input
                    id="ops-quiet-start"
                    type="time"
                    value={policy.quietWindow?.start ?? "23:00"}
                    onChange={(event) =>
                      patchQuietWindow({ start: event.target.value })
                    }
                    disabled={policy.quietWindow === null}
                  />
                </label>
                <label
                  htmlFor="ops-quiet-end"
                  className="space-y-1 text-xs text-zinc-500"
                >
                  <span>{t("end")}</span>
                  <Input
                    id="ops-quiet-end"
                    type="time"
                    value={policy.quietWindow?.end ?? "07:00"}
                    onChange={(event) =>
                      patchQuietWindow({ end: event.target.value })
                    }
                    disabled={policy.quietWindow === null}
                  />
                </label>
              </div>
              <label
                htmlFor="ops-monthly-budget"
                className="block space-y-1 text-xs text-zinc-500"
              >
                <span>{t("monthlyBudget")}</span>
                <Input
                  id="ops-monthly-budget"
                  type="number"
                  min={1}
                  value={policy.monthlyBudget ?? ""}
                  placeholder={t("unlimited")}
                  onChange={(event) =>
                    setPolicy((current) => ({
                      ...current,
                      monthlyBudget:
                        event.target.value === ""
                          ? null
                          : Math.max(1, Number(event.target.value) || 1),
                    }))
                  }
                />
              </label>
              <p className="text-[11px] text-zinc-500">
                {t("monthlyBudgetHint")}
              </p>
            </div>
          </section>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              <Check className="size-4" />
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Siren className="size-4 text-amber-400" />
            {t("alertsTitle")}
            <Badge variant={alerts.length > 0 ? "warning" : "outline"}>
              {alerts.length}
            </Badge>
          </CardTitle>
          <CardDescription>{t("alertsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">
              {t("noAlerts")}
            </p>
          ) : (
            <div className="space-y-2">
              {alerts.map((alert) => (
                <div
                  key={alert.alertId}
                  className="rounded-lg border border-border px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={tierVariant(alert.tier)}>
                      {alert.tier}
                    </Badge>
                    <span className="text-sm font-medium text-zinc-100">
                      {alert.title}
                    </span>
                    {alert.count > 1 ? (
                      <Badge variant="outline">×{alert.count}</Badge>
                    ) : null}
                    <Badge variant={statusVariant(alert.status)}>
                      {t(`status_${alert.status}`)}
                    </Badge>
                    {ackOverdue(alert, policy) ? (
                      <Badge variant="danger">{t("overdue")}</Badge>
                    ) : null}
                    <Badge variant={notifyVariant(alert.notifyState)}>
                      {t(`notify_${alert.notifyState}`)}
                    </Badge>
                    <span className="ml-auto text-[11px] text-zinc-500">
                      {t("lastSeen", {
                        time: timeAgo(alert.lastSeenAt, locale),
                      })}
                    </span>
                  </div>
                  {alert.body ? (
                    <p className="mt-1.5 line-clamp-2 text-xs text-zinc-400">
                      {alert.body}
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    <span className="font-mono">{alert.kind}</span>
                    {alert.runId ? (
                      <span className="font-mono">{alert.runId}</span>
                    ) : null}
                    {alert.acknowledgedBy ? (
                      <span>
                        {t("acknowledgedBy", {
                          actor: alert.acknowledgedBy,
                        })}
                      </span>
                    ) : null}
                    {alert.status === "open" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        onClick={() => acknowledge(alert.alertId)}
                        disabled={acking === alert.alertId}
                      >
                        {acking === alert.alertId
                          ? t("acknowledging")
                          : t("acknowledge")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ackOverdue(alert: AlertRecord, policy: OnCallPolicy): boolean {
  if (alert.status !== "open") {
    return false;
  }
  const firstSeen = new Date(alert.firstSeenAt).getTime();
  if (!Number.isFinite(firstSeen)) {
    return false;
  }
  return Date.now() - firstSeen > policy.ackSlaMinutes[alert.tier] * 60_000;
}

function tierVariant(tier: AlertTier) {
  switch (tier) {
    case "P0":
      return "danger" as const;
    case "P1":
      return "warning" as const;
    case "P2":
      return "info" as const;
    default:
      return "outline" as const;
  }
}

function statusVariant(status: AlertRecord["status"]) {
  switch (status) {
    case "open":
      return "warning" as const;
    case "acknowledged":
      return "success" as const;
    default:
      return "outline" as const;
  }
}

function notifyVariant(state: AlertRecord["notifyState"]) {
  switch (state) {
    case "sent":
      return "success" as const;
    case "failed":
      return "danger" as const;
    case "none":
      return "outline" as const;
    default:
      return "warning" as const;
  }
}
