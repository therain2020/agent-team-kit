"use client";

import { DetailDrawer } from "@/components/factory/detail-drawer";
import { PixelWorkpiece } from "@/components/factory/pixel-workpiece";
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
  type FactoryItem,
  type FactorySnapshot,
  type FactoryStationId,
  MAX_BATCH_SIZE,
  batchTargetsFor,
  lowRiskItems,
  needsConfirmation,
  orderGateItems,
  stationsFor,
} from "@/lib/factory";
import { cn, formatCny, timeAgo } from "@/lib/utils";
import { useWorld } from "@/lib/world-client";
import { reconcileFactoryItems } from "@/lib/world-state";
import {
  CheckCircle2,
  CircleAlert,
  Factory,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Decision = "approve" | "abort";

const STATION_I18N: Record<
  FactoryStationId,
  | "stationDemand"
  | "stationBuild"
  | "stationQa"
  | "stationGatekeeper"
  | "stationDeliver"
> = {
  demand: "stationDemand",
  build: "stationBuild",
  qa: "stationQa",
  gatekeeper: "stationGatekeeper",
  deliver: "stationDeliver",
};

type BatchResponse = {
  error?: string;
  batchId?: string;
  approved?: number;
  failed?: number;
  results?: Array<{ requestId?: string; ok: boolean }>;
};

function sameItem(left: FactoryItem, right: FactoryItem): boolean {
  return (
    left.runId === right.runId &&
    (left.requestId ?? "") === (right.requestId ?? "")
  );
}

export function FactoryFloor({
  initialItems,
}: {
  initialItems: FactoryItem[];
}) {
  const t = useTranslations("factory");
  const riskT = useTranslations("risk");
  const locale = useLocale();
  const world = useWorld();
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState(
    initialItems.find((item) => item.kind === "approval")?.requestId ?? "",
  );
  const [drawerItem, setDrawerItem] = useState<FactoryItem | null>(null);
  const [shift, setShift] = useState({ approved: 0, rejected: 0 });
  const [decision, setDecision] = useState<{
    kind: Decision;
    item: FactoryItem;
  } | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  const gate = useMemo(() => orderGateItems(items), [items]);
  const blocked = items.filter((item) => item.kind === "failed");
  const selected =
    gate.find((item) => item.requestId === selectedId) ?? gate[0];
  const lowCount = lowRiskItems(items).length;
  const stations = useMemo(() => stationsFor(items), [items]);

  // The world stream is the source of truth: when a delta shows the run left
  // the paused state, the workpiece leaves the conveyor even if the optimistic
  // removal already hid it; cost/timestamps follow the projection.
  useEffect(() => {
    if (!world.world) {
      return;
    }
    setItems((current) => reconcileFactoryItems(current, world.world));
  }, [world.world]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/factory", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const snapshot = (await response.json()) as FactorySnapshot;
      setItems(snapshot.items);
    } catch {
      // Keep the current workpieces; the operator can retry manually.
    } finally {
      setRefreshing(false);
    }
  }, []);

  const submit = useCallback(
    async (
      item: FactoryItem,
      kind: Decision,
      text: string,
    ): Promise<boolean> => {
      if (!item.requestId) {
        return false;
      }
      if (kind === "abort" && text.trim().length === 0) {
        setError(t("noteRequired"));
        return false;
      }

      const previous = items;
      setPending(true);
      setError(null);
      setItems((current) => current.filter((entry) => !sameItem(entry, item)));
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(item.runId)}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              decision: kind,
              note: text,
              requestId: item.requestId,
            }),
          },
        );
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? t("actionFailed"));
        }
        setShift((current) =>
          kind === "approve"
            ? { ...current, approved: current.approved + 1 }
            : { ...current, rejected: current.rejected + 1 },
        );
        const message =
          kind === "approve" ? t("approveToast") : t("abortToast");
        toast.success(message);
        setAnnounce(message);
        setDrawerItem(null);
        // No refresh needed: the world delta removes/updates the workpiece.
        return true;
      } catch (problem) {
        const message =
          problem instanceof Error ? problem.message : t("actionFailed");
        setItems(previous);
        setError(message);
        setAnnounce(t("announceFailed", { message }));
        toast.error(message);
        void refresh();
        return false;
      } finally {
        setPending(false);
      }
    },
    [items, refresh, t],
  );

  const requestApprove = useCallback(
    (item: FactoryItem) => {
      setError(null);
      if (!needsConfirmation(item)) {
        void submit(item, "approve", "");
        return;
      }
      setDrawerItem(null);
      setDecision({ kind: "approve", item });
      setNote("");
    },
    [submit],
  );

  const requestAbort = useCallback((item: FactoryItem) => {
    setError(null);
    setDrawerItem(null);
    setDecision({ kind: "abort", item });
    setNote("");
  }, []);

  async function confirmDecision() {
    if (!decision) {
      return;
    }
    const ok = await submit(decision.item, decision.kind, note);
    if (ok) {
      setDecision(null);
      setNote("");
      setError(null);
    }
  }

  const approveAllLow = useCallback(async () => {
    const targets = batchTargetsFor(items);
    if (targets.length === 0) {
      toast.message(t("batchEmpty"));
      return;
    }

    const targetIds = new Set(targets.map((target) => target.requestId));
    const previous = items;
    setPending(true);
    setError(null);
    setItems((current) =>
      current.filter(
        (entry) => !(entry.requestId && targetIds.has(entry.requestId)),
      ),
    );
    try {
      const response = await fetch("/api/approvals/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: targets }),
      });
      const payload = (await response.json()) as BatchResponse;
      if (!response.ok) {
        throw new Error(payload.error ?? t("actionFailed"));
      }

      const approved = payload.approved ?? 0;
      const failed = payload.failed ?? 0;
      if (approved > 0) {
        setShift((current) => ({
          ...current,
          approved: current.approved + approved,
        }));
      }

      if (failed > 0) {
        const failedIds = new Set(
          (payload.results ?? [])
            .filter((result) => !result.ok && result.requestId)
            .map((result) => result.requestId),
        );
        setItems((current) => {
          const present = new Set(
            current
              .map((entry) => entry.requestId)
              .filter((id): id is string => Boolean(id)),
          );
          const restore = previous.filter(
            (entry) =>
              entry.requestId &&
              failedIds.has(entry.requestId) &&
              !present.has(entry.requestId),
          );
          return [...current, ...restore];
        });
        const message = t("batchPartial", { approved, failed });
        toast.error(message);
        setAnnounce(message);
      } else {
        const message = t("batchToast", { count: approved });
        toast.success(message);
        setAnnounce(message);
      }

      if (lowCount > targets.length) {
        toast.message(t("batchLimit", { max: MAX_BATCH_SIZE }));
      }
    } catch (problem) {
      const message =
        problem instanceof Error ? problem.message : t("actionFailed");
      setItems(previous);
      setError(message);
      setAnnounce(t("announceFailed", { message }));
      toast.error(message);
      void refresh();
    } finally {
      setPending(false);
    }
  }, [items, lowCount, refresh, t]);

  const openDrawer = useCallback((item: FactoryItem) => {
    if (item.requestId) {
      setSelectedId(item.requestId);
    }
    setDrawerItem(item);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (!selected || pending || decision || drawerItem) {
        return;
      }
      const interactive =
        target &&
        (target.tagName === "BUTTON" ||
          target.tagName === "A" ||
          target.tagName === "SELECT");
      if (interactive && (event.key === " " || event.key === "Enter")) {
        return;
      }

      if (
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "j" ||
        event.key === "k"
      ) {
        event.preventDefault();
        const index = gate.findIndex(
          (item) => item.requestId === selected.requestId,
        );
        const backwards = event.key === "ArrowLeft" || event.key === "k";
        const delta = backwards ? -1 : 1;
        const next = gate[(index + delta + gate.length) % gate.length];
        if (next?.requestId) {
          setSelectedId(next.requestId);
        }
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        requestApprove(selected);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        requestAbort(selected);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openDrawer(selected);
        return;
      }
      if (event.key === "a" || event.key === "A") {
        event.preventDefault();
        void approveAllLow();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    approveAllLow,
    decision,
    drawerItem,
    gate,
    openDrawer,
    pending,
    requestAbort,
    requestApprove,
    selected,
  ]);

  const drawer =
    drawerItem &&
    (items.find((entry) => sameItem(entry, drawerItem)) ?? drawerItem);

  return (
    <div className="space-y-5">
      <output className="sr-only" aria-live="polite">
        {announce}
      </output>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold uppercase tracking-tight text-emerald-300">
            <Factory className="size-5" />
            {t("title")}
          </h1>
          <p className="mt-1 text-xs text-zinc-500">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden font-mono text-[10px] uppercase text-zinc-500 sm:inline">
            {t("shortcuts")}
          </span>
          <WorldStatus />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={refreshing || pending}
            aria-label={t("refresh")}
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                refreshing && "animate-spin motion-reduce:animate-none",
              )}
            />
            {t("refresh")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void approveAllLow()}
            disabled={pending}
          >
            <CheckCircle2 className="size-3.5" />
            {t("batch")}
          </Button>
        </div>
      </div>

      {error && !decision ? (
        <p className="border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex items-stretch gap-1 overflow-x-auto border-2 border-zinc-800 bg-zinc-950 p-1.5">
        {stations.map((station, index) => (
          <div key={station.id} className="flex items-center gap-1">
            <div
              className={cn(
                "min-w-24 border px-2 py-1 font-mono text-[9px] uppercase tracking-wide",
                station.count > 0
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300"
                  : "border-zinc-800 text-zinc-600",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{t(STATION_I18N[station.id])}</span>
                <span>{station.count}</span>
              </span>
            </div>
            {index < stations.length - 1 ? (
              <span className="text-zinc-700">→</span>
            ) : null}
          </div>
        ))}
      </div>

      <section className="rounded-none border-2 border-zinc-700 bg-[#0d1117] p-3 shadow-[4px_4px_0_#000]">
        <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-zinc-500">
          <span>{t("conveyor")}</span>
          <span>
            {t("gatekeeper")} · {gate.length}
          </span>
        </div>

        <div
          className="factory-belt hidden min-h-44 items-stretch gap-2 overflow-x-auto border-y-2 border-zinc-800 p-3 md:flex"
          aria-live="polite"
        >
          {gate.length === 0 ? (
            <div className="flex w-full items-center justify-center gap-2 font-mono text-xs text-zinc-600">
              <CheckCircle2 className="size-4" />
              {t("empty")}
            </div>
          ) : (
            gate.map((item) => {
              const active = selected?.requestId === item.requestId;
              return (
                <button
                  key={item.requestId}
                  type="button"
                  onClick={() => openDrawer(item)}
                  className={cn(
                    "min-w-52 border-2 px-3 py-2 text-left font-mono transition-colors",
                    active
                      ? "border-emerald-400 bg-emerald-500/10"
                      : "border-zinc-700 bg-zinc-900 hover:border-zinc-500",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-[11px] text-zinc-200">
                      <PixelWorkpiece item={item} size={24} />
                      <span className="truncate">
                        {item.stageName ?? item.workflowId ?? item.runId}
                      </span>
                    </span>
                    <Badge
                      variant={
                        item.riskClass === "high"
                          ? "danger"
                          : item.riskClass === "medium"
                            ? "warning"
                            : "outline"
                      }
                      className="rounded-none text-[9px] uppercase"
                    >
                      {riskT(item.riskClass)}
                    </Badge>
                  </div>
                  <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-zinc-400">
                    {item.summary}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-[9px] text-zinc-600">
                    <span>{formatCny(item.costCny)}</span>
                    <span>{timeAgo(item.updatedAt, locale)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="space-y-2 md:hidden" aria-live="polite">
          {gate.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-4 font-mono text-xs text-zinc-600">
              <CheckCircle2 className="size-4" />
              {t("empty")}
            </div>
          ) : (
            gate.map((item) => (
              <div
                key={item.requestId}
                className={cn(
                  "border-2 p-2",
                  selected?.requestId === item.requestId
                    ? "border-emerald-400 bg-emerald-500/10"
                    : "border-zinc-700 bg-zinc-900",
                )}
              >
                <button
                  type="button"
                  onClick={() => openDrawer(item)}
                  className="flex w-full items-start gap-2 text-left"
                >
                  <PixelWorkpiece item={item} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-200">
                      <span className="truncate">
                        {item.stageName ?? item.workflowId ?? item.runId}
                      </span>
                      <Badge
                        variant={
                          item.riskClass === "high"
                            ? "danger"
                            : item.riskClass === "medium"
                              ? "warning"
                              : "outline"
                        }
                        className="rounded-none text-[9px] uppercase"
                      >
                        {riskT(item.riskClass)}
                      </Badge>
                    </span>
                    <span className="mt-1 block line-clamp-2 text-[11px] leading-relaxed text-zinc-400">
                      {item.summary}
                    </span>
                    <span className="mt-1 flex justify-between text-[9px] text-zinc-600">
                      <span>{formatCny(item.costCny)}</span>
                      <span>{timeAgo(item.updatedAt, locale)}</span>
                    </span>
                  </span>
                </button>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => requestApprove(item)}
                    disabled={pending}
                  >
                    <CheckCircle2 className="size-3.5" />
                    {t("approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 border-red-500/30 text-red-300 hover:bg-red-500/10"
                    onClick={() => requestAbort(item)}
                    disabled={pending}
                  >
                    <XCircle className="size-3.5" />
                    {t("abort")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 border-2 border-zinc-800 bg-zinc-950 p-3">
          <ShieldAlert className="size-4 text-amber-300" />
          <span className="font-mono text-[10px] uppercase text-zinc-500">
            {t("gatekeeper")}
          </span>
          {selected ? (
            <>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                {selected.summary}
              </span>
              <Button
                size="sm"
                onClick={() => requestApprove(selected)}
                disabled={pending}
              >
                <CheckCircle2 className="size-3.5" />
                {t("approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-red-500/30 text-red-300 hover:bg-red-500/10"
                onClick={() => requestAbort(selected)}
                disabled={pending}
              >
                <XCircle className="size-3.5" />
                {t("abort")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openDrawer(selected)}
                disabled={pending}
              >
                <ScrollText className="size-3.5" />
                {t("evidence")}
              </Button>
            </>
          ) : (
            <span className="text-xs text-zinc-600">{t("empty")}</span>
          )}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border-2 border-zinc-800 bg-[#0d1117] p-3">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-red-300">
            <CircleAlert className="size-4" />
            {t("blocked")} · {blocked.length}
          </h2>
          <div className="mt-2 space-y-2">
            {blocked.length === 0 ? (
              <p className="text-xs text-zinc-600">{t("blockedEmpty")}</p>
            ) : (
              blocked.map((item) => (
                <button
                  key={`${item.runId}-${item.updatedAt}`}
                  type="button"
                  onClick={() => openDrawer(item)}
                  className="block w-full border border-red-500/20 bg-red-500/5 px-3 py-2 text-left font-mono text-[11px] text-zinc-400 transition-colors hover:border-red-500/40"
                >
                  <span className="flex items-center gap-2">
                    <PixelWorkpiece item={item} size={20} />
                    <span className="text-zinc-200">{item.summary}</span>
                  </span>
                  <span className="mt-1 flex justify-between text-[9px] text-zinc-600">
                    <span>{item.runId}</span>
                    <span>{timeAgo(item.updatedAt, locale)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="border-2 border-zinc-800 bg-[#0d1117] p-3">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-emerald-300">
            <CheckCircle2 className="size-4" />
            {t("done")}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] uppercase text-zinc-500">
            <span>
              {t("approvedCount")}{" "}
              <span className="text-emerald-300">{shift.approved}</span>
            </span>
            <span>
              {t("rejectedCount")}{" "}
              <span className="text-red-300">{shift.rejected}</span>
            </span>
          </div>
          <p className="mt-2 text-xs text-zinc-600">{t("doneHint")}</p>
        </section>
      </div>

      <DetailDrawer
        item={drawer || null}
        open={drawer !== null && drawer !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setDrawerItem(null);
          }
        }}
        onApprove={requestApprove}
        onReject={requestAbort}
        pending={pending}
      />

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setDecision(null);
            setError(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision?.kind === "approve"
                ? t("confirmTitle", {
                    risk: riskT(decision.item.riskClass),
                  })
                : t("abortTitle")}
            </DialogTitle>
            <DialogDescription>
              {decision?.kind === "approve"
                ? t("confirmDesc", { runId: decision.item.runId })
                : t("abortDesc", { runId: decision?.item.runId ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              htmlFor="factory-note"
              className="text-xs font-medium text-zinc-300"
            >
              {decision?.kind === "abort" ? t("noteRequired") : t("note")}
            </label>
            <Textarea
              id="factory-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
            />
            <p className="text-[10px] text-zinc-600">{t("auditHint")}</p>
            {error ? (
              <p className="border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDecision(null)}
              disabled={pending}
            >
              {t("cancel")}
            </Button>
            <Button
              variant={decision?.kind === "abort" ? "destructive" : "default"}
              onClick={() => void confirmDecision()}
              disabled={
                pending ||
                (decision?.kind === "abort" && note.trim().length === 0)
              }
            >
              {pending
                ? t("submitting")
                : decision?.kind === "approve"
                  ? t("approve")
                  : t("abort")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
