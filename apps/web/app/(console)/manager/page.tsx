import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { RunModeBadge, RunStatusBadge } from "@/components/kit/status-badge";
import { ManagerChat } from "@/components/manager/chat";
import { RunPicker } from "@/components/manager/run-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadManagerExchanges } from "@/lib/manager";
import { loadRunDetail } from "@/lib/runs";
import { getStore } from "@/lib/store";
import { formatCny, timeAgo } from "@/lib/utils";
import { buildManagerBrief } from "@kit/manager";
import {
  ArrowUpRight,
  Coins,
  FileText,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ManagerPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string }>;
}) {
  const { runId } = await searchParams;
  const t = await getTranslations("manager");
  const locale = await getLocale();
  const store = await getStore();
  const runs = await store.runs.listRecent(30);
  const selectedRunId = runId ?? runs[0]?.runId;

  if (!selectedRunId) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("title")} description={t("description")} />
        <EmptyState
          icon={MessageSquare}
          title={t("noRunsTitle")}
          description={t("noRunsDescription")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/packs">{t("browsePacks")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const detail = await loadRunDetail(selectedRunId, store);
  if (!detail) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("title")} description={t("notFoundDescription")} />
        <EmptyState
          icon={MessageSquare}
          title={t("notFoundTitle")}
          description={t("notFoundDescription")}
        />
      </div>
    );
  }

  const { messages } = await loadManagerExchanges(selectedRunId, store);
  const { brief } = await buildManagerBrief(store, selectedRunId, {
    publish: false,
  });
  const failedGates = detail.gates.filter((gate) => !gate.pass);
  const stubMode =
    process.env.KIT_MODEL_MODE === "stub" || !process.env.DEEPSEEK_API_KEY;

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[34rem] flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href={`/runs/${encodeURIComponent(selectedRunId)}`}>
              {t("openRun")}
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        }
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <div className="space-y-3 overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle>{t("context")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <RunPicker
                runs={runs.map((run) => ({
                  runId: run.runId,
                  status: run.status,
                }))}
                value={selectedRunId}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <RunStatusBadge status={detail.run.status} />
                <RunModeBadge mode={detail.run.runMode} />
                <Badge variant="outline" className="font-mono text-[10px]">
                  {detail.run.workflowId}
                </Badge>
              </div>
              <p className="text-[11px] text-zinc-500">
                {t("startedAgo", {
                  time: timeAgo(detail.run.createdAt, locale),
                })}{" "}
                · {t("artifactsCount", { count: detail.artifacts.length })}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="size-4 text-emerald-400" />
                {t("brief")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-[11px] text-zinc-400">
              <div className="flex items-center justify-between">
                <span>{t("costSoFar")}</span>
                <span className="font-mono text-zinc-200">
                  {formatCny(brief.totals.costCny)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("tokens")}</span>
                <span className="font-mono text-zinc-200">
                  {brief.totals.tokens}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("gateAttempts")}</span>
                <span className="font-mono text-zinc-200">
                  {t("gatesSummary", {
                    total: detail.gates.length,
                    failed: failedGates.length,
                  })}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("stages")}</span>
                <span className="font-mono text-zinc-200">
                  {detail.stages.length}
                </span>
              </div>
            </CardContent>
          </Card>

          {detail.approval && detail.run.status === "paused" ? (
            <Card className="border-amber-500/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-amber-400" />
                  {t("waitingForYou")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="line-clamp-3 text-[11px] text-zinc-400">
                  {detail.approval.summary || t("approvalRequired")}
                </p>
                <Button asChild size="sm" variant="outline" className="w-full">
                  <Link
                    href={`/inbox/${encodeURIComponent(detail.approval.requestId)}`}
                  >
                    {t("openInbox")}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="size-4 text-zinc-500" />
                {t("citations")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {detail.artifacts.slice(-6).map((view) => (
                <Link
                  key={`${view.artifact.artifactId}:${view.artifact.version}`}
                  href={`/runs/${encodeURIComponent(selectedRunId)}?artifact=${encodeURIComponent(
                    `${view.artifact.artifactId}:${view.artifact.version}`,
                  )}`}
                  className="block truncate rounded px-1.5 py-1 font-mono text-[10px] text-zinc-500 hover:bg-accent hover:text-zinc-300"
                >
                  {view.artifact.artifactId}
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-0 overflow-hidden">
          <ManagerChat
            key={selectedRunId}
            runId={selectedRunId}
            initialMessages={messages}
            stubMode={stubMode}
          />
        </Card>
      </div>
    </div>
  );
}
