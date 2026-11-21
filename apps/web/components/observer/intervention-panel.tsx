"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Eye, Pause, RotateCcw, Skull } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

type PanelType = "pause" | "kill" | "rollback";

const TYPES: PanelType[] = ["pause", "kill", "rollback"];

const TYPE_ICON = {
  pause: Pause,
  kill: Skull,
  rollback: RotateCcw,
} as const;

async function post(body: Record<string, unknown>): Promise<{
  ok: boolean;
  error?: string;
}> {
  const response = await fetch("/api/observer/interventions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return { ok: response.ok, error: payload.error };
}

/**
 * Observer four-powers panel (98 §3.5): pause, kill, rollback. Edit reuses the
 * existing interest-profile editor so it keeps writing the profile audit; the
 * unified API still accepts `type=edit` for automation.
 */
export function InterventionPanel({ editHref }: { editHref: string }) {
  const t = useTranslations("observer");
  const router = useRouter();
  const [type, setType] = useState<PanelType>("pause");
  const [reason, setReason] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [reference, setReference] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ACTION_LABEL: Record<PanelType, string> = {
    pause: t("actionPause"),
    kill: t("actionKill"),
    rollback: t("actionRollback"),
  };
  const TARGET_PLACEHOLDER: Record<PanelType, string> = {
    pause: t("targetPlaceholderPause"),
    kill: t("targetPlaceholderKill"),
    rollback: t("targetPlaceholderRollback"),
  };
  const needsConfirm = type === "kill";
  const disabled =
    busy || reason.trim().length === 0 || (needsConfirm && !confirm);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await post({
        type,
        reason: reason.trim(),
        ...(targetRef.trim() ? { targetRef: targetRef.trim() } : {}),
        ...(type === "rollback" && reference.trim()
          ? { reference: reference.trim() }
          : {}),
      });
      if (!result.ok) {
        setError(result.error ?? t("failed"));
        return;
      }
      toast.success(t("success"));
      setReason("");
      setTargetRef("");
      setReference("");
      setConfirm(false);
      router.refresh();
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap gap-2">
        {TYPES.map((item) => {
          const Icon = TYPE_ICON[item];
          return (
            <Button
              key={item}
              size="sm"
              variant={type === item ? "default" : "outline"}
              onClick={() => {
                setType(item);
                setConfirm(false);
              }}
              disabled={busy}
            >
              <Icon className="size-3.5" />
              {ACTION_LABEL[item]}
            </Button>
          );
        })}
        <Link
          href={editHref}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[11px] text-zinc-300 hover:bg-accent"
        >
          <Eye className="size-3.5" />
          {t("editProfile")}
        </Link>
      </div>

      <label
        htmlFor="observer-target"
        className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
      >
        {t("targetLabel")}
        <Input
          id="observer-target"
          value={targetRef}
          onChange={(event) => setTargetRef(event.target.value)}
          placeholder={TARGET_PLACEHOLDER[type]}
          className="text-[11px]"
        />
      </label>

      {type === "rollback" ? (
        <label
          htmlFor="observer-reference"
          className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
        >
          {t("referenceLabel")}
          <Input
            id="observer-reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder={t("referencePlaceholder")}
            className="text-[11px]"
          />
        </label>
      ) : null}

      <label
        htmlFor="observer-reason"
        className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
      >
        {t("reasonLabel")}
        <Textarea
          id="observer-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t("reasonPlaceholder")}
          rows={2}
          className="text-[11px]"
        />
      </label>

      {needsConfirm ? (
        <label className="flex items-center gap-2 text-[11px] text-amber-300">
          <input
            type="checkbox"
            checked={confirm}
            onChange={(event) => setConfirm(event.target.checked)}
          />
          {t("confirmKill")}
        </label>
      ) : null}

      {error ? (
        <p className="rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={needsConfirm ? "destructive" : "default"}
          onClick={() => void submit()}
          disabled={disabled}
        >
          {busy ? t("submitting") : t("submit")}
        </Button>
        <span className="text-[10px] text-zinc-600">{t("editHint")}</span>
      </div>
    </div>
  );
}

/** High-risk sampling review: an audited acknowledgment, not a new decision. */
export function SamplingReviewButton({ approvalId }: { approvalId: string }) {
  const t = useTranslations("observer");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await post({
        type: "approve",
        targetRef: approvalId,
        reason: reason.trim(),
        reference: `approval:${approvalId}`,
      });
      if (!result.ok) {
        setError(result.error ?? t("sampleReviewFailed"));
        return;
      }
      toast.success(t("sampleReviewSaved"));
      setOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setError(t("sampleReviewFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {t("sampleReview")}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t("sampleReviewPlaceholder")}
        rows={2}
        className="text-[11px]"
      />
      {error ? <p className="text-[10px] text-red-300">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={busy || reason.trim().length === 0}
        >
          {busy ? t("submitting") : t("sampleReviewSubmit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}
