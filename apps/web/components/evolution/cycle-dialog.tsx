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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { EvolutionCycleRecord } from "@kit/evolution";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const SAMPLE = `{"sources":[{"citationId":"S1","title":"Example evidence","url":"https://example.com/a","publishedAt":"2026-11-14","summary":"A verifiable example item."},{"citationId":"S2","title":"Second source","url":"https://example.com/b","summary":"A second independent item."}],"errors":[]}`;

export function EvolutionCycleDialog({
  packs,
}: {
  packs: Array<{ dirName: string; name: string }>;
}) {
  const t = useTranslations("evolutionCycle");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [packDir, setPackDir] = useState(packs[0]?.dirName ?? "");
  const [agentId, setAgentId] = useState("");
  const [evidence, setEvidence] = useState(SAMPLE);
  const [stub, setStub] = useState(true);
  const [autoApply, setAutoApply] = useState(false);
  const [force, setForce] = useState(true);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<EvolutionCycleRecord | null>(null);

  async function run() {
    setPending(true);
    setResult(null);
    try {
      const response = await fetch("/api/evolution/cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          packDir,
          agentId: agentId.trim() || undefined,
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("failed"));
    } finally {
      setPending(false);
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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
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
            </div>

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
                rows={8}
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
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("close")}
            </Button>
            <Button
              onClick={run}
              disabled={pending || !packDir || !evidence.trim()}
            >
              {pending ? t("running") : t("run")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
