"use client";

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
  type FactoryItem,
  lowRiskItems,
  needsConfirmation,
  orderGateItems,
} from "@/lib/factory";
import { formatCny, timeAgo } from "@/lib/utils";
import {
  CheckCircle2,
  CircleAlert,
  Factory,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Decision = "approve" | "abort";

export function FactoryFloor({
  initialItems,
}: {
  initialItems: FactoryItem[];
}) {
  const t = useTranslations("factory");
  const riskT = useTranslations("risk");
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState(
    initialItems.find((item) => item.kind === "approval")?.requestId ?? "",
  );
  const [done, setDone] = useState(0);
  const [decision, setDecision] = useState<{
    kind: Decision;
    item: FactoryItem;
  } | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gate = useMemo(() => orderGateItems(items), [items]);
  const blocked = items.filter((item) => item.kind === "failed");
  const selected =
    gate.find((item) => item.requestId === selectedId) ?? gate[0];

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
      if (!selected || pending || decision) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const index = gate.findIndex(
          (item) => item.requestId === selected.requestId,
        );
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        const next = gate[(index + delta + gate.length) % gate.length];
        if (next?.requestId) {
          setSelectedId(next.requestId);
        }
      }
      if (event.key === " ") {
        event.preventDefault();
        requestApprove(selected);
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        requestAbort(selected);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decision, gate, pending, selected]);

  async function submit(item: FactoryItem, kind: Decision, text: string) {
    if (!item.requestId) {
      return;
    }
    if (kind === "abort" && text.trim().length === 0) {
      setError(t("noteRequired"));
      return;
    }
    setPending(true);
    setError(null);
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
      setItems((current) =>
        current.filter((entry) => entry.requestId !== item.requestId),
      );
      setDone((current) => current + 1);
      toast.success(kind === "approve" ? t("approveToast") : t("abortToast"));
      setDecision(null);
      setNote("");
      router.refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : t("actionFailed"));
    } finally {
      setPending(false);
    }
  }

  function requestApprove(item: FactoryItem) {
    setError(null);
    if (!needsConfirmation(item)) {
      void submit(item, "approve", "");
      return;
    }
    setDecision({ kind: "approve", item });
    setNote("");
  }

  function requestAbort(item: FactoryItem) {
    setError(null);
    setDecision({ kind: "abort", item });
    setNote("");
  }

  async function approveAllLow() {
    const low = lowRiskItems(items);
    if (low.length === 0) {
      toast.message(t("batchEmpty"));
      return;
    }
    for (const item of low) {
      await submit(item, "approve", "");
    }
    toast.success(t("batchToast", { count: low.length }));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-mono text-lg font-semibold uppercase tracking-tight text-emerald-300">
            <Factory className="size-5" />
            {t("title")}
          </h1>
          <p className="mt-1 text-xs text-zinc-500">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-zinc-500">
            {t("shortcuts")}
          </span>
          <Button size="sm" variant="outline" onClick={approveAllLow}>
            <CheckCircle2 className="size-3.5" />
            {t("batch")}
          </Button>
        </div>
      </div>

      <section className="rounded-none border-2 border-zinc-700 bg-[#0d1117] p-3 shadow-[4px_4px_0_#000]">
        <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-zinc-500">
          <span>{t("conveyor")}</span>
          <span>
            {t("gatekeeper")} · {gate.length}
          </span>
        </div>
        <div
          className="flex min-h-44 items-stretch gap-2 overflow-x-auto border-y-2 border-zinc-800 bg-[repeating-linear-gradient(90deg,#18181b_0,#18181b_18px,#27272a_18px,#27272a_20px)] p-3"
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
                  onClick={() =>
                    item.requestId && setSelectedId(item.requestId)
                  }
                  className={`min-w-52 border-2 px-3 py-2 text-left font-mono transition-colors ${
                    active
                      ? "border-emerald-400 bg-emerald-500/10"
                      : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-zinc-200">
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
              <Button size="sm" variant="ghost" asChild>
                <Link href={`/runs/${encodeURIComponent(selected.runId)}`}>
                  {t("run")}
                </Link>
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
                <Link
                  key={`${item.runId}-${item.updatedAt}`}
                  href={`/runs/${encodeURIComponent(item.runId)}`}
                  className="block border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-[11px] text-zinc-400 transition-colors hover:border-red-500/40"
                >
                  <span className="text-zinc-200">{item.summary}</span>
                  <span className="mt-1 flex justify-between text-[9px] text-zinc-600">
                    <span>{item.runId}</span>
                    <span>{timeAgo(item.updatedAt, locale)}</span>
                  </span>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="border-2 border-zinc-800 bg-[#0d1117] p-3">
          <h2 className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-emerald-300">
            <CheckCircle2 className="size-4" />
            {t("done")} · {done}
          </h2>
          <p className="mt-3 text-xs text-zinc-600">{t("doneHint")}</p>
        </section>
      </div>

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
              onClick={() =>
                decision && submit(decision.item, decision.kind, note)
              }
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
