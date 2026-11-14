"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function BudgetResetButton({
  runId,
  label,
  errorLabel,
}: {
  runId: string;
  label: string;
  errorLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          const response = await fetch("/api/manager/budget", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId }),
          }).catch(() => null);
          setBusy(false);
          if (!response?.ok) {
            setFailed(true);
            return;
          }
          router.refresh();
        }}
      >
        {label}
      </Button>
      {failed ? <p className="text-red-300">{errorLabel}</p> : null}
    </div>
  );
}
