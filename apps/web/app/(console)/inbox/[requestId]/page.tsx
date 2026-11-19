import { ApprovalActions } from "@/components/inbox/approval-actions";
import { TakeoverButton } from "@/components/inbox/takeover-button";
import { WhyCard } from "@/components/inbox/why-card";
import { EmptyState } from "@/components/kit/empty-state";
import { GateCard } from "@/components/kit/gate-card";
import { Markdown } from "@/components/kit/markdown";
import { PageHeader } from "@/components/kit/page-header";
import { RunModeBadge, RunStatusBadge } from "@/components/kit/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadApprovalDetail } from "@/lib/approvals";
import { loadApprovalWhy } from "@/lib/inbox";
import { currentOperatorId } from "@/lib/operator";
import { loadArtifactContent } from "@/lib/runs";
import { formatCny, timeAgo, timeUntil } from "@/lib/utils";
import {
  ArrowLeft,
  Clock3,
  FileWarning,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ApprovalPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const t = await getTranslations("approval");
  const actionT = await getTranslations("approvalActions");
  const riskT = await getTranslations("risk");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const { requestId: rawRequestId } = await params;
  const requestId = decodeURIComponent(rawRequestId);
  const approval = await loadApprovalDetail(requestId);

  if (!approval) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("title")} description={requestId} />
        <EmptyState
          icon={FileWarning}
          title={t("notFoundTitle")}
          description={t("notFoundDesc")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/inbox">{t("backToInbox")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const { run, detail, draft, draftContent, draftUnavailable } = approval;
  const [why, operator] = await Promise.all([
    loadApprovalWhy(requestId).catch(() => null),
    Promise.resolve(currentOperatorId()),
  ]);
  const ownedByMe = approval.assignee === operator;
  const takenByOther = approval.assignee !== null && !ownedByMe;
  const decisions = await Promise.all(
    detail.decisions.map(async (view) => {
      const content = await loadArtifactContent(view.artifact);
      try {
        return {
          artifactId: view.artifact.artifactId,
          ...(JSON.parse(content.text) as {
            option?: unknown;
            note?: unknown;
            decidedBy?: unknown;
            createdAt?: unknown;
          }),
        };
      } catch {
        return { artifactId: view.artifact.artifactId };
      }
    }),
  );

  return (
    <div className="space-y-5">
      <Link
        href="/inbox"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-zinc-200"
      >
        <ArrowLeft className="size-3.5" />
        {t("back")}
      </Link>

      <PageHeader
        title={t("title")}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <RunModeBadge mode={run.runMode} />
            <span className="font-mono text-xs">{requestId}</span>
            <span className="text-zinc-600">·</span>
            <span className="font-mono text-xs">{run.runId}</span>
          </span>
        }
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/office?panel=manager">
              <MessageSquare className="size-3.5" />
              {t("askManager")}
            </Link>
          </Button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileWarning className="size-4 text-amber-400" />
                {t("proposedDraft")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {draftUnavailable ? (
                <p className="text-xs text-amber-400">
                  {t("draftUnavailable")}
                </p>
              ) : draftContent ? (
                <Markdown>{draftContent}</Markdown>
              ) : (
                <p className="text-xs text-muted-foreground">{t("noDraft")}</p>
              )}
            </CardContent>
          </Card>

          {detail.gates.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("gateEvidence")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {detail.gates.map((gate) => (
                  <GateCard
                    key={`${gate.stageId}:${gate.attempt}`}
                    gate={gate}
                  />
                ))}
              </CardContent>
            </Card>
          ) : null}

          <WhyCard why={why} />
        </div>

        <div className="space-y-4">
          <Card className="border-amber-500/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="size-4 text-amber-400" />
                {t("decision")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">
                  {t("risk", {
                    level: riskT(approval.approval.riskClass ?? "medium"),
                  })}
                </Badge>
                <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <Clock3 className="size-3" />
                  {approval.approval.expiresAt
                    ? t("expiresIn", {
                        time: timeUntil(approval.approval.expiresAt, locale),
                      })
                    : t("noExpiry")}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded border border-border/70 px-2 py-1.5">
                <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                  {t("owner")}
                </span>
                <span className="truncate text-[11px] text-zinc-300">
                  {ownedByMe
                    ? t("ownerYou")
                    : (approval.assignee ?? t("ownerNone"))}
                </span>
                {!ownedByMe ? (
                  <span className="ml-auto">
                    <TakeoverButton
                      requestId={approval.approval.requestId}
                      version={approval.approvalVersion}
                      takenByOther={takenByOther}
                    />
                  </span>
                ) : null}
              </div>
              <p className="text-xs leading-5 text-zinc-400">
                {approval.approval.summary || t("summaryFallback")}
              </p>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
                <span>
                  {t("stage")}{" "}
                  <span className="font-mono text-zinc-300">
                    {approval.approval.stageId.split(":").slice(-1)[0]}
                  </span>
                </span>
                <span>
                  {t("requestedBy")}{" "}
                  <span className="text-zinc-300">
                    {approval.approval.requestedBy}
                  </span>
                </span>
                <span>
                  {t("draft")}{" "}
                  <span className="font-mono text-zinc-300">
                    {approval.approval.draftArtifactId ?? common("none")}
                  </span>
                </span>
                <span>
                  {t("gateRefs")}{" "}
                  <span className="text-zinc-300">
                    {approval.approval.gateRefs.length}
                  </span>
                </span>
              </div>

              <ApprovalActions
                runId={run.runId}
                requestId={approval.approval.requestId}
                expiresAt={approval.approval.expiresAt}
                actionable={approval.actionable}
                expired={approval.expired}
                status={run.status}
              />

              <p className="text-[10px] leading-4 text-zinc-600">
                {actionT("dialogApproveDesc")} {actionT("dialogAbortDesc")}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("runCost")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-[11px] text-zinc-400">
              <div className="flex justify-between">
                <span>{t("totalSoFar")}</span>
                <span className="font-mono text-zinc-200">
                  {formatCny(detail.costCny)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t("artifacts")}</span>
                <span className="font-mono text-zinc-200">
                  {detail.artifacts.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t("gateAttempts")}</span>
                <span className="font-mono text-zinc-200">
                  {detail.gates.length}
                </span>
              </div>
            </CardContent>
          </Card>

          {decisions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("decisionHistory")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {decisions.map((decision) => (
                  <div
                    key={decision.artifactId}
                    className="rounded border border-border px-2 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-zinc-300">
                        {typeof decision.option === "string"
                          ? decision.option === "approve"
                            ? actionT("optionApprove")
                            : decision.option === "abort"
                              ? actionT("optionAbort")
                              : decision.option
                          : t("recorded")}
                      </span>
                      <span className="text-[10px] text-zinc-600">
                        {typeof decision.createdAt === "string"
                          ? timeAgo(decision.createdAt, locale)
                          : ""}
                      </span>
                    </div>
                    {typeof decision.note === "string" && decision.note ? (
                      <p className="mt-0.5 text-zinc-500">{decision.note}</p>
                    ) : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t("inspect")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <Link
                href={`/runs/${encodeURIComponent(run.runId)}`}
                className="block text-[11px] text-emerald-400 hover:text-emerald-300"
              >
                {t("openRunTimeline")}
              </Link>
              {draft ? (
                <Link
                  href={`/runs/${encodeURIComponent(run.runId)}?artifact=${encodeURIComponent(
                    `${draft.artifact.artifactId}:${draft.artifact.version}`,
                  )}`}
                  className="block text-[11px] text-emerald-400 hover:text-emerald-300"
                >
                  {t("openDraftArtifact")}
                </Link>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
