"use client";

import { ApprovalDrawer } from "@/components/approvals/approval-drawer";
import { FactoryView } from "@/components/approvals/factory-view";
import { QueueView } from "@/components/approvals/queue-view";
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
import { WorldStatus } from "@/components/world/world-status";
import {
  type ApprovalsView,
  approvalsHref,
  cycleRequestId,
  firstRequestForRun,
  flattenTower,
  resolveInitialRequest,
  stepRequestId,
  towerBatchTargets,
  towerCardToItem,
} from "@/lib/approvals-view";
import {
  type FactoryItem,
  type FactorySnapshot,
  batchTargetsFor,
  missingPausedRunIds,
  needsConfirmation,
  orderGateItems,
} from "@/lib/factory";
import type { ApprovalTowerSnapshot } from "@/lib/inbox-shared";
import { groupApprovals } from "@/lib/inbox-shared";
import { officeAgentHref, officeRoomHref } from "@/lib/office-deeplink";
import { factoryRoomShortcut } from "@/lib/office-keys";
import {
  type DecisionKind,
  type DecisionTarget,
  useApprovalDecisions,
} from "@/lib/use-approval-decisions";
import { useApprovalQueue } from "@/lib/use-approval-queue";
import { cn, formatCny, timeAgo } from "@/lib/utils";
import { useWorld } from "@/lib/world-client";
import { reconcileFactoryItems } from "@/lib/world-state";
import {
  AlertTriangle,
  Factory,
  Inbox as InboxIcon,
  RefreshCw,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

/** A new paused run waits this long before the line refetches its snapshot. */
const FACTORY_RESYNC_DEBOUNCE_MS = 1_200;

type DialogState =
  | { kind: "single"; decision: DecisionKind; target: DecisionTarget }
  | {
      kind: "batch";
      decision: DecisionKind;
      targets: DecisionTarget[];
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

/**
 * One approvals surface, two views (82 §3, 89 §3.1).
 *
 * The SLA tower and the pixel conveyor are the same queue seen twice, so this
 * component owns the three pieces that must never diverge: the selected
 * approval, the decision path (single, batch, takeover all go through
 * `useApprovalDecisions`) and the keyboard. Views only render.
 */
export function ApprovalsSurface({
  initialTower,
  initialItems,
  operator,
  initialView,
  initialRequestId,
  initialRunId,
}: {
  initialTower: ApprovalTowerSnapshot;
  initialItems: FactoryItem[];
  operator: string;
  initialView: ApprovalsView;
  initialRequestId: string | null;
  /** `?run=` from an office station; preselects that run's first approval. */
  initialRunId: string | null;
}) {
  const t = useTranslations("approvals");
  const router = useRouter();
  const inboxT = useTranslations("inbox");
  const actionT = useTranslations("approvalActions");
  const locale = useLocale();
  const { snapshot, refreshing, error, now, refresh } =
    useApprovalQueue(initialTower);
  const world = useWorld();
  const decisions = useApprovalDecisions({
    fallbackError: inboxT("actionFailed"),
    invalidError: inboxT("actionFailed"),
  });

  const [view, setView] = useState<ApprovalsView>(initialView);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [note, setNote] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [drawerItem, setDrawerItem] = useState<FactoryItem | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);
  const [shift, setShift] = useState({ approved: 0, rejected: 0 });
  const [items, setItems] = useState(initialItems);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const shouldFocus = useRef(false);
  const deepLinkHandled = useRef(false);
  const [scopedRunId, setScopedRunId] = useState<string | null>(initialRunId);
  const [requestMissing, setRequestMissing] = useState<string | null>(null);
  const runHandled = useRef<string | null>(null);
  /** Runs already checked against `/api/factory`; a paused run without an
   * approval must not make the line refetch forever. */
  const factoryResynced = useRef(new Set<string>());

  // The world stream is the source of truth for the line: a delta that shows
  // the run left "paused" removes the workpiece without waiting for a poll.
  useEffect(() => {
    if (!world.world) {
      return;
    }
    setItems((current) => reconcileFactoryItems(current, world.world));
  }, [world.world]);

  // `approval.requested` reaches us through the same stream before the SSR
  // snapshot knows about the new workpiece. Refetch the factory snapshot once
  // per new paused run so the gate gains the item within ~2s.
  const missingPaused = useMemo(
    () => missingPausedRunIds(items, world.world),
    [items, world.world],
  );
  const missingKey = missingPaused.join(",");
  useEffect(() => {
    // The key changes only when the missing set changes; the array identity
    // changes on every world delta and would abort an in-flight fetch.
    const runIds = missingKey ? missingKey.split(",") : [];
    if (
      runIds.length === 0 ||
      !runIds.some((runId) => !factoryResynced.current.has(runId))
    ) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      for (const runId of runIds) {
        factoryResynced.current.add(runId);
      }
      void (async () => {
        try {
          const response = await fetch("/api/factory", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) {
            return;
          }
          const payload = (await response.json()) as FactorySnapshot;
          if (Array.isArray(payload.items)) {
            setItems(payload.items);
          }
        } catch {
          // The stream stays authoritative; the next delta retries.
        }
      })();
    }, FACTORY_RESYNC_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [missingKey]);

  const towerCards = useMemo(
    () =>
      snapshot.approvals.filter(
        (card) => !decisions.settled.has(card.requestId),
      ),
    [snapshot.approvals, decisions.settled],
  );
  const towerById = useMemo(
    () => new Map(towerCards.map((card) => [card.requestId, card])),
    [towerCards],
  );
  const groups = useMemo(
    () => groupApprovals(towerCards, now),
    [towerCards, now],
  );
  const flat = useMemo(() => flattenTower(groups), [groups]);
  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) => !item.requestId || !decisions.settled.has(item.requestId),
      ),
    [items, decisions.settled],
  );
  const gate = useMemo(() => orderGateItems(visibleItems), [visibleItems]);
  const failures = useMemo(
    () => visibleItems.filter((item) => item.kind === "failed"),
    [visibleItems],
  );

  // `?run=` preselects the first approval of that run once data is available.
  // If the run has no queued approval the view swaps to an explicit empty
  // state (with an escape back to the full line) instead of silently falling
  // back to the top card.
  const runRequestId = useMemo(
    () => firstRequestForRun(gate, scopedRunId),
    [gate, scopedRunId],
  );

  useEffect(() => {
    setScopedRunId(initialRunId);
    runHandled.current = null;
  }, [initialRunId]);

  useEffect(() => {
    if (!scopedRunId || !runRequestId || runHandled.current === scopedRunId) {
      return;
    }
    runHandled.current = scopedRunId;
    setActiveId(runRequestId);
    setAnnounce(t("runSelected", { runId: scopedRunId }));
  }, [scopedRunId, runRequestId, t]);

  const clearRun = useCallback(() => {
    setScopedRunId(null);
    runHandled.current = null;
    router.replace(approvalsHref("factory"));
  }, [router]);

  const clearRequest = useCallback(() => {
    setRequestMissing(null);
    router.replace(approvalsHref("factory"));
  }, [router]);

  /** Switching views leaves the run scope; the URL must follow. */
  const selectView = useCallback(
    (next: ApprovalsView) => {
      setView(next);
      if (scopedRunId) {
        setScopedRunId(null);
        runHandled.current = null;
        router.replace(approvalsHref(next));
      }
    },
    [router, scopedRunId],
  );

  const queueIds = useMemo(() => flat.map((card) => card.requestId), [flat]);
  const gateIds = useMemo(
    () => gate.flatMap((item) => (item.requestId ? [item.requestId] : [])),
    [gate],
  );
  const orderedIds = view === "queue" ? queueIds : gateIds;

  const activeCard = activeId ? (towerById.get(activeId) ?? null) : null;
  const activeItem = activeId
    ? (gate.find((item) => item.requestId === activeId) ?? null)
    : null;
  const activeAsItem =
    activeItem ?? (activeCard ? towerCardToItem(activeCard) : null);
  // Factory → office (97 §3.5): land on the producer's station when the
  // workpiece knows one, otherwise on the office floor.
  const officeHref = activeAsItem?.producerAgentId
    ? officeAgentHref(activeAsItem.producerAgentId)
    : officeRoomHref();

  /**
   * Batch targets for whatever is selected, no matter which view selected it:
   * tower cards carry the CAS version, workpieces that only exist on the line
   * do not. Same request body either way.
   */
  const selectedTargets = useMemo<DecisionTarget[]>(() => {
    const fromTower = towerBatchTargets(
      flat.filter((card) => selected.has(card.requestId)),
    );
    const covered = new Set(fromTower.map((target) => target.requestId));
    const fromLine = gate.flatMap((item) => {
      const requestId = item.requestId;
      if (!requestId || !selected.has(requestId) || covered.has(requestId)) {
        return [];
      }
      return [{ runId: item.runId, requestId, version: null }];
    });
    return [...fromTower, ...fromLine];
  }, [flat, gate, selected]);

  // Keep a valid selection in each view; a decision or a refresh can remove it.
  useEffect(() => {
    setActiveId((current) => resolveInitialRequest(orderedIds, current));
  }, [orderedIds]);

  useEffect(() => {
    if (!activeId || !shouldFocus.current) {
      return;
    }
    shouldFocus.current = false;
    cardRefs.current.get(activeId)?.focus();
  }, [activeId]);

  useEffect(() => {
    if (error) {
      setAnnounce(inboxT("refreshFailed", { message: error }));
    }
  }, [error, inboxT]);

  const openDrawer = useCallback((item: FactoryItem) => {
    if (item.requestId) {
      setActiveId(item.requestId);
    }
    setDrawerItem(item);
  }, []);

  const closeDrawer = useCallback(() => setDrawerItem(null), []);

  // `?request=` from the old /inbox/<id> deep link opens the drawer once.
  useEffect(() => {
    if (deepLinkHandled.current || !initialRequestId) {
      return;
    }
    deepLinkHandled.current = true;
    const card = towerById.get(initialRequestId);
    const item =
      gate.find((entry) => entry.requestId === initialRequestId) ??
      (card ? towerCardToItem(card) : undefined);
    if (!item) {
      // Unknown or already-decided request: show an explicit empty state
      // instead of silently falling back to the top card (97 §3.5).
      setRequestMissing(initialRequestId);
      return;
    }
    setActiveId(initialRequestId);
    setDrawerItem(item);
  }, [initialRequestId, towerById, gate]);

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

  const moveActive = useCallback(
    (delta: number) => {
      const next =
        view === "queue"
          ? stepRequestId(orderedIds, activeId, delta)
          : cycleRequestId(orderedIds, activeId, delta);
      if (next && next !== activeId) {
        shouldFocus.current = true;
        setActiveId(next);
      }
    },
    [activeId, orderedIds, view],
  );

  const submitSingle = useCallback(
    async (target: DecisionTarget, kind: DecisionKind, text: string) => {
      setDialogError(null);
      const outcome = await decisions.decide(target, kind, text);
      if (!outcome.ok) {
        setDialogError(outcome.error ?? inboxT("actionFailed"));
        setAnnounce(outcome.error ?? inboxT("actionFailed"));
        return;
      }
      const message =
        kind === "approve" ? inboxT("approvedToast") : inboxT("rejectedToast");
      toast.success(message);
      setAnnounce(message);
      setShift((current) =>
        kind === "approve"
          ? { ...current, approved: current.approved + 1 }
          : { ...current, rejected: current.rejected + 1 },
      );
      setDialog(null);
      setNote("");
      setDrawerItem(null);
      void refresh();
    },
    [decisions, inboxT, refresh],
  );

  const submitBatch = useCallback(
    async (targets: DecisionTarget[], kind: DecisionKind, text: string) => {
      setDialogError(null);
      const outcome = await decisions.batch(kind, targets, text);
      if (!outcome.summary) {
        setDialogError(outcome.error ?? inboxT("actionFailed"));
        setAnnounce(inboxT("batchFailed", { message: outcome.error ?? "" }));
        return;
      }
      const { succeeded, failed } = outcome.summary;
      const message =
        failed > 0
          ? inboxT("batchToast", { succeeded, failed })
          : inboxT("batchAllOk", { count: succeeded });
      if (failed > 0) {
        toast.error(message);
      } else {
        toast.success(message);
      }
      setAnnounce(message);
      if (kind === "approve") {
        setShift((current) => ({
          ...current,
          approved: current.approved + succeeded,
        }));
      } else {
        setShift((current) => ({
          ...current,
          rejected: current.rejected + succeeded,
        }));
      }
      setDialog(null);
      setNote("");
      setSelected(new Set());
      setDrawerItem(null);
      void refresh();
    },
    [decisions, inboxT, refresh],
  );

  /**
   * Single-key decision shared by both views (a/r). Both views hand in the
   * factory projection of their selection, so "low risk is one key" is one
   * rule (`needsConfirmation`) instead of two.
   */
  const requestDecision = useCallback(
    (
      item: FactoryItem | null,
      kind: DecisionKind,
      context: { assignee?: string | null; version?: number | null } = {},
    ) => {
      setDialogError(null);
      const requestId = item?.requestId;
      if (!item || !requestId) {
        return;
      }
      const assignee = context.assignee ?? null;
      if (assignee && assignee !== operator) {
        toast.error(inboxT("alreadyTaken"));
        return;
      }
      const target: DecisionTarget = {
        runId: item.runId,
        requestId,
        version: context.version ?? null,
      };
      if (kind === "approve" && !needsConfirmation(item)) {
        void submitSingle(target, "approve", "");
        return;
      }
      setNote("");
      setDialog({ kind: "single", decision: kind, target });
    },
    [inboxT, operator, submitSingle],
  );

  const openBatch = useCallback(
    (kind: DecisionKind) => {
      // Explicit selection wins; the line's one-key batch is the fallback for
      // "approve everything low risk on the belt".
      const targets: DecisionTarget[] =
        selectedTargets.length > 0
          ? selectedTargets
          : batchTargetsFor(visibleItems).map((target) => ({
              ...target,
              version: null,
            }));
      if (targets.length === 0) {
        return;
      }
      setDialogError(null);
      setNote("");
      setDialog({ kind: "batch", decision: kind, targets });
    },
    [selectedTargets, visibleItems],
  );

  const takeOver = useCallback(
    async (item: FactoryItem, version: number) => {
      if (!item.requestId) {
        return;
      }
      const outcome = await decisions.takeOver({
        runId: item.runId,
        requestId: item.requestId,
        version,
      });
      if (!outcome.ok) {
        toast.error(inboxT("takeOverFailed", { message: outcome.error ?? "" }));
        return;
      }
      toast.success(inboxT("takeOverToast"));
      setAnnounce(inboxT("takeOverToast"));
      setDrawerKey((current) => current + 1);
      void refresh();
    },
    [decisions, inboxT, refresh],
  );

  const queueMode = view === "queue";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (dialog || isTypingTarget(event.target)) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (
        key === "j" ||
        event.key === "ArrowDown" ||
        (queueMode && event.key === "ArrowRight")
      ) {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (
        key === "k" ||
        event.key === "ArrowUp" ||
        (queueMode && event.key === "ArrowLeft")
      ) {
        event.preventDefault();
        moveActive(-1);
        return;
      }
      if (key === "enter" && activeAsItem) {
        event.preventDefault();
        openDrawer(activeAsItem);
        return;
      }
      if ((key === "a" || key === "r") && activeAsItem) {
        event.preventDefault();
        requestDecision(activeAsItem, key === "a" ? "approve" : "reject", {
          assignee: activeCard?.assignee ?? null,
          version: activeCard?.version ?? null,
        });
        return;
      }
      if (key === "s" && activeId) {
        event.preventDefault();
        toggleSelect(activeId);
        return;
      }
      // Room switch (97 §3.5): O walks back through the office door.
      const roomHref = factoryRoomShortcut(event, {
        href: officeHref,
        queueMode,
        dialogOpen: dialog !== null,
      });
      if (roomHref) {
        event.preventDefault();
        router.push(roomHref);
        return;
      }
      if (event.key === "Escape") {
        if (drawerItem) {
          event.preventDefault();
          closeDrawer();
          return;
        }
        if (selected.size > 0) {
          event.preventDefault();
          setSelected(new Set());
          return;
        }
        if (decisions.batchResult) {
          decisions.clearBatchResult();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeAsItem,
    activeCard,
    activeId,
    closeDrawer,
    decisions,
    dialog,
    drawerItem,
    moveActive,
    officeHref,
    openDrawer,
    queueMode,
    requestDecision,
    router,
    selected.size,
    toggleSelect,
  ]);

  const total = towerCards.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label={t("title")}
          className="inline-flex rounded-md border border-border bg-zinc-950/60 p-0.5"
        >
          <ViewTab
            active={queueMode}
            onClick={() => selectView("queue")}
            icon={<InboxIcon className="size-3.5" />}
            label={t("viewQueue")}
            count={total}
          />
          <ViewTab
            active={!queueMode}
            onClick={() => selectView("factory")}
            icon={<Factory className="size-3.5" />}
            label={t("viewFactory")}
            count={gate.length}
          />
        </div>
        <span className="hidden text-[11px] text-zinc-500 sm:inline">
          {t("shortcuts")}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-zinc-500">
          <span>
            {inboxT("liveUpdated", {
              time: timeAgo(snapshot.generatedAt, locale, now),
            })}
          </span>
          <WorldStatus />
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
            {inboxT("refreshNow")}
          </Button>
        </span>
      </div>

      {snapshot.truncated ? (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          {inboxT("truncated", { limit: total })}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300"
        >
          {inboxT("refreshFailed", { message: error })}
        </p>
      ) : null}

      {selected.size > 0 ? (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-zinc-950/95 px-3 py-2 backdrop-blur">
          <span className="text-xs font-medium text-emerald-300">
            {inboxT("selectedCount", { count: selected.size })}
          </span>
          <Button
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={decisions.pending}
            onClick={() => openBatch("approve")}
          >
            {inboxT("batchApprove")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-red-500/30 px-2 text-[11px] text-red-300 hover:bg-red-500/10"
            disabled={decisions.pending}
            onClick={() => openBatch("reject")}
          >
            {inboxT("batchReject")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-2 text-[11px]"
            disabled={decisions.pending}
            onClick={() => setSelected(new Set())}
          >
            <X className="size-3" />
            {inboxT("clearSelection")}
          </Button>
        </div>
      ) : null}

      {decisions.batchResult ? (
        <div className="rounded-lg border border-border bg-card px-3 py-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-zinc-200">
              {inboxT("batchResultTitle")} · {decisions.batchResult.succeeded}/
              {decisions.batchResult.requested}
            </p>
            <button
              type="button"
              onClick={decisions.clearBatchResult}
              className="rounded p-1 text-zinc-500 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
              aria-label={inboxT("clearSelection")}
            >
              <X className="size-3.5" />
            </button>
          </div>
          {decisions.batchResult.results.length === 0 ? (
            <p className="mt-1 text-[11px] text-zinc-500">
              {inboxT("batchResultEmpty")}
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-border/60">
              {decisions.batchResult.results.map((result) => (
                <li
                  key={`${result.runId}:${result.requestId}`}
                  className="flex min-w-0 items-start gap-2 py-1 text-[11px]"
                >
                  <Badge
                    variant={result.ok ? "success" : "danger"}
                    className="shrink-0 text-[9px]"
                  >
                    {result.ok
                      ? inboxT("batchResultOk")
                      : inboxT("batchResultFailed")}
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

      {scopedRunId && !runRequestId ? (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-8 text-center">
          <p className="text-sm font-medium text-amber-200">
            {t("runEmptyTitle")}
          </p>
          <p className="mt-1 text-[11px] text-zinc-400">
            {t("runEmptyHint", { runId: scopedRunId })}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={clearRun}
          >
            {t("showAll")}
          </Button>
        </section>
      ) : requestMissing && !scopedRunId ? (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-8 text-center">
          <p className="text-sm font-medium text-amber-200">
            {t("requestEmptyTitle")}
          </p>
          <p className="mt-1 text-[11px] text-zinc-400">
            {t("requestEmptyHint", { requestId: requestMissing })}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={clearRequest}
          >
            {t("showAll")}
          </Button>
        </section>
      ) : queueMode ? (
        <>
          <QueueView
            groups={groups}
            operator={operator}
            activeId={activeId}
            selected={selected}
            pending={decisions.pending}
            now={now}
            onActivate={setActiveId}
            onToggle={toggleSelect}
            onApprove={(card) =>
              requestDecision(towerCardToItem(card), "approve", {
                assignee: card.assignee,
                version: card.version,
              })
            }
            onReject={(card) =>
              requestDecision(towerCardToItem(card), "reject", {
                assignee: card.assignee,
                version: card.version,
              })
            }
            onTakeOver={(card) =>
              void takeOver(towerCardToItem(card), card.version)
            }
            registerCard={(requestId, element) => {
              if (element) {
                cardRefs.current.set(requestId, element);
              } else {
                cardRefs.current.delete(requestId);
              }
            }}
          />

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-red-400" />
              <h2 className="text-sm font-semibold text-zinc-200">
                {inboxT("failedRuns")}
              </h2>
              <Badge variant={failures.length > 0 ? "danger" : "outline"}>
                {failures.length}
              </Badge>
            </div>

            {failures.length === 0 ? (
              <div className="rounded-lg border border-border bg-card px-3 py-4 text-center text-xs text-muted-foreground">
                {inboxT("noFailed")}
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {failures.map((failure) => (
                  <Link
                    key={failure.runId}
                    href={`/world?run=${encodeURIComponent(failure.runId)}`}
                    className="min-w-0 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:bg-accent/50"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-xs text-zinc-200">
                        {failure.runId}
                      </span>
                      <Badge variant="danger" className="text-[10px]">
                        {inboxT("failed")}
                      </Badge>
                      <span className="ml-auto text-[10px] text-zinc-500">
                        {inboxT("artifactsCost", {
                          count: failure.artifactCount ?? 0,
                          cost: formatCny(failure.costCny),
                        })}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                      {failure.summary}
                    </p>
                    <p className="mt-0.5 text-[10px] text-zinc-600">
                      {timeAgo(failure.updatedAt, locale)}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <FactoryView
          items={visibleItems}
          gate={gate}
          activeId={activeId}
          pending={decisions.pending}
          refreshing={refreshing}
          shift={shift}
          officeHref={officeHref}
          onActivate={setActiveId}
          onOpen={openDrawer}
          onApprove={(item) => requestDecision(item, "approve")}
          onReject={(item) => requestDecision(item, "reject")}
          onBatch={() => openBatch("approve")}
          onRefresh={() => void refresh()}
        />
      )}

      <output className="sr-only" aria-live="polite">
        {announce}
      </output>

      <ApprovalDrawer
        key={`${drawerItem?.requestId ?? "none"}:${drawerKey}`}
        item={drawerItem}
        open={drawerItem !== null}
        operator={operator}
        onOpenChange={(open) => {
          if (!open) {
            closeDrawer();
          }
        }}
        onApprove={(item) => requestDecision(item, "approve")}
        onReject={(item) => requestDecision(item, "reject")}
        onTakeOver={(item, version) => void takeOver(item, version)}
        pending={decisions.pending}
      />

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !decisions.pending) {
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
                      ? inboxT("batchApproveTitle", {
                          count: dialog.targets.length,
                        })
                      : inboxT("batchRejectTitle", {
                          count: dialog.targets.length,
                        })
                    : dialog.decision === "approve"
                      ? actionT("dialogApproveTitle")
                      : actionT("dialogAbortTitle")}
                </DialogTitle>
                <DialogDescription>
                  {dialog.kind === "batch"
                    ? dialog.decision === "approve"
                      ? inboxT("batchApproveDesc")
                      : inboxT("batchRejectDesc")
                    : dialog.decision === "approve"
                      ? actionT("dialogApproveDesc")
                      : actionT("dialogAbortDesc")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <label
                  htmlFor="approvals-decision-note"
                  className="text-xs font-medium text-zinc-300"
                >
                  {dialog.decision === "reject"
                    ? inboxT("batchNoteRequired")
                    : actionT("noteOptional")}
                </label>
                <Textarea
                  id="approvals-decision-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={2000}
                  placeholder={
                    dialog.decision === "approve"
                      ? actionT("notePlaceholderApprove")
                      : actionT("notePlaceholderAbort")
                  }
                />
                <p className="text-[10px] text-zinc-600">
                  {dialog.kind === "batch"
                    ? inboxT("batchNote")
                    : actionT("auditNote")}
                </p>
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
                  disabled={decisions.pending}
                >
                  {actionT("cancel")}
                </Button>
                <Button
                  variant={
                    dialog.decision === "reject" ? "destructive" : "default"
                  }
                  disabled={
                    decisions.pending ||
                    (dialog.decision === "reject" && note.trim().length === 0)
                  }
                  onClick={() => {
                    if (
                      dialog.decision === "reject" &&
                      note.trim().length === 0
                    ) {
                      setDialogError(
                        dialog.kind === "batch"
                          ? inboxT("batchNoteRequired")
                          : actionT("noteRequired"),
                      );
                      return;
                    }
                    if (dialog.kind === "single") {
                      void submitSingle(dialog.target, dialog.decision, note);
                    } else {
                      void submitBatch(dialog.targets, dialog.decision, note);
                    }
                  }}
                >
                  {decisions.pending
                    ? inboxT("batchSubmitting")
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

function ViewTab({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/70",
        active
          ? "bg-emerald-500/15 text-emerald-200"
          : "text-zinc-400 hover:text-zinc-200",
      )}
    >
      {icon}
      {label}
      <span className="font-mono text-[10px] text-zinc-500">{count}</span>
    </button>
  );
}
