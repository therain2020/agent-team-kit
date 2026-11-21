"use client";

import {
  RunModeBadge,
  RunStatusBadge,
  StageStatusBadge,
} from "@/components/kit/status-badge";
import { PixelAgent, PixelWorkpiece, agentSeed } from "@/components/pixel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FactoryDetail, FactoryItem } from "@/lib/factory";
import { officeAgentHref } from "@/lib/office-deeplink";
import { cn, formatCny, formatNumber, timeAgo, timeUntil } from "@/lib/utils";
import {
  CheckCircle2,
  ExternalLink,
  Hand,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

type DrawerTab = "summary" | "diff" | "evidence" | "history";

/** Approval kinds the tower labels; unknown kinds fall back to gate failure. */
const KIND_KEYS: Record<string, string> = {
  stage_before: "kind_stage_before",
  stage_after: "kind_stage_after",
  gate_failure: "kind_gate_failure",
  budget_exceeded: "kind_budget_exceeded",
};

/**
 * The one approval detail drawer (82 §4.3, 89 §3.2). Opened from either view,
 * it carries kind, requester, run/stage context, draft diff, gate scores,
 * budget impact, the #140 evidence chain and the four decisions:
 * approve, reject, take over, or jump to the run.
 */
export function ApprovalDrawer({
  item,
  open,
  operator,
  onOpenChange,
  onApprove,
  onReject,
  onTakeOver,
  pending,
}: {
  item: FactoryItem | null;
  open: boolean;
  operator: string;
  onOpenChange: (open: boolean) => void;
  onApprove: (item: FactoryItem) => void;
  onReject: (item: FactoryItem) => void;
  onTakeOver: (item: FactoryItem, version: number) => void;
  pending: boolean;
}) {
  const t = useTranslations("factory");
  const inboxT = useTranslations("inbox");
  const approvalT = useTranslations("approval");
  const riskT = useTranslations("risk");
  const locale = useLocale();
  const [detail, setDetail] = useState<FactoryDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DrawerTab>("summary");
  const [reloadKey, setReloadKey] = useState(0);
  const runId = item?.runId;

  useEffect(() => {
    if (!open || !runId) {
      return;
    }
    const controller = new AbortController();
    setTab("summary");
    setDetail(null);
    setLoading(true);
    setError(null);
    fetch(`/api/factory/${encodeURIComponent(runId)}?attempt=${reloadKey}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? t("loadFailed"));
        }
        return (await response.json()) as FactoryDetail;
      })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setDetail(payload);
        }
      })
      .catch((problem: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setError(problem instanceof Error ? problem.message : t("loadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [open, runId, reloadKey, t]);

  const actionable = detail?.kind === "approval" && detail.status === "paused";
  const approval = detail?.approval ?? null;
  const ownedByMe = approval?.assignee === operator;
  const takenByOther = Boolean(approval?.assignee) && !ownedByMe;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-auto top-0 flex h-full max-h-none w-full max-w-md translate-x-0 translate-y-0 flex-col overflow-y-auto rounded-none border-l border-zinc-700 bg-[#0d1117] p-4 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest text-emerald-300">
            {item ? <PixelWorkpiece item={item} size={22} /> : null}
            {t("drawerTitle")}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-[10px] text-zinc-500">
            {runId ?? ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <p className="pt-2 text-[11px] text-zinc-600">{t("loading")}</p>
          </div>
        ) : null}

        {error ? (
          <div className="space-y-2">
            <p className="border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
              {error}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReloadKey((current) => current + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        ) : null}

        {detail ? (
          <>
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as DrawerTab)}
              className="min-h-0 flex-1"
            >
              <TabsList className="self-start">
                <TabsTrigger value="summary">{t("tabSummary")}</TabsTrigger>
                <TabsTrigger value="diff">{t("tabDiff")}</TabsTrigger>
                <TabsTrigger value="evidence">{t("tabEvidence")}</TabsTrigger>
                <TabsTrigger value="history">{t("tabHistory")}</TabsTrigger>
              </TabsList>

              <TabsContent value="summary" className="space-y-3 pt-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <RunStatusBadge status={detail.status} />
                  <RunModeBadge mode={detail.runMode} />
                  <Badge
                    variant={
                      detail.summary.riskClass === "high"
                        ? "danger"
                        : detail.summary.riskClass === "medium"
                          ? "warning"
                          : "success"
                    }
                    className="rounded-none text-[9px] uppercase"
                  >
                    {riskT(detail.summary.riskClass)}
                  </Badge>
                  {approval ? (
                    <Badge
                      variant="outline"
                      className="rounded-none text-[9px]"
                    >
                      {inboxT(KIND_KEYS[approval.kind] ?? "kind_gate_failure")}
                    </Badge>
                  ) : null}
                  {ownedByMe ? (
                    <Badge
                      variant="success"
                      className="rounded-none text-[9px]"
                    >
                      {inboxT("ownerYou")}
                    </Badge>
                  ) : takenByOther ? (
                    <Badge variant="info" className="rounded-none text-[9px]">
                      {inboxT("ownerOther", {
                        owner: approval?.assignee ?? "",
                      })}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs leading-5 text-zinc-300">
                  {detail.summary.title}
                </p>
                {item?.producerAgentId ? (
                  <div className="flex items-center gap-2 border border-zinc-800 bg-zinc-950 p-2">
                    <PixelAgent
                      seed={agentSeed(item.producerAgentId)}
                      state="idle"
                      scale={0.5}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-zinc-500">
                        {t("producer")}
                      </p>
                      <p className="truncate font-mono text-xs text-zinc-200">
                        {item.producerAgentId}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" asChild>
                      <Link href={officeAgentHref(item.producerAgentId)}>
                        {t("viewOffice")}
                      </Link>
                    </Button>
                  </div>
                ) : null}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-zinc-800 pt-3 text-[10px] text-zinc-500">
                  {detail.summary.stageName ? (
                    <Meta label={t("stage")} value={detail.summary.stageName} />
                  ) : null}
                  {detail.summary.requestedBy ? (
                    <Meta
                      label={t("requestedBy")}
                      value={detail.summary.requestedBy}
                    />
                  ) : null}
                  <Meta
                    label={t("cost")}
                    value={formatCny(detail.summary.costCny)}
                  />
                  <Meta
                    label={t("tokens")}
                    value={formatNumber(detail.summary.tokens)}
                  />
                  <Meta
                    label={t("artifactsLabel")}
                    value={String(detail.summary.artifactCount)}
                  />
                  <Meta
                    label={t("gatesLabel")}
                    value={String(detail.summary.gateCount)}
                  />
                  <Meta
                    label={inboxT("budgetImpact")}
                    value={
                      approval?.budget
                        ? approval.budget.limitCny !== null
                          ? inboxT("budgetSpentLimit", {
                              spent: formatCny(approval.budget.spentCny),
                              limit: formatCny(approval.budget.limitCny),
                            })
                          : inboxT("budgetSpentOnly", {
                              spent: formatCny(approval.budget.spentCny),
                            })
                        : inboxT("budgetUnknown")
                    }
                  />
                  {detail.summary.expiresAt ? (
                    <Meta
                      label={t("expires")}
                      value={timeUntil(detail.summary.expiresAt, locale)}
                    />
                  ) : null}
                  <Meta
                    label={t("updated")}
                    value={timeAgo(detail.updatedAt, locale)}
                  />
                </dl>
              </TabsContent>

              <TabsContent value="diff" className="space-y-2 pt-1">
                {!detail.diff.available ? (
                  <p className="text-[11px] text-zinc-500">
                    {detail.diff.reason === "no-draft"
                      ? t("diffNoDraft")
                      : t("diffUnavailable")}
                  </p>
                ) : detail.diff.parts.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">{t("diffEmpty")}</p>
                ) : (
                  <pre className="overflow-x-auto border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-4">
                    {detail.diff.parts.map((part, index) => (
                      <span
                        key={`${index}-${part.value.length}`}
                        className={cn(
                          "block whitespace-pre-wrap break-words",
                          part.added && "bg-emerald-500/10 text-emerald-200",
                          part.removed && "bg-red-500/10 text-red-200",
                        )}
                      >
                        {part.value}
                      </span>
                    ))}
                  </pre>
                )}
                {detail.diff.truncated ? (
                  <p className="text-[10px] text-amber-300/80">
                    {t("diffTruncated")}
                  </p>
                ) : null}
              </TabsContent>

              <TabsContent value="evidence" className="space-y-4 pt-1">
                <section>
                  <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    {t("gateEvidence")}
                  </h3>
                  {detail.evidence.gates.length === 0 ? (
                    <p className="text-[11px] text-zinc-600">{t("noGates")}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {detail.evidence.gates.map((gate) => (
                        <div
                          key={`${gate.stageId}:${gate.attempt}`}
                          className="border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-400"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-zinc-300">
                              {gate.stageId.split(":").slice(-1)[0]} ·{" "}
                              {t("attempt", { attempt: gate.attempt })}
                            </span>
                            <Badge
                              variant={gate.pass ? "success" : "danger"}
                              className="rounded-none text-[9px] uppercase"
                            >
                              {gate.pass ? t("passed") : t("failed")}
                            </Badge>
                          </div>
                          {Object.keys(gate.scores).length > 0 ? (
                            <p className="mt-1 font-mono text-zinc-500">
                              {Object.entries(gate.scores)
                                .map(([key, value]) => `${key}=${value}`)
                                .join(" · ")}
                            </p>
                          ) : null}
                          {gate.summary ? (
                            <p className="mt-1 text-zinc-400">{gate.summary}</p>
                          ) : null}
                          {gate.rationale ? (
                            <p className="mt-1 text-zinc-500">
                              {gate.rationale}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    {inboxT("whyTitle")}
                  </h3>
                  {detail.evidence.ancestry.length === 0 ? (
                    <p className="text-[11px] text-zinc-600">
                      {inboxT("whyNone")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.evidence.ancestry.map((ref) => (
                        <li
                          key={`${ref.artifactId}:${ref.version}:${ref.relation}`}
                          className="flex min-w-0 items-center gap-2 border border-zinc-800/70 px-2 py-1 font-mono text-[10px] text-zinc-500"
                        >
                          <span className="truncate text-zinc-300">
                            {ref.artifactId} v{ref.version}
                          </span>
                          <span className="truncate text-zinc-600">
                            {ref.stageId
                              ? ref.stageId.split(":").slice(-1)[0]
                              : ""}
                          </span>
                          <span className="ml-auto shrink-0 text-zinc-600">
                            {ref.relation}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    {t("stageEvidence")}
                  </h3>
                  {detail.evidence.stages.length === 0 ? (
                    <p className="text-[11px] text-zinc-600">{t("noStages")}</p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.evidence.stages.map((stage) => (
                        <li
                          key={stage.stageId}
                          className="flex items-center justify-between gap-2 border border-zinc-800/70 px-2 py-1 text-[10px] text-zinc-400"
                        >
                          <span className="truncate">{stage.name}</span>
                          <StageStatusBadge status={stage.status} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                    {t("artifactEvidence")}
                  </h3>
                  {detail.evidence.artifacts.length === 0 ? (
                    <p className="text-[11px] text-zinc-600">
                      {t("noArtifacts")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.evidence.artifacts.map((artifact) => (
                        <li
                          key={`${artifact.artifactId}:${artifact.version}`}
                          className="flex items-center justify-between gap-2 border border-zinc-800/70 px-2 py-1 font-mono text-[10px] text-zinc-500"
                        >
                          <span className="truncate text-zinc-300">
                            {artifact.stageId.split(":").slice(-1)[0]}
                          </span>
                          <span className="shrink-0">
                            {artifact.kind} · v{artifact.version} ·{" "}
                            {formatNumber(artifact.size)}B
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </TabsContent>

              <TabsContent value="history" className="space-y-2 pt-1">
                {detail.history.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">{t("noHistory")}</p>
                ) : (
                  detail.history.map((entry, index) => (
                    <div
                      key={entry.decisionId ?? `${entry.createdAt}-${index}`}
                      className="border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[10px] text-zinc-400"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge
                          variant={
                            entry.option === "approve"
                              ? "success"
                              : entry.option === "abort"
                                ? "danger"
                                : "outline"
                          }
                          className="rounded-none text-[9px] uppercase"
                        >
                          {entry.option}
                        </Badge>
                        <span className="text-zinc-600">
                          {timeAgo(entry.createdAt, locale)}
                        </span>
                      </div>
                      <p className="mt-1 text-zinc-400">
                        {entry.note || t("noNote")}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] text-zinc-600">
                        <span>
                          {t("by")} {entry.decidedBy}
                        </span>
                        {entry.batchId ? (
                          <span className="truncate">
                            {t("batchId")} {entry.batchId}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </TabsContent>
            </Tabs>

            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
              {actionable && item ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => onApprove(item)}
                    disabled={pending || takenByOther}
                  >
                    <CheckCircle2 className="size-3.5" />
                    {t("approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-500/30 text-red-300 hover:bg-red-500/10"
                    onClick={() => onReject(item)}
                    disabled={pending || takenByOther}
                  >
                    <XCircle className="size-3.5" />
                    {t("abort")}
                  </Button>
                </>
              ) : null}
              {actionable && approval && item && !ownedByMe ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onTakeOver(item, approval.version)}
                  disabled={pending}
                >
                  <Hand className="size-3.5" />
                  {approvalT("takeOver")}
                </Button>
              ) : null}
              {takenByOther ? (
                <span className="flex items-center gap-1 text-[10px] text-sky-300/80">
                  <ShieldAlert className="size-3" />
                  {inboxT("alreadyTaken")}
                </span>
              ) : null}
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/world?run=${encodeURIComponent(detail.runId)}`}>
                  <ExternalLink className="size-3.5" />
                  {t("run")}
                </Link>
              </Button>
              {detail.kind === "failed" ? (
                <span className="flex items-center gap-1 text-[10px] text-red-300/80">
                  <ShieldAlert className="size-3" />
                  {t("failedHint")}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt>{label}</dt>
      <dd className="truncate font-mono text-zinc-300">{value}</dd>
    </div>
  );
}
