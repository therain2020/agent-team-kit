"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

/**
 * Autopilot debugging on `/ops` (96 §5.5): the primary control surface is
 * `/triggers`; "tick all" is a debug action and lives here instead of the
 * trigger console.
 */
export function AutopilotDebug({
  enabledPacks,
  totalPacks,
}: {
  enabledPacks: number;
  totalPacks: number;
}) {
  const t = useTranslations("opsSurface");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function tick() {
    setBusy(true);
    try {
      const response = await fetch("/api/autopilot/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as {
        error?: string;
        launched?: unknown[];
        autoApproved?: unknown[];
        errors?: string[];
      };
      if (!response.ok) {
        throw new Error(payload.error ?? t("tickFailed"));
      }
      toast.success(
        t("tickDone", {
          launched: payload.launched?.length ?? 0,
          approved: payload.autoApproved?.length ?? 0,
        }),
        { description: payload.errors?.slice(0, 2).join(" · ") },
      );
      router.refresh();
    } catch (tickError) {
      toast.error(
        tickError instanceof Error ? tickError.message : t("tickFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <span className="font-mono text-[11px] text-zinc-400">
        {t("activePacks", { enabled: enabledPacks, total: totalPacks })}
      </span>
      <span className="text-[11px] text-zinc-500">{t("debugHint")}</span>
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="outline" asChild>
          <Link href="/triggers">{t("openTriggers")}</Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={tick} disabled={busy}>
          <RefreshCw className="size-3.5" />
          {t("debugTick")}
        </Button>
      </div>
    </Card>
  );
}
