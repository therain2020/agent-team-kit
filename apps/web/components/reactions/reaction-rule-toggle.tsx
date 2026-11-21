"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

/**
 * Observer enable/disable control (98 §3.5). A required rationale is written
 * with the new rule version; nothing toggles silently.
 */
export function ReactionRuleToggle({
  ruleId,
  enabled,
  version,
}: {
  ruleId: string;
  enabled: boolean;
  version: number;
}) {
  const t = useTranslations("reactions");
  const router = useRouter();
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);

  async function toggle() {
    if (!rationale.trim()) {
      toast.error(t("rationaleRequired"));
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/reactions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ruleId,
          enabled: !enabled,
          rationale: rationale.trim(),
          expectedVersion: version,
        }),
      });
      const payload = (await response.json()) as {
        rule?: { version: number };
        error?: string;
      };
      if (!response.ok || !payload.rule) {
        throw new Error(payload.error ?? t("toggleFailed"));
      }
      toast.success(
        enabled
          ? t("disabledToast", { version: payload.rule.version })
          : t("enabledToast", { version: payload.rule.version }),
      );
      setRationale("");
      router.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("toggleFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        placeholder={t("toggleRationalePlaceholder")}
        className="h-7 max-w-xs text-[11px]"
      />
      <Button
        size="sm"
        variant={enabled ? "outline" : "default"}
        onClick={() => void toggle()}
        disabled={pending}
      >
        {pending ? t("saving") : enabled ? t("disable") : t("enable")}
      </Button>
    </div>
  );
}
