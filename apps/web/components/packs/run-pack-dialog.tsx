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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatCny } from "@/lib/utils";
import { ArrowLeft, Play, RefreshCw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const EVIDENCE_PLACEHOLDER =
  '{"sources":[{"citationId":"S1","title":"…","url":"…"}],"errors":[]}';

interface PackRunValues {
  workflow: string;
  stub: boolean;
}

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
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [intent, setIntent] = useState("");
  const [workflow, setWorkflow] = useState(
    defaultWorkflow ?? workflows[0]?.id ?? "",
  );
  const [stub, setStub] = useState(true);
  const [evidence, setEvidence] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const [rationale, setRationale] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [model, setModel] = useState<"live" | "heuristic">("heuristic");
  const [pending, setPending] = useState<"draft" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep("intent");
      setError(null);
    }
  }, [open]);

  const selected = workflows.find((item) => item.id === workflow);

  async function generate() {
    setError(null);
    if (!intent.trim()) {
      setError(t("intentPlaceholder"));
      return;
    }
    setPending("draft");
    try {
      const response = await fetch("/api/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "packRun", intent, packDir }),
      });
      const payload = (await response.json()) as {
        values?: PackRunValues;
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("failedToStart", { status: "?" }));
      }
      setWorkflow(payload.values.workflow);
      setStub(payload.values.stub);
      setRationale(payload.rationale ?? "");
      setWarnings(payload.warnings ?? []);
      setModel(payload.model === "live" ? "live" : "heuristic");
      setStep("review");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("failedToStart", { status: "?" }),
      );
    } finally {
      setPending(null);
    }
  }

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

    setPending("start");
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
      setIntent("");
      setEvidence("");
      setShowEvidence(false);
      router.push(`/world?run=${encodeURIComponent(payload.jobId)}`);
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : t("failedToStart", { status: "?" }),
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setStep("intent");
          setError(null);
        }
      }}
    >
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
            {step === "intent"
              ? t("intentPlaceholder")
              : t("reviewDescription")}
          </DialogDescription>
        </DialogHeader>

        {step === "intent" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="run-intent"
                className="text-xs font-medium text-zinc-300"
              >
                {t("intent")}
              </label>
              <Textarea
                id="run-intent"
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder={t("intentPlaceholder")}
                className="min-h-20 text-sm"
              />
            </div>

            <button
              type="button"
              className="text-[11px] text-zinc-500 hover:text-zinc-300"
              onClick={() => setShowEvidence((value) => !value)}
            >
              {t("evidenceToggle")}
            </button>
            {showEvidence ? (
              <Textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder={EVIDENCE_PLACEHOLDER}
                className="min-h-24 font-mono text-[11px]"
              />
            ) : null}

            {error ? <ErrorLine message={error} /> : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                <Badge variant="violet">{packDir}</Badge>
                <Badge variant={model === "live" ? "success" : "outline"}>
                  {model === "live" ? t("aiProposal") : t("heuristicProposal")}
                </Badge>
              </div>
              <p className="mt-2 text-sm text-zinc-200">{intent}</p>
              {rationale ? (
                <p className="mt-1 text-[11px] text-zinc-400">{rationale}</p>
              ) : null}
            </div>

            {warnings.length > 0 ? (
              <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                {warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}

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

            {showEvidence ? (
              <Textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder={EVIDENCE_PLACEHOLDER}
                aria-label={t("evidenceLabel")}
                className="min-h-24 font-mono text-[11px]"
              />
            ) : null}

            <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-500">
              {t("modeLine", {
                mode: "DRY_RUN",
                cost: formatCny(selected?.estimatedCostCny ?? 0),
              })}
              {stub ? t("stubOverrides") : ""}
            </div>

            {error ? <ErrorLine message={error} /> : null}
          </div>
        )}

        <DialogFooter>
          {step === "intent" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={pending !== null}
              >
                {t("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void generate()}
                disabled={pending !== null}
              >
                <Sparkles className="size-3.5" />
                {pending === "draft" ? t("generating") : t("generate")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setStep("intent");
                  setError(null);
                }}
                disabled={pending !== null}
              >
                <ArrowLeft className="size-3.5" />
                {t("back")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void generate()}
                disabled={pending !== null}
              >
                <RefreshCw className="size-3.5" />
                {t("regenerate")}
              </Button>
              <Button
                size="sm"
                onClick={() => void start()}
                disabled={pending !== null}
              >
                <Play className="size-3.5" />
                {pending === "start" ? t("starting") : t("approve")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
      {message}
    </div>
  );
}
