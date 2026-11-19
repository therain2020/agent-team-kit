"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ApprovalTowerCard } from "@/lib/inbox-shared";
import { cn, formatCny, timeAgo, timeUntil, truncate } from "@/lib/utils";
import {
  Check,
  CircleAlert,
  Hand,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { forwardRef } from "react";

export const ApprovalCard = forwardRef<
  HTMLDivElement,
  {
    card: ApprovalTowerCard;
    active: boolean;
    selected: boolean;
    operator: string;
    now: number;
    pending: boolean;
    onActivate: () => void;
    onToggle: () => void;
    onApprove: () => void;
    onReject: () => void;
    onTakeOver: () => void;
  }
>(function ApprovalCard(
  {
    card,
    active,
    selected,
    operator,
    now,
    pending,
    onActivate,
    onToggle,
    onApprove,
    onReject,
    onTakeOver,
  },
  ref,
) {
  const t = useTranslations("inbox");
  const riskT = useTranslations("risk");
  const locale = useLocale();
  const ownedByMe = card.assignee === operator;
  const ownedByOther = card.assignee !== null && !ownedByMe;
  const kindLabel = t(`kind_${card.kind}`);
  const gate = card.gate;
  const topScore = gate?.scores[0];

  return (
    <div
      ref={ref}
      aria-current={active ? "true" : undefined}
      tabIndex={-1}
      data-active={active ? "true" : "false"}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        "group min-w-0 cursor-pointer rounded-lg border border-border bg-card px-3 py-2.5 outline-none transition-colors focus:outline-none",
        "motion-reduce:transition-none",
        active
          ? "border-emerald-500/60 ring-2 ring-emerald-500/50"
          : "hover:border-zinc-600",
        selected ? "bg-emerald-500/5" : "",
        ownedByMe ? "border-emerald-500/30" : "",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant={
            card.kind === "budget_exceeded" || card.riskClass === "high"
              ? "danger"
              : card.riskClass === "low"
                ? "success"
                : "warning"
          }
          className="text-[10px]"
        >
          {kindLabel}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {t("risk", { level: riskT(card.riskClass) })}
        </Badge>
        {ownedByMe ? (
          <Badge variant="success" className="text-[10px]">
            {t("ownerYou")}
          </Badge>
        ) : ownedByOther ? (
          <Badge variant="info" className="text-[10px]">
            {t("ownerOther", { owner: card.assignee ?? "" })}
          </Badge>
        ) : null}
        <span className="ml-auto font-mono text-[10px] text-zinc-500">
          {card.dueAt
            ? new Date(card.dueAt).getTime() < now
              ? t("dueOverdue", {
                  time: timeAgo(card.dueAt, locale, now),
                })
              : t("dueIn", {
                  time: timeUntil(card.dueAt, locale, now),
                })
            : t("medianWaitEmpty")}
        </span>
        <button
          type="button"
          aria-label={t("select", { requestId: card.requestId })}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className={cn(
            "ml-1 flex size-4 items-center justify-center rounded border text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            selected
              ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
              : "border-zinc-600 text-transparent hover:border-zinc-400",
          )}
        >
          <Check className="size-3" aria-hidden />
        </button>
      </div>

      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-500">
        <span className="truncate font-mono text-zinc-300">{card.runId}</span>
        <span aria-hidden>·</span>
        <span className="truncate">
          {card.stageName || card.stageId.split(":").slice(-1)[0]}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-zinc-300">
        {card.summary || t("waitingApproval")}
      </p>

      {card.draftSnippet ? (
        <div className="mt-2 rounded border border-border/70 bg-zinc-950/40 px-2 py-1.5">
          <p className="text-[9px] uppercase tracking-wider text-zinc-600">
            {t("draftPreview")}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-zinc-500">
            {truncate(card.draftSnippet, 180)}
          </p>
        </div>
      ) : null}

      <div className="mt-2 space-y-1 text-[10px] text-zinc-500">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate">
            <ShieldCheck
              className="size-3 shrink-0 text-zinc-600"
              aria-hidden
            />
            {gate ? (
              <span
                className={cn(
                  "font-mono",
                  gate.pass === false
                    ? "text-red-300"
                    : gate.pass === true
                      ? "text-emerald-300"
                      : "text-zinc-300",
                )}
                title={
                  topScore
                    ? `${topScore.dimension} ${formatScore(topScore.value)} / ${
                        topScore.threshold === null
                          ? "—"
                          : formatScore(topScore.threshold)
                      }`
                    : undefined
                }
              >
                {gate.pass === true
                  ? t("gatePass")
                  : gate.pass === false
                    ? t("gateFail")
                    : "—"}
                {topScore
                  ? ` · ${formatScore(topScore.value)}${
                      topScore.threshold !== null
                        ? `/${formatScore(topScore.threshold)}`
                        : ""
                    }`
                  : ""}
              </span>
            ) : (
              <span className="text-zinc-600">{t("gateNone")}</span>
            )}
          </span>
          <Link
            href={`/inbox/${encodeURIComponent(card.requestId)}`}
            onClick={(event) => event.stopPropagation()}
            className="ml-auto shrink-0 text-emerald-400 outline-none hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            {t("whyOpen")}
          </Link>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex min-w-0 items-center gap-1 truncate"
            title={t("requester")}
          >
            <UserRound className="size-3 shrink-0 text-zinc-600" aria-hidden />
            <span className="truncate text-zinc-300">{card.requester}</span>
          </span>
          <span
            className="ml-auto min-w-0 truncate text-right"
            title={
              card.budget
                ? `${formatCny(card.budget.spentCny)}${
                    card.budget.limitCny !== null
                      ? ` / ${formatCny(card.budget.limitCny)}`
                      : ""
                  }`
                : undefined
            }
          >
            {t("budgetImpact")}{" "}
            {card.budget ? (
              <span className="font-mono text-zinc-300">
                {card.budget.limitCny !== null
                  ? t("budgetSpentLimit", {
                      spent: formatCny(card.budget.spentCny),
                      limit: formatCny(card.budget.limitCny),
                    })
                  : t("budgetSpentOnly", {
                      spent: formatCny(card.budget.spentCny),
                    })}
              </span>
            ) : (
              <span className="text-zinc-600">{t("budgetUnknown")}</span>
            )}
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={pending || ownedByOther}
          onClick={(event) => {
            event.stopPropagation();
            onApprove();
          }}
        >
          <Check className="size-3" />
          {t("approve")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 border-red-500/30 px-2 text-[11px] text-red-300 hover:bg-red-500/10"
          disabled={pending || ownedByOther}
          onClick={(event) => {
            event.stopPropagation();
            onReject();
          }}
        >
          <X className="size-3" />
          {t("reject")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-[11px]"
          disabled={pending || ownedByMe}
          onClick={(event) => {
            event.stopPropagation();
            onTakeOver();
          }}
        >
          <Hand className="size-3" />
          {ownedByMe ? t("ownerYou") : t("takeOver")}
        </Button>
      </div>

      {ownedByOther ? (
        <p className="mt-1.5 flex items-center gap-1 text-[10px] text-sky-300/80">
          <CircleAlert className="size-3" />
          {t("alreadyTaken")}
        </p>
      ) : null}
    </div>
  );
});

function formatScore(value: number): string {
  return value.toFixed(2);
}
