import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadInboxData } from "@/lib/approvals";
import { formatCny, timeAgo } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Inbox as InboxIcon,
  ShieldAlert,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const t = await getTranslations("inbox");
  const statusT = await getTranslations("status");
  const riskT = await getTranslations("risk");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const { paused, failed } = await loadInboxData();

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-amber-400" />
          <h2 className="text-sm font-semibold text-zinc-200">
            {t("awaitingYou")}
          </h2>
          <Badge variant={paused.length > 0 ? "warning" : "outline"}>
            {paused.length}
          </Badge>
        </div>

        {paused.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={t("noApprovalsTitle")}
            description={t("noApprovalsDesc")}
            className="py-8"
          />
        ) : (
          <div className="grid gap-2">
            {paused.map((item) => (
              <Link
                key={item.run.runId}
                href={
                  item.approval
                    ? `/inbox/${encodeURIComponent(item.approval.requestId)}`
                    : `/runs/${encodeURIComponent(item.run.runId)}`
                }
                className="group rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 transition-colors hover:border-amber-500/40 hover:bg-amber-500/10"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-zinc-200">
                    {item.run.runId}
                  </span>
                  <Badge variant="warning">{statusT("paused")}</Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {t("risk", {
                      level: riskT(item.approval?.riskClass ?? "medium"),
                    })}
                  </Badge>
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500">
                    <Clock3 className="size-3" />
                    {t("pausedAgo", {
                      time: timeAgo(item.run.updatedAt, locale),
                    })}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs text-zinc-400">
                  {item.approval?.summary || t("waitingApproval")}
                </p>
                <div className="mt-2 flex items-center gap-3 text-[10px] text-zinc-500">
                  <span>{t("cost", { cost: formatCny(item.costCny) })}</span>
                  <span>
                    {t("request", {
                      requestId: item.approval?.requestId ?? common("unknown"),
                    })}
                  </span>
                  <span className="ml-auto text-amber-300/80 group-hover:text-amber-300">
                    {t("review")}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-red-400" />
          <h2 className="text-sm font-semibold text-zinc-200">
            {t("failedRuns")}
          </h2>
          <Badge variant={failed.length > 0 ? "danger" : "outline"}>
            {failed.length}
          </Badge>
        </div>

        {failed.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-xs text-muted-foreground">
              {t("noFailed")}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-2">
            {failed.map((item) => (
              <Link
                key={item.run.runId}
                href={`/runs/${encodeURIComponent(item.run.runId)}`}
                className="rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-zinc-200">
                    {item.run.runId}
                  </span>
                  <Badge variant="danger">{statusT("failed")}</Badge>
                  <span className="ml-auto text-[10px] text-zinc-500">
                    {t("artifactsCost", {
                      count: item.artifactCount,
                      cost: formatCny(item.costCny),
                    })}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs text-zinc-500">
                  {item.reason}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <InboxIcon className="size-4 text-zinc-500" />
              {t("fyi")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {t("fyiBody")}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
