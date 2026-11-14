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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { EvolutionCycleRecord } from "@kit/evolution";
import { ArrowLeft, Play, RefreshCw, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const SAMPLE = `{"sources":[{"citationId":"S1","title":"Example evidence","url":"https://example.com/a","publishedAt":"2026-11-14","summary":"A verifiable example item."},{"citationId":"S2","title":"Second source","url":"https://example.com/b","summary":"A second independent item."}],"errors":[]}`;

interface Draft {
  packDir: string;
  agentId: string;
  hypothesis: string;
  stub: boolean;
  autoApply: boolean;
  force: boolean;
}

export function EvolutionCycleDialog({
  packs,
}: {
  packs: Array<{ dirName: string; name: string }>;
}) {
  const t = useTranslations("evolutionCycle");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"intent" | "review">("intent");
  const [packDir, setPackDir] = useState(packs[0]?.dirName ?? "");
  const [intent, setIntent] = useState("");
  const [evidence, setEvidence] = useState(SAMPLE);
  const [agentId, setAgentId] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [stub, setStub] = useState(true);
  const [autoApply, setAutoApply] = useState(false);
  const [force, setForce] = useState(true);
  const [rationale, setRationale] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [model, setModel] = useState<"live" | "heuristic">("heuristic");
  const [pending, setPending] = useState<"draft" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvolutionCycleRecord | null>(null);

  function reset() {
    setStep("intent");
    setIntent("");
    setHypothesis("");
    setRationale("");
    setWarnings([]);
    setError(null);
    setResult(null);
  }

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
        body: JSON.stringify({
          kind: "evolutionCycle",
          intent: intent.trim(),
          packDir,
        }),
      });
      const payload = (await response.json()) as {
        values?: Draft;
        rationale?: string;
        warnings?: string[];
        model?: "live" | "heuristic";
        error?: string;
      };
      if (!response.ok || !payload.values) {
        throw new Error(payload.error ?? t("failed"));
      }
      setAgentId(payload.values.agentId);
      setHypothesis(payload.values.hypothesis);
      setStub(payload.values.stub);
      setAutoApply(payload.values.autoApply);
      setForce(payload.values.force);
      setRationale(payload.rationale ?? "");
      setWarnings(payload.warnings ?? []);
      setModel(payload.model === "live" ? "live" : "heuristic");
      setStep("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      setPending(null);
    }
  }

  async function run() {
    if (!evidence.trim()) {
      setError(t("evidenceRequired"));
      return;
    }
    setError(null);
    setPending("run");
    try {
      const response = await fetch("/api/evolution/cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packDir,
          agentId: agentId.trim() || undefined,
          hypothesis: hypothesis.trim() || undefined,
          evidenceText: evidence,
          stub,
          autoApply,
          force,
        }),
      });
      const payload = (await response.json()) as {
        record?: EvolutionCycleRecord;
        error?: string;
      };
      if (!response.ok || !payload.record) {
        throw new Error(payload.error ?? t("failed"));
      }
      setResult(payload.record);
      toast.success(t("done", { decision: payload.record.decision }), {
        description: payload.record.rationale,
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("failed"));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={packs.length === 0}
      >
        <Sparkles className="size-3.5" />
        {t("button")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            reset();
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {step === "intent" ? t("description") : t("reviewDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
            {step === "intent" ? (
              <>
                <label
                  htmlFor="cycle-pack"
                  className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
                >
                  {t("pack")}
                  <select
                    id="cycle-pack"
                    value={packDir}
                    onChange={(event) => setPackDir(event.target.value)}
                    className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-xs text-zinc-200"
                  >
                    {packs.map((pack) => (
                      <option key={pack.dirName} value={pack.dirName}>
                        {pack.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label
                  htmlFor="cycle-intent"
                  className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
                >
                  {t("intent")}
                  <Textarea
                    id="cycle-intent"
                    value={intent}
                    onChange={(event) => setIntent(event.target.value)}
                    placeholder={t("intentPlaceholder")}
                    className="min-h-20 text-sm"
                  />
                </label>

                <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  <div className="flex items-center justify-between">
                    <span id="cycle-evidence-label">{t("evidence")}</span>
                    <button
                      type="button"
                      onClick={() => setEvidence(SAMPLE)}
                      className="text-[10px] normal-case text-emerald-300 hover:underline"
                    >
                      {t("sample")}
                    </button>
                  </div>
                  <Textarea
                    aria-labelledby="cycle-evidence-label"
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    rows={6}
                    className="font-mono text-[10px]"
                  />
                  <p className="text-[10px] normal-case text-zinc-600">
                    {t("evidenceHint")}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                    <Badge variant="violet">{packDir}</Badge>
                    <Badge variant={model === "live" ? "success" : "outline"}>
                      {model === "live"
                        ? t("aiProposal")
                        : t("heuristicProposal")}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-sm text-zinc-200">{intent}</p>
                  <p className="mt-1 text-[11px] text-zinc-400">{rationale}</p>
                </div>

                {warnings.length > 0 ? (
                  <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
                    {warnings.map((warning) => (
                      <li key={warning}>· {warning}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <label
                    htmlFor="cycle-agent"
                    className="block space-y-1 text-[10px] uppercase tracking-wider text-zinc-500"
                  >
                    {t("agent")}
                    <Input
                      id="cycle-agent"
                      value={agentId}
                      onChange={(event) => setAgentId(event.target.value)}
                      placeholder={t("agentPlaceholder")}
                      className="font-mono"
                    />
                  </label>
                  <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    <span id="cycle-hypothesis-label">{t("hypothesis")}</span>
                    <Textarea
                      aria-labelledby="cycle-hypothesis-label"
                      value={hypothesis}
                      onChange={(event) => setHypothesis(event.target.value)}
                      rows={3}
                      className="text-[11px]"
                    />
                  </div>
                </div>

                <div className="space-y-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  <span id="cycle-review-evidence-label">{t("evidence")}</span>
                  <Textarea
                    aria-labelledby="cycle-review-evidence-label"
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    rows={5}
                    className="font-mono text-[10px]"
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-[11px] text-zinc-300">
                    <input
                      type="checkbox"
                      checked={stub}
                      onChange={(event) => setStub(event.target.checked)}
                      className="mt-0.5 size-3.5 accent-emerald-500"
                    />
                    <span>
                      {t("stub")}
                      <span className="mt-0.5 block text-[10px] text-zinc-600">
                        {t("stubHint")}
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-[11px] text-zinc-300">
                    <input
                      type="checkbox"
                      checked={autoApply}
                      onChange={(event) => setAutoApply(event.target.checked)}
                      className="mt-0.5 size-3.5 accent-amber-500"
                    />
                    <span>
                      {t("autoApply")}
                      <span className="mt-0.5 block text-[10px] text-zinc-600">
                        {t("autoApplyHint")}
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-[11px] text-zinc-300 sm:col-span-2">
                    <input
                      type="checkbox"
                      checked={force}
                      onChange={(event) => setForce(event.target.checked)}
                      className="mt-0.5 size-3.5 accent-emerald-500"
                    />
                    <span>
                      {t("force")}
                      <span className="mt-0.5 block text-[10px] text-zinc-600">
                        {t("forceHint")}
                      </span>
                    </span>
                  </label>
                </div>

                {result ? (
                  <div className="rounded-lg border border-border bg-zinc-950/60 p-3 text-[11px] text-zinc-300">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] text-zinc-500">
                        {result.cycleId}
                      </span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px]">
                        {result.decision}
                      </span>
                      <span className="font-mono text-[10px]">
                        baseline {result.baselineScore?.toFixed(2) ?? "—"} →
                        candidate {result.candidateScore?.toFixed(2) ?? "—"}
                      </span>
                    </div>
                    <p className="mt-1 text-zinc-400">{result.rationale}</p>
                    <p className="mt-1 font-mono text-[10px] text-zinc-600">
                      {result.hypothesis}
                    </p>
                  </div>
                ) : null}
              </>
            )}

            {error ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
                {error}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            {step === "intent" ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={pending !== null}
                >
                  {t("close")}
                </Button>
                <Button
                  onClick={() => void generate()}
                  disabled={pending !== null || !packDir}
                >
                  <Sparkles className="size-3.5" />
                  {pending === "draft" ? t("generating") : t("generate")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
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
                  variant="outline"
                  onClick={() => void generate()}
                  disabled={pending !== null}
                >
                  <RefreshCw className="size-3.5" />
                  {t("regenerate")}
                </Button>
                <Button
                  onClick={() => void run()}
                  disabled={pending !== null || !evidence.trim()}
                >
                  <Play className="size-3.5" />
                  {pending === "run" ? t("running") : t("run")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
