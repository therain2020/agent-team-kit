"use client";

import { ApprovalCard } from "@/components/inbox/approval-card";
import { EmptyState } from "@/components/kit/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  type ApprovalTowerCard,
  type ApprovalTowerSnapshot,
  type TowerBucket,
  type TowerBucketId,
  groupApprovals,
} from "@/lib/inbox-shared";
import { useApprovalQueue } from "@/lib/use-approval-queue";
import { cn, timeAgo } from "@/lib/utils";
import { Inbox as InboxIcon, RefreshCw, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type Decision = "approve" | "reject";

type DialogState =
  | { kind: "single"; decision: Decision; card: ApprovalTowerCard }
  | { kind: "batch"; decision: Decision };

type BatchResponse = {
  error?: string;
  batchId?: string;
  succeeded?: number;
  approved?: number;
  rejected?: number;
  failed?: number;
  results?: BatchResult[];
};

type BatchResult = {
  requestId: string;
  runId: string;
  decision?: string;
  ok: boolean;
  status?: number;
  error?: string;
};

const BUCKET_STYLES: Record<
  TowerBucketId,
  { accent: string; badge: "danger" | "warning" | "info" | "outline" }
> = {
  overdue: { accent: "text-red-300", badge: "danger" },
  soon: { accent: "text-amber-300", badge: "warning" },
  today: { accent: "text-sky-300", badge: "info" },
  later: { accent: "text-zinc-400", badge: "outline" },
};

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

export function InboxTower({
  initial,
  operator,
}: {
  initial: ApprovalTowerSnapshot;
  operator: string;
}) {
  const t = useTranslations("inbox");
  const actionT = useTranslations("approvalActions");
  const locale = useLocale();
  const router = useRouter();
  const { snapshot, refreshing, error, now, refresh } =
    useApprovalQueue(initial);

  const [activeId, setActiveId] = useState<string | null>(
    initial.approvals[0]?.requestId ?? null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [batchResults, setBatchResults] = useState<BatchResult[] | null>(null);
  const [announce, setAnnounce] = useState("");
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const shouldFocus = useRef(false);

  const groups = useMemo(
    () => groupApprovals(snapshot.approvals, now),
    [snapshot.approvals, now],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.cards), [groups]);
  const activeCard = flat.find((card) => card.requestId === activeId) ?? null;
  const selectedCards = flat.filter((card) => selected.has(card.requestId));

  useEffect(() => {
    if (activeId && flat.some((card) => card.requestId === activeId)) {
      return;
    }
    setActiveId(flat[0]?.requestId ?? null);
  }, [activeId, flat]);

  useEffect(() => {
    if (!activeId || !shouldFocus.current) {
      return;
    }
    shouldFocus.current = false;
    cardRefs.current.get(activeId)?.focus();
  }, [activeId]);

  useEffect(() => {
    if (error) {
      setAnnounce(t("refreshFailed", { message: error }));
    }
  }, [error, t]);

  const move = useCallback(
    (delta: number) => {
      if (flat.length === 0) {
        return;
      }
      const index = activeId
        ? flat.findIndex((card) => card.requestId === activeId)
        : -1;
      const next = Math.max(0, Math.min(flat.length - 1, index + delta));
      const target = flat[next];
      if (target) {
        shouldFocus.current = true;
        setActiveId(target.requestId);
      }
    },
    [activeId, flat],
  );

  const toggleSelect = useCallback((requestId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(requestId)) {
        next.delete(requestId);
      } else {
        next.add(requestId);
      }
      return next;
    });
  }, []);

  const submitSingle = useCallback(
    async (card: ApprovalTowerCard, decision: Decision, text: string) => {
      setPending(true);
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(card.runId)}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              decision: decision === "approve" ? "approve" : "abort",
              note: text,
              requestId: card.requestId,
            }),
          },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? t("actionFailed"));
        }
        const message =
          decision === "approve" ? t("approvedToast") : t("rejectedToast");
        toast.success(message);
        setAnnounce(message);
        setDialog(null);
        setNote("");
        void refresh();
        return true;
      } catch (problem) {
        const message =
          problem instanceof Error ? problem.message : t("actionFailed");
        if (dialog) {
          setDialogError(message);
        } else {
          toast.error(message);
        }
        setAnnounce(message);
        return false;
      } finally {
        setPending(false);
      }
    },
    [dialog, refresh, t],
  );

  const requestDecision = useCallback(
    (card: ApprovalTowerCard, decision: Decision) => {
      setDialogError(null);
      if (card.assignee && card.assignee !== operator) {
        toast.error(t("alreadyTaken"));
        return;
      }
      if (decision === "approve" && card.riskClass === "low") {
        void submitSingle(card, "approve", "");
        return;
      }
      setNote("");
      setDialog({ kind: "single", decision, card });
    },
    [operator, submitSingle, t],
  );

  const takeOver = useCallback(
    async (card: ApprovalTowerCard) => {
      setPending(true);
      try {
        const response = await fetch(
          `/api/approvals/${encodeURIComponent(card.requestId)}/assign`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: card.version }),
          },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? t("actionFailed"));
        }
        toast.success(t("takeOverToast"));
        setAnnounce(t("takeOverToast"));
        void refresh();
      } catch (problem) {
        const message =
          problem instanceof Error ? problem.message : t("actionFailed");
        toast.error(t("takeOverFailed", { message }));
      } finally {
        setPending(false);
      }
    },
    [refresh, t],
  );

  const submitBatch = useCallback(
    async (decision: Decision, text: string) => {
      if (selectedCards.length === 0) {
        return;
      }
      setPending(true);
      setDialogError(null);
      try {
        const response = await fetch("/api/approvals/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision,
            note: text,
            items: selectedCards.map((card) => ({
              runId: card.runId,
              requestId: card.requestId,
              version: card.version,
            })),
          }),
        });
        const payload = (await response.json()) as BatchResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? t("actionFailed"));
        }
        const results = payload.results ?? [];
        setBatchResults(results);
        const failedIds = new Set(
          results
            .filter((result) => !result.ok)
            .map((result) => result.requestId),
        );
        setSelected(failedIds);
        const succeeded = payload.succeeded ?? results.length - failedIds.size;
        const failed = payload.failed ?? failedIds.size;
        const message =
          failed > 0
            ? t("batchToast", { succeeded, failed })
            : t("batchAllOk", { count: succeeded });
        if (failed > 0) {
          toast.error(message);
        } else {
          toast.success(message);
        }
        setAnnounce(message);
        setDialog(null);
        setNote("");
        void refresh();
      } catch (problem) {
        const message =
          problem instanceof Error ? problem.message : t("actionFailed");
        setDialogError(message);
        setAnnounce(t("batchFailed", { message }));
      } finally {
        setPending(false);
      }
    },
    [refresh, selectedCards, t],
  );

  const openBatch = useCallback(
    (decision: Decision) => {
      if (selectedCards.length === 0) {
        return;
      }
      setDialogError(null);
      setNote("");
      setDialog({ kind: "batch", decision });
    },
    [selectedCards.length],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (dialog || isTypingTarget(event.target)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
        return;
      }
      if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
        return;
      }
      if (key === "enter" && activeCard) {
        event.preventDefault();
        router.push(`/inbox/${encodeURIComponent(activeCard.requestId)}`);
        return;
      }
      if (key === "a" && activeCard) {
        event.preventDefault();
        requestDecision(activeCard, "approve");
        return;
      }
      if (key === "r" && activeCard) {
        event.preventDefault();
        requestDecision(activeCard, "reject");
        return;
      }
      if (key === "s" && activeCard) {
        event.preventDefault();
        toggleSelect(activeCard.requestId);
        return;
      }
      if (event.key === "Escape") {
        if (selected.size > 0) {
          event.preventDefault();
          setSelected(new Set());
          return;
        }
        setBatchResults(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeCard,
    dialog,
    move,
    requestDecision,
    router,
    selected.size,
    toggleSelect,
  ]);

  const submitDialog = () => {
    if (!dialog) {
      return;
    }
    const decision = dialog.decision;
    if (decision === "reject" && note.trim().length === 0) {
      setDialogError(
        dialog.kind === "batch"
          ? t("batchNoteRequired")
          : actionT("noteRequired"),
      );
      return;
    }
    if (dialog.kind === "single") {
      void submitSingle(dialog.card, decision, note);
    } else {
      void submitBatch(decision, note);
    }
  };

  const total = snapshot.approvals.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
        <Badge variant="outline" className="font-mono">
          {t("awaitingYou")} · {total}
        </Badge>
        <span className="hidden sm:inline">{t("shortcutHint")}</span>
        <span className="ml-auto flex items-center gap-2">
          <span>
            {t("liveUpdated", {
              time: timeAgo(snapshot.generatedAt, locale, now),
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw
              className={cn(
                "size-3",
                refreshing ? "animate-spin motion-reduce:animate-none" : "",
              )}
            />
            {t("refreshNow")}
          </Button>
        </span>
      </div>

      {snapshot.truncated ? (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          {t("truncated", { limit: total })}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300"
        >
          {t("refreshFailed", { message: error })}
        </p>
      ) : null}

      {selected.size > 0 ? (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-zinc-950/95 px-3 py-2 backdrop-blur">
          <span className="text-xs font-medium text-emerald-300">
            {t("selectedCount", { count: selected.size })}
          </span>
          <Button
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={pending}
            onClick={() => openBatch("approve")}
          >
            {t("batchApprove")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-red-500/30 px-2 text-[11px] text-red-300 hover:bg-red-500/10"
            disabled={pending}
            onClick={() => openBatch("reject")}
          >
            {t("batchReject")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-2 text-[11px]"
            disabled={pending}
            onClick={() => setSelected(new Set())}
          >
            <X className="size-3" />
            {t("clearSelection")}
          </Button>
        </div>
      ) : null}

      {batchResults ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-zinc-200">
              {t("batchResultTitle")}
            </p>
            <button
              type="button"
              onClick={() => setBatchResults(null)}
              className="rounded p-1 text-zinc-500 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
              aria-label={t("clearSelection")}
            >
              <X className="size-3.5" />
            </button>
          </div>
          {batchResults.length === 0 ? (
            <p className="mt-1 text-[11px] text-zinc-500">
              {t("batchResultEmpty")}
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-border/60">
              {batchResults.map((result) => (
                <li
                  key={`${result.runId}:${result.requestId}`}
                  className="flex min-w-0 items-start gap-2 py-1 text-[11px]"
                >
                  <Badge
                    variant={result.ok ? "success" : "danger"}
                    className="shrink-0 text-[9px]"
                  >
                    {result.ok ? t("batchResultOk") : t("batchResultFailed")}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-zinc-300">
                      {result.requestId}
                    </span>
                    {!result.ok && result.error ? (
                      <span className="block text-red-300">
                        {result.error}
                        {result.status ? ` (${result.status})` : ""}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {total === 0 ? (
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
              <Button size="sm" variant="ghost" asChild>
                <Link href="/factory">/factory</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {groups.map((group) => (
            <TowerColumn
              key={group.id}
              group={group}
              operator={operator}
              activeId={activeId}
              selected={selected}
              pending={pending}
              locale={locale}
              now={now}
              onActivate={setActiveId}
              onToggle={toggleSelect}
              onApprove={(card) => requestDecision(card, "approve")}
              onReject={(card) => requestDecision(card, "reject")}
              onTakeOver={(card) => void takeOver(card)}
              registerCard={(requestId, element) => {
                if (element) {
                  cardRefs.current.set(requestId, element);
                } else {
                  cardRefs.current.delete(requestId);
                }
              }}
            />
          ))}
        </div>
      )}

      <output className="sr-only" aria-live="polite">
        {announce}
      </output>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setDialog(null);
            setDialogError(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          {dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.kind === "batch"
                    ? dialog.decision === "approve"
                      ? t("batchApproveTitle", { count: selected.size })
                      : t("batchRejectTitle", { count: selected.size })
                    : dialog.decision === "approve"
                      ? actionT("dialogApproveTitle")
                      : actionT("dialogAbortTitle")}
                </DialogTitle>
                <DialogDescription>
                  {dialog.kind === "batch"
                    ? dialog.decision === "approve"
                      ? t("batchApproveDesc")
                      : t("batchRejectDesc")
                    : dialog.decision === "approve"
                      ? actionT("dialogApproveDesc")
                      : actionT("dialogAbortDesc")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <label
                  htmlFor="inbox-decision-note"
                  className="text-xs font-medium text-zinc-300"
                >
                  {dialog.decision === "reject"
                    ? t("batchNoteRequired")
                    : actionT("noteOptional")}
                </label>
                <Textarea
                  id="inbox-decision-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={2000}
                  placeholder={
                    dialog.decision === "approve"
                      ? actionT("notePlaceholderApprove")
                      : actionT("notePlaceholderAbort")
                  }
                />
                {dialog.kind === "batch" ? (
                  <p className="text-[10px] text-zinc-600">
                    {t("batchNote")} · {t("shortcutHint")}
                  </p>
                ) : (
                  <p className="text-[10px] text-zinc-600">
                    {actionT("auditNote")}
                  </p>
                )}
                {dialogError ? (
                  <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
                    {dialogError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setDialog(null)}
                  disabled={pending}
                >
                  {actionT("cancel")}
                </Button>
                <Button
                  variant={
                    dialog.decision === "reject" ? "destructive" : "default"
                  }
                  onClick={submitDialog}
                  disabled={
                    pending ||
                    (dialog.decision === "reject" && note.trim().length === 0)
                  }
                >
                  {pending
                    ? t("batchSubmitting")
                    : dialog.decision === "approve"
                      ? actionT("approve")
                      : actionT("abort")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TowerColumn({
  group,
  operator,
  activeId,
  selected,
  pending,
  locale,
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
  selected: Set<string>;
  pending: boolean;
  locale: string;
  now: number;
  onActivate: (requestId: string) => void;
  onToggle: (requestId: string) => void;
  onApprove: (card: ApprovalTowerCard) => void;
  onReject: (card: ApprovalTowerCard) => void;
  onTakeOver: (card: ApprovalTowerCard) => void;
  registerCard: (requestId: string, element: HTMLDivElement | null) => void;
}) {
  const t = useTranslations("inbox");
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
        <div className="max-h-[calc(100vh-19rem)] space-y-2 overflow-y-auto pr-0.5">
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
