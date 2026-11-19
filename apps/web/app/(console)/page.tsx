import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { StatCard } from "@/components/kit/stat-card";
import { RunStatusBadge } from "@/components/kit/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadPausedRuns, loadRunDetail, loadRunSummaries } from "@/lib/runs";
import { getStore } from "@/lib/store";
import { formatCny, formatDuration, timeAgo, timeUntil } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Coins,
  FileText,
  Inbox,
  MessageSquare,
  Play,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CommandCenterPage() {
  const t = await getTranslations("command");
  const statusT = await getTranslations("status");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const store = await getStore();
  const loaded = await Promise.all([
    loadRunSummaries(30, store),
    loadPausedRuns(store),
    store.artifactStore.listRecent("default", 8),
  ]).catch((error: unknown) => {
    console.error("command center backend unreachable", error);
    return null;
  });

  if (!loaded) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("title")} description={t("description")} />
        <EmptyState
          icon={AlertTriangle}
          title={t("backendDownTitle")}
          description={t("backendDownDescription")}
          action={
            <Link
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
              href="/packs"
            >
              {t("openPacks")} →
            </Link>
          }
        />
      </div>
    );
  }

  const [summaries, paused, recentArtifacts] = loaded;

  const recentArtifactViews = await Promise.all(
    recentArtifacts.map(async (artifact) => ({
      artifact,
      manifest: await store.manifests.get(artifact.manifestId),
    })),
  );

  const running = summaries.filter((item) => item.run.status === "running");
  const failed = summaries.filter((item) => item.run.status === "failed");
  const activeDetails = await Promise.all(
    running.slice(0, 4).map(async (item) => ({
      summary: item,
      detail: await loadRunDetail(item.run.runId, store),
    })),
  );

  const today = new Date().toDateString();
  const todayRuns = summaries.filter(
    (item) => new Date(item.run.createdAt).toDateString() === today,
  );
  const finished = summaries.filter((item) =>
    ["succeeded", "failed"].includes(item.run.status),
  );
  const passed = finished.filter((item) => item.run.status === "succeeded");
  const passRate =
    finished.length > 0
      ? Math.round((passed.length / finished.length) * 100)
      : 0;
  const spendToday = todayRuns.reduce((sum, item) => sum + item.costCny, 0);

  const needsYou = [
    ...paused.map((item) => ({ type: "approval" as const, ...item })),
    ...failed.slice(0, 4).map((item) => ({ type: "failed" as const, ...item })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href="/office?panel=manager">
                <MessageSquare className="size-3.5" />
                {t("askManager")}
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/packs">
                <Play className="size-3.5" />
                {t("startRun")}
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          label={t("needsYou")}
          value={String(needsYou.length)}
          hint={
            paused.length > 0
              ? t("approvalsWaiting", { count: paused.length })
              : needsYou.length > 0
                ? t("openItems", { count: needsYou.length })
                : t("allClear")
          }
        />
        <StatCard
          label={t("inFlight")}
          value={String(running.length)}
          hint={t("runningWorkflows")}
        />
        <StatCard
          label={t("passRate")}
          value={`${passRate}%`}
          hint={t("passHint", {
            passed: passed.length,
            total: finished.length,
          })}
        />
        <StatCard
          label={t("spendToday")}
          value={formatCny(spendToday)}
          hint={t("runsStarted", { count: todayRuns.length })}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-5">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-amber-400" />
                {t("needsYou")}
              </CardTitle>
              <Badge variant={needsYou.length > 0 ? "warning" : "outline"}>
                {t("openCount", { count: needsYou.length })}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {needsYou.length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title={t("allClear")}
                  description={t("noAttention")}
                  className="border-0 py-6"
                />
              ) : (
                needsYou.map((item) =>
                  item.type === "approval" ? (
                    <Link
                      key={`paused-${item.run.runId}`}
                      href={
                        item.approval
                          ? `/inbox/${encodeURIComponent(item.approval.requestId)}`
                          : `/runs/${encodeURIComponent(item.run.runId)}`
                      }
                      className="flex items-start gap-3 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 transition-colors hover:bg-amber-500/10"
                    >
                      <Inbox className="mt-0.5 size-4 shrink-0 text-amber-400" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-zinc-200">
                          {item.run.runId}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-400">
                          {item.approval?.summary || t("waitingApproval")}
                        </p>
                      </div>
                      <div className="text-right text-[10px] text-zinc-500">
                        <p>{formatCny(item.costCny)}</p>
                        <p className="mt-1">
                          {item.approval?.expiresAt
                            ? t("expiresIn", {
                                time: timeUntil(
                                  item.approval.expiresAt,
                                  locale,
                                ),
                              })
                            : statusT("paused")}
                        </p>
                      </div>
                    </Link>
                  ) : (
                    <Link
                      key={`failed-${item.run.runId}`}
                      href={`/runs/${encodeURIComponent(item.run.runId)}`}
                      className="flex items-start gap-3 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2.5 transition-colors hover:bg-red-500/10"
                    >
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-400" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-zinc-200">
                          {item.run.runId}
                        </p>
                        <p className="mt-0.5 text-[11px] text-zinc-400">
                          {t("runFailedKeep", {
                            count: item.artifactCount,
                          })}
                        </p>
                      </div>
                      <ArrowRight className="mt-1 size-3.5 text-zinc-600" />
                    </Link>
                  ),
                )
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <CircleDashed className="size-4 text-sky-400" />
                {t("inFlight")}
              </CardTitle>
              <Link
                href="/runs?status=running"
                className="text-[11px] text-muted-foreground hover:text-zinc-200"
              >
                {t("allRuns")}
              </Link>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeDetails.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t("noRunning")}
                </p>
              ) : (
                activeDetails.map(({ summary, detail }) => (
                  <Link
                    key={summary.run.runId}
                    href={`/runs/${encodeURIComponent(summary.run.runId)}`}
                    className="block rounded-md border border-border px-3 py-2.5 transition-colors hover:bg-accent/60"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs text-zinc-200">
                        {summary.run.runId}
                      </span>
                      <RunStatusBadge status={summary.run.status} />
                      <span className="ml-auto text-[10px] text-zinc-500">
                        {formatDuration(
                          summary.run.createdAt,
                          summary.run.updatedAt,
                          locale,
                        )}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-sky-500/70"
                          style={{
                            width: `${
                              detail && detail.stages.length > 0
                                ? Math.round(
                                    (detail.stages.filter(
                                      (stage) => stage.status === "succeeded",
                                    ).length /
                                      detail.stages.length) *
                                      100,
                                  )
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-zinc-500">
                        {detail
                          ? t("stagesProgress", {
                              done: detail.stages.filter(
                                (stage) => stage.status === "succeeded",
                              ).length,
                              total: detail.stages.length,
                            })
                          : t("starting")}
                      </span>
                    </div>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-emerald-400" />
              {t("recentArtifacts")}
            </CardTitle>
            <Link
              href="/runs"
              className="text-[11px] text-muted-foreground hover:text-zinc-200"
            >
              {common("browse")}
            </Link>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recentArtifactViews.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("noArtifacts")}
              </p>
            ) : (
              recentArtifactViews.map(({ artifact, manifest }) => (
                <Link
                  key={`${artifact.artifactId}:${artifact.version}`}
                  href={
                    manifest
                      ? `/runs/${encodeURIComponent(manifest.runId)}?artifact=${encodeURIComponent(
                          `${artifact.artifactId}:${artifact.version}`,
                        )}`
                      : "/runs"
                  }
                  className="flex items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-accent/60"
                >
                  <FileText className="mt-0.5 size-3.5 shrink-0 text-zinc-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11px] text-zinc-300">
                      {artifact.artifactId}
                    </p>
                    <p className="truncate text-[10px] text-zinc-500">
                      {manifest?.producer.agentId ?? common("unknown")} ·{" "}
                      {manifest?.stageId.split(":").slice(-1)[0] ??
                        common("stage")}
                    </p>
                  </div>
                  <div className="text-right text-[10px] text-zinc-500">
                    <p>{formatCny(manifest?.cost.amount ?? 0)}</p>
                    <p className="mt-0.5">
                      {timeAgo(artifact.createdAt, locale)}
                    </p>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Coins className="size-3.5" />
          {t("costNote", { count: summaries.length })}
        </div>
        <Link
          href="/evolution"
          className="text-[11px] text-muted-foreground hover:text-zinc-200"
        >
          {t("evolutionLab")}
        </Link>
      </div>
    </div>
  );
}
