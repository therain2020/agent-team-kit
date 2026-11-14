"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  Rocket,
  Upload,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

interface PublishCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface PublishResult {
  ok: boolean;
  manifestPath: string;
  generated: boolean;
  written: boolean;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  permissions: Record<string, boolean | undefined>;
  risk: { level: "low" | "medium" | "high"; reasons: string[] };
  checks: PublishCheck[];
}

export function PackPublish({ dirName }: { dirName: string }) {
  const t = useTranslations("studio");
  const [busy, setBusy] = useState<"check" | "write" | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);

  async function run(write: boolean) {
    setBusy(write ? "write" : "check");
    try {
      const response = await fetch("/api/workshop/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: dirName, write }),
      });
      const payload = (await response.json()) as PublishResult & {
        error?: string;
      };
      if (payload.error) {
        throw new Error(payload.error);
      }
      setResult(payload);
      if (payload.ok) {
        toast.success(write ? t("publish.written") : t("publish.checked"));
      } else {
        toast.error(t("publish.failed"));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <Rocket className="size-4 text-amber-300" />
          {t("publish.title")}
        </h3>
        <p className="text-[11px] text-zinc-500">{t("publish.hint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => run(false)}
            disabled={busy !== null}
          >
            <CheckCircle2 className="size-3.5" />
            {t("publish.check")}
          </Button>
          <Button
            size="sm"
            onClick={() => run(true)}
            disabled={busy !== null || !result?.ok}
          >
            <Upload className="size-3.5" />
            {t("publish.write")}
          </Button>
        </div>
      </div>

      {result ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
            <span className="font-mono">{result.manifestPath}</span>
            <span>
              {result.generated
                ? t("publish.generated")
                : t("publish.existing")}
            </span>
            <span>
              {result.written
                ? t("publish.writtenState")
                : t("publish.notWritten")}
            </span>
            <span className="font-mono">
              {t("publish.fileCount", { count: result.files.length })}
            </span>
            <span
              className={cn(
                "rounded border px-1.5 py-0.5",
                result.risk.level === "low" &&
                  "border-emerald-500/30 text-emerald-300",
                result.risk.level === "medium" &&
                  "border-amber-500/30 text-amber-300",
                result.risk.level === "high" &&
                  "border-red-500/30 text-red-300",
              )}
            >
              {t("publish.risk", { level: result.risk.level })}
            </span>
          </div>
          {result.risk.reasons.length > 0 ? (
            <ul className="list-inside list-disc text-[11px] text-zinc-500">
              {result.risk.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <ul className="space-y-1">
            {result.checks.map((check) => (
              <li
                key={check.id}
                className="flex items-start gap-2 text-[11px] text-zinc-400"
              >
                {check.status === "pass" ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 text-emerald-400" />
                ) : check.status === "warn" ? (
                  <AlertTriangle className="mt-0.5 size-3.5 text-amber-300" />
                ) : (
                  <XCircle className="mt-0.5 size-3.5 text-red-400" />
                )}
                <span>
                  <span className="font-mono text-zinc-300">{check.id}</span>
                  {": "}
                  {check.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
