"use client";

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
import { timeUntil } from "@/lib/utils";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Decision = "approve" | "abort";

export function ApprovalActions({
  runId,
  requestId,
  expiresAt,
  actionable,
  expired,
  status,
}: {
  runId: string;
  requestId: string;
  expiresAt: string;
  actionable: boolean;
  expired: boolean;
  status: string;
}) {
  const t = useTranslations("approvalActions");
  const statusT = useTranslations("status");
  const locale = useLocale();
  const router = useRouter();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() =>
    timeUntil(expiresAt, locale),
  );

  useEffect(() => {
    setRemaining(timeUntil(expiresAt, locale));
    const timer = setInterval(
      () => setRemaining(timeUntil(expiresAt, locale)),
      30_000,
    );
    return () => clearInterval(timer);
  }, [expiresAt, locale]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "Escape") {
        // Esc closes the confirm dialog first; only a second Esc leaves detail.
        if (decision !== null) {
          return;
        }
        event.preventDefault();
        router.push("/inbox");
        return;
      }
      if (!actionable) {
        return;
      }
      if (event.key === "a" || event.key === "A") {
        event.preventDefault();
        setDecision("approve");
      }
      if (
        event.key === "r" ||
        event.key === "R" ||
        event.key === "x" ||
        event.key === "X"
      ) {
        event.preventDefault();
        setDecision("abort");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actionable, decision, router]);

  async function submit() {
    if (!decision) {
      return;
    }
    if (decision === "abort" && note.trim().length === 0) {
      setError(t("noteRequired"));
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, note, requestId }),
        },
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        signaled?: boolean;
        duplicate?: boolean;
      };

      if (!response.ok) {
        setError(
          payload.error ?? t("requestFailed", { status: response.status }),
        );
        if (payload.signaled === false) {
          toast.error(t("recordedSignalFailed"));
        }
        return;
      }

      toast.success(
        decision === "approve" ? t("approvedToast") : t("abortedToast"),
      );
      setDecision(null);
      router.push(`/runs/${encodeURIComponent(runId)}`);
      router.refresh();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t("requestFailed", { status: "?" }),
      );
    } finally {
      setPending(false);
    }
  }

  if (!actionable) {
    return (
      <div className="rounded-md border border-border bg-card px-3 py-3 text-xs text-muted-foreground">
        {expired
          ? t("notActionableExpired")
          : status !== "paused"
            ? t("notActionableStatus", { status: statusT(status) })
            : t("notActionable")}
      </div>
    );
  }

  const hasExpiry =
    Boolean(expiresAt) && new Date(expiresAt).getTime() > Date.now();

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span>
            {hasExpiry
              ? t("expiresIn", { time: remaining })
              : t("expiryUnknown")}
          </span>
          <span className="font-mono">{t("shortcuts")}</span>
        </div>
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => setDecision("approve")}
            disabled={pending}
          >
            {t("approve")}
          </Button>
          <Button
            variant="outline"
            className="flex-1 border-red-500/30 text-red-300 hover:bg-red-500/10"
            onClick={() => setDecision("abort")}
            disabled={pending}
          >
            {t("abort")}
          </Button>
        </div>
        {error ? (
          <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
            {error}
          </p>
        ) : null}
      </div>

      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setDecision(null);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decision === "approve"
                ? t("dialogApproveTitle")
                : t("dialogAbortTitle")}
            </DialogTitle>
            <DialogDescription>
              {decision === "approve"
                ? t("dialogApproveDesc")
                : t("dialogAbortDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              htmlFor="decision-note"
              className="text-xs font-medium text-zinc-300"
            >
              {decision === "abort"
                ? t("noteRequiredLabel")
                : t("noteOptional")}
            </label>
            <Textarea
              id="decision-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                decision === "abort"
                  ? t("notePlaceholderAbort")
                  : t("notePlaceholderApprove")
              }
              maxLength={2000}
            />
            <p className="text-[10px] text-zinc-600">{t("auditNote")}</p>
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
              variant={decision === "abort" ? "destructive" : "default"}
              onClick={submit}
              disabled={
                pending || (decision === "abort" && note.trim().length === 0)
              }
            >
              {pending
                ? t("submitting")
                : decision === "approve"
                  ? t("approveResume")
                  : t("abortRun")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
