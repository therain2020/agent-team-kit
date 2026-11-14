"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatCny } from "@/lib/utils";
import { Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const EVIDENCE_PLACEHOLDER =
  '{"sources":[{"citationId":"S1","title":"…","url":"…"}],"errors":[]}';

export function RunPackDialog({
  packDir,
  workflows,
  defaultWorkflow,
}: {
  packDir: string;
  workflows: Array<{
    id: string;
    stages: number;
    estimatedCostCny: number;
  }>;
  defaultWorkflow?: string;
}) {
  const t = useTranslations("runDialog");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [workflow, setWorkflow] = useState(
    defaultWorkflow ?? workflows[0]?.id ?? "",
  );
  const [stub, setStub] = useState(true);
  const [evidence, setEvidence] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = workflows.find((item) => item.id === workflow);

  async function start() {
    setError(null);

    if (evidence.trim()) {
      try {
        JSON.parse(evidence);
      } catch {
        setError(t("invalidEvidence"));
        return;
      }
    }

    setPending(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "packRun",
          packDir,
          workflow,
          stub,
          runMode: "DRY_RUN",
          ...(evidence.trim() ? { evidenceText: evidence } : {}),
        }),
      });
      const payload = (await response.json()) as {
        jobId?: string;
        error?: string;
      };

      if (!response.ok || !payload.jobId) {
        setError(
          payload.error ?? t("failedToStart", { status: response.status }),
        );
        return;
      }

      toast.success(t("runStarted", { runId: payload.jobId }));
      setOpen(false);
      router.push(`/runs/${encodeURIComponent(payload.jobId)}`);
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : t("failedToStart", { status: "?" }),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Play className="size-3.5" />
          {t("startButton")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { pack: packDir })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="run-workflow"
              className="text-xs font-medium text-zinc-300"
            >
              {t("workflow")}
            </label>
            <select
              id="run-workflow"
              value={workflow}
              onChange={(event) => setWorkflow(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-sm text-zinc-200 outline-none focus:border-ring"
            >
              {workflows.map((item) => (
                <option key={item.id} value={item.id}>
                  {t("workflowOption", {
                    id: item.id,
                    stages: item.stages,
                    cost: formatCny(item.estimatedCostCny),
                  })}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
            <input
              type="checkbox"
              checked={stub}
              onChange={(event) => setStub(event.target.checked)}
              className="mt-0.5 size-3.5 accent-emerald-500"
            />
            <span>
              <span className="block text-xs font-medium text-zinc-300">
                {t("stubModel")}
              </span>
              <span className="block text-[11px] text-zinc-500">
                {t("stubDesc")}
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <label
              htmlFor="run-evidence"
              className="text-xs font-medium text-zinc-300"
            >
              {t("evidenceLabel")}
            </label>
            <Textarea
              id="run-evidence"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
              placeholder={EVIDENCE_PLACEHOLDER}
              className="min-h-28 font-mono text-[11px]"
            />
            <p className="text-[10px] text-zinc-600">{t("evidenceHint")}</p>
          </div>

          <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-500">
            {t("modeLine", {
              mode: "DRY_RUN",
              cost: formatCny(selected?.estimatedCostCny ?? 0),
            })}
            {stub ? t("stubOverrides") : ""}
          </div>

          {error ? (
            <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={start} disabled={pending || !workflow}>
            {pending ? t("starting") : t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
