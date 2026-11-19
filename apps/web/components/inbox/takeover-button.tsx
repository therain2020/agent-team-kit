"use client";

import { Button } from "@/components/ui/button";
import { Hand } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export function TakeoverButton({
  requestId,
  version,
  takenByOther,
}: {
  requestId: string;
  version: number;
  takenByOther: boolean;
}) {
  const t = useTranslations("approval");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function takeOver() {
    setPending(true);
    try {
      const response = await fetch(
        `/api/approvals/${encodeURIComponent(requestId)}/assign`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `request failed (${response.status})`);
      }
      toast.success(t("takeOverToast"));
      router.refresh();
    } catch (problem) {
      const message =
        problem instanceof Error ? problem.message : String(problem);
      toast.error(t("takeOverFailed", { message }));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      size="sm"
      variant={takenByOther ? "outline" : "default"}
      className="h-7 px-2 text-[11px]"
      disabled={pending}
      onClick={() => void takeOver()}
    >
      <Hand className="size-3" />
      {t("takeOver")}
    </Button>
  );
}
