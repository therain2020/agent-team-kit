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
import { timeAgo } from "@/lib/utils";
import type {
  AlertRecord,
  AlertStatus,
  AlertTier,
  OnCallPolicy,
} from "@kit/ops";
import { Siren } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Filter = "all" | AlertStatus;

const FILTERS: Filter[] = ["all", "open", "acknowledged"];

export function ackOverdue(
  alert: AlertRecord,
  policy: OnCallPolicy,
  now: number,
): boolean {
  if (alert.status !== "open") {
    return false;
  }
  const firstSeen = new Date(alert.firstSeenAt).getTime();
  if (!Number.isFinite(firstSeen)) {
    return false;
  }
  return now - firstSeen > policy.ackSlaMinutes[alert.tier] * 60_000;
}

export function tierVariant(tier: AlertTier) {
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

export function OpsAlertsPanel({
  initialAlerts,
  policy,
  operator,
  initialNow,
}: {
  initialAlerts: AlertRecord[];
  policy: OnCallPolicy;
  operator: string;
  initialNow: number;
}) {
  const t = useTranslations("ops");
  const locale = useLocale();
  const router = useRouter();
  const [alerts, setAlerts] = useState<AlertRecord[]>(initialAlerts);
  const [acking, setAcking] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // Relative times must be derived from the same clock on server and client,
  // otherwise a seconds-level drift triggers a hydration mismatch.
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const counts = useMemo(() => {
    const open = alerts.filter((alert) => alert.status === "open");
    return {
      open: open.length,
      overdue: open.filter((alert) => ackOverdue(alert, policy, now)).length,
    };
  }, [alerts, policy, now]);

  const visible = useMemo(
    () =>
      filter === "all"
        ? alerts
        : alerts.filter((alert) => alert.status === filter),
    [alerts, filter],
  );

  async function acknowledge(alertId: string) {
    setAcking(alertId);
    try {
      const response = await fetch(
        `/api/ops/alerts/${encodeURIComponent(alertId)}/ack`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ actor: operator }),
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
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("ackFailed"));
    } finally {
      setAcking(null);
    }
  }

  return (
    <Card id="ops-alerts-list">
      <CardHeader className="gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Siren className="size-4 text-amber-400" />
            {t("alertsTitle")}
            <Badge variant={counts.open > 0 ? "warning" : "outline"}>
              {counts.open}
            </Badge>
            {counts.overdue > 0 ? (
              <Badge variant="danger">
                {t("overdueCount", { count: counts.overdue })}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>{t("alertsDescription")}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setFilter(item)}
              aria-pressed={filter === item}
              className={`rounded border px-2 py-0.5 text-[10px] transition-colors ${
                filter === item
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-border text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {item === "all"
                ? t("filterAll")
                : item === "open"
                  ? t("filterOpen")
                  : t("filterAcknowledged")}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            {t("noAlerts")}
          </p>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            {t("noAlertsMatch")}
          </p>
        ) : (
          <div className="space-y-2">
            {visible.map((alert) => (
              <div
                key={alert.alertId}
                className="rounded-lg border border-border px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={tierVariant(alert.tier)}>{alert.tier}</Badge>
                  <span className="text-sm font-medium text-zinc-100">
                    {alert.title}
                  </span>
                  {alert.count > 1 ? (
                    <Badge variant="outline">×{alert.count}</Badge>
                  ) : null}
                  <Badge variant={statusVariant(alert.status)}>
                    {t(`status_${alert.status}`)}
                  </Badge>
                  {ackOverdue(alert, policy, now) ? (
                    <Badge variant="danger">{t("overdue")}</Badge>
                  ) : null}
                  <Badge variant={notifyVariant(alert.notifyState)}>
                    {t(`notify_${alert.notifyState}`)}
                  </Badge>
                  <span className="ml-auto text-[11px] text-zinc-500">
                    {t("lastSeen", {
                      time: timeAgo(alert.lastSeenAt, locale, now),
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
                      {t("acknowledgedBy", { actor: alert.acknowledgedBy })}
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
  );
}
