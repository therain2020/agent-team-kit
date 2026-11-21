import { ActivityFeed } from "@/components/activity/activity-feed";
import { PageHeader } from "@/components/kit/page-header";
import { StatCard } from "@/components/kit/stat-card";
import {
  InterventionPanel,
  SamplingReviewButton,
} from "@/components/observer/intervention-panel";
import { ObserverTimeline } from "@/components/observer/timeline";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadObserverView } from "@/lib/observer";
import { timeAgo } from "@/lib/utils";
import { Eye, History, Radio, ShieldCheck } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * `/observer` — the default, read-only view of the closed loop (98 §3.5,
 * issue #134). The timeline and metrics render on the server with no operator
 * action; interventions stay behind one controlled API. Jobs and artifacts
 * drill into the existing `/world` job hub rather than a second detail surface.
 */
export default async function ObserverPage() {
  const t = await getTranslations("observer");
  const locale = await getLocale();
  const view = await loadObserverView();
  const { metrics } = view;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-px-muted">
            <Eye className="size-3.5 text-px-accent" />
            {t("eyebrow")}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          label={t("interventionRate")}
          value={
            metrics.interventionRate === null
              ? "—"
              : `${metrics.interventionRate.toFixed(2)}/reaction`
          }
          hint={t("rateHint", {
            actions: metrics.actions7d,
            reactions: metrics.reactions7d,
          })}
        />
        <StatCard
          label={t("reactionAccuracy")}
          value={
            metrics.reactionAccuracy === null
              ? "—"
              : `${(metrics.reactionAccuracy * 100).toFixed(0)}%`
          }
          hint={t("accuracyHint", { failed: metrics.failedReactions7d })}
        />
        <StatCard
          label={t("gateDecisionMedian")}
          value={
            metrics.medianGateDecisionMinutes === null
              ? "—"
              : `${metrics.medianGateDecisionMinutes.toFixed(0)} min`
          }
          hint={t("medianHint", {
            decided: metrics.decidedGateApprovals7d,
            total: metrics.gateApprovals7d,
          })}
        />
        <StatCard
          label={t("actions24h")}
          value={String(metrics.actions24h)}
          hint={t("actionsHint", { total: metrics.actions7d })}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-amber-300" />
            {t("interventionsTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-zinc-500">{t("interventionsHint")}</p>
          <InterventionPanel editHref={view.editHref} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Radio className="size-4 text-sky-400" />
            {t("timelineTitle")}
          </CardTitle>
          <Badge variant="outline">
            {t("timelineCount", { count: view.timeline.length })}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-zinc-500">{t("timelineHint")}</p>
          <ObserverTimeline entries={view.timeline} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-violet-300" />
            {t("approvalsTitle")}
          </CardTitle>
          <Link
            href="/approvals"
            className="font-mono text-[10px] text-px-accent hover:underline"
          >
            {t("openApprovals")}
          </Link>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[11px] text-zinc-500">{t("approvalsHint")}</p>
          {view.gateApprovals.length === 0 ? (
            <p className="text-[11px] text-zinc-600">{t("approvalsEmpty")}</p>
          ) : (
            <ul className="space-y-2">
              {view.gateApprovals.slice(0, 10).map((approval) => (
                <li
                  key={approval.approvalId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <Badge variant={approvalVariant(approval.status)}>
                    {approval.status}
                  </Badge>
                  <Badge variant="outline">{approval.kind}</Badge>
                  <Link
                    href={approval.href}
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400 hover:underline"
                  >
                    {approval.approvalId}
                  </Link>
                  <span className="font-mono text-[10px] text-zinc-600">
                    {timeAgo(approval.createdAt, locale)}
                  </span>
                  <SamplingReviewButton approvalId={approval.approvalId} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-emerald-300" />
            {t("actionsTitle")}
          </CardTitle>
          <Badge variant="outline">
            {t("actionCount", { count: view.actions.length })}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[11px] text-zinc-500">{t("actionsHint2")}</p>
          {view.actions.length === 0 ? (
            <p className="text-[11px] text-zinc-600">{t("actionsEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {view.actions.map((action) => (
                <li
                  key={action.actionId}
                  className="flex flex-wrap items-center gap-2 px-3 py-2"
                >
                  <Badge variant={actionVariant(action.type)}>
                    {action.type}
                  </Badge>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {action.actor}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
                    {action.reason}
                  </span>
                  {action.reference ? (
                    <span className="font-mono text-[10px] text-violet-300">
                      {action.reference}
                    </span>
                  ) : null}
                  <span className="font-mono text-[10px] text-zinc-600">
                    {timeAgo(action.createdAt, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="size-4 text-emerald-400" />
            {t("liveTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[11px] text-zinc-500">{t("liveHint")}</p>
          <ActivityFeed maxHeight="20rem" />
        </CardContent>
      </Card>

      <p className="text-[10px] text-zinc-600">{t("readOnlyNote")}</p>
    </div>
  );
}

function approvalVariant(status: string) {
  if (status === "approved") {
    return "success" as const;
  }
  if (status === "rejected") {
    return "danger" as const;
  }
  if (status === "queued") {
    return "warning" as const;
  }
  return "outline" as const;
}

function actionVariant(type: string) {
  if (type === "kill") {
    return "danger" as const;
  }
  if (type === "rollback") {
    return "warning" as const;
  }
  if (type === "edit") {
    return "violet" as const;
  }
  if (type === "approve") {
    return "success" as const;
  }
  return "info" as const;
}
