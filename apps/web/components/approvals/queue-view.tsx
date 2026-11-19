"use client";

import { ApprovalCard } from "@/components/approvals/approval-card";
import { EmptyState } from "@/components/kit/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ApprovalTowerCard,
  TowerBucket,
  TowerBucketId,
} from "@/lib/inbox-shared";
import { cn } from "@/lib/utils";
import { Inbox as InboxIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";

/**
 * Queue view of the approvals surface: the SLA tower from #146, with state
 * lifted to `ApprovalsSurface` so the factory view can highlight the same
 * request and single-key decisions work identically in both.
 */
export function QueueView({
  groups,
  operator,
  activeId,
  selected,
  pending,
  now,
  onActivate,
  onToggle,
  onApprove,
  onReject,
  onTakeOver,
  registerCard,
}: {
  groups: TowerBucket[];
  operator: string;
  activeId: string | null;
  selected: ReadonlySet<string>;
  pending: boolean;
  now: number;
  onActivate: (requestId: string) => void;
  onToggle: (requestId: string) => void;
  onApprove: (card: ApprovalTowerCard) => void;
  onReject: (card: ApprovalTowerCard) => void;
  onTakeOver: (card: ApprovalTowerCard) => void;
  registerCard: (requestId: string, element: HTMLDivElement | null) => void;
}) {
  const total = groups.reduce((count, group) => count + group.cards.length, 0);

  if (total === 0) {
    return <QueueEmpty />;
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {groups.map((group) => (
        <TowerColumn
          key={group.id}
          group={group}
          operator={operator}
          activeId={activeId}
          selected={selected}
          pending={pending}
          now={now}
          onActivate={onActivate}
          onToggle={onToggle}
          onApprove={onApprove}
          onReject={onReject}
          onTakeOver={onTakeOver}
          registerCard={registerCard}
        />
      ))}
    </div>
  );
}

export function QueueEmpty() {
  const t = useTranslations("inbox");
  return (
    <EmptyState
      icon={InboxIcon}
      title={t("emptyTitle")}
      description={t("emptyDesc")}
      className="py-12"
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href="/runs">{t("openRun")}</Link>
          </Button>
        </div>
      }
    />
  );
}

const BUCKET_STYLES: Record<
  TowerBucketId,
  { accent: string; badge: "danger" | "warning" | "info" | "outline" }
> = {
  overdue: { accent: "text-red-300", badge: "danger" },
  soon: { accent: "text-amber-300", badge: "warning" },
  today: { accent: "text-sky-300", badge: "info" },
  later: { accent: "text-zinc-400", badge: "outline" },
};

function TowerColumn({
  group,
  operator,
  activeId,
  selected,
  pending,
  now,
  onActivate,
  onToggle,
  onApprove,
  onReject,
  onTakeOver,
  registerCard,
}: {
  group: TowerBucket;
  operator: string;
  activeId: string | null;
  selected: ReadonlySet<string>;
  pending: boolean;
  now: number;
  onActivate: (requestId: string) => void;
  onToggle: (requestId: string) => void;
  onApprove: (card: ApprovalTowerCard) => void;
  onReject: (card: ApprovalTowerCard) => void;
  onTakeOver: (card: ApprovalTowerCard) => void;
  registerCard: (requestId: string, element: HTMLDivElement | null) => void;
}) {
  const t = useTranslations("inbox");
  const locale = useLocale();
  const style = BUCKET_STYLES[group.id];
  const title =
    group.id === "overdue"
      ? t("columnOverdue")
      : group.id === "soon"
        ? t("columnSoon")
        : group.id === "today"
          ? t("columnToday")
          : t("columnLater");

  return (
    <section className="min-w-0 rounded-lg border border-border/70 bg-zinc-950/30 p-2">
      <header className="px-1 pb-2">
        <div className="flex items-center gap-2">
          <h2
            className={cn(
              "whitespace-nowrap text-xs font-semibold",
              style.accent,
            )}
          >
            {title}
          </h2>
          <Badge
            variant={style.badge}
            className="ml-auto whitespace-nowrap text-[10px]"
          >
            {t("depth", { count: group.depth })}
          </Badge>
        </div>
        <p className="mt-0.5 text-[10px] text-zinc-500">
          {group.medianWaitMs === null
            ? t("medianWaitEmpty")
            : t("medianWait", {
                time: formatWait(group.medianWaitMs, locale),
              })}
        </p>
      </header>
      {group.cards.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-800 px-3 py-6 text-center text-[10px] text-zinc-600">
          {t("columnEmpty")}
        </div>
      ) : (
        <div className="max-h-[calc(100vh-22rem)] space-y-2 overflow-y-auto pr-0.5">
          {group.cards.map((card) => (
            <ApprovalCard
              key={card.requestId}
              ref={(element) => registerCard(card.requestId, element)}
              card={card}
              active={card.requestId === activeId}
              selected={selected.has(card.requestId)}
              operator={operator}
              now={now}
              pending={pending}
              onActivate={() => onActivate(card.requestId)}
              onToggle={() => onToggle(card.requestId)}
              onApprove={() => onApprove(card)}
              onReject={() => onReject(card)}
              onTakeOver={() => onTakeOver(card)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function formatWait(ms: number, locale: string): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) {
    return locale === "zh" ? "<1 分钟" : "<1m";
  }
  if (minutes < 60) {
    return locale === "zh" ? `${minutes} 分钟` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return locale === "zh"
      ? `${hours} 小时 ${minutes % 60} 分`
      : `${hours}h ${minutes % 60}m`;
  }
  const days = Math.floor(hours / 24);
  return locale === "zh"
    ? `${days} 天 ${hours % 24} 小时`
    : `${days}d ${hours % 24}h`;
}
