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
import type { CanaryDecision, CanaryEvaluationSummary } from "@kit/evolution";
import { Beaker, Gauge, Rocket, RotateCcw, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const EVIDENCE_PLACEHOLDER =
  '{"sources":[{"citationId":"S1","title":"…","url":"…"}],"errors":[]}';

type Mode = "start" | "traffic" | "evaluate" | "rollback" | "promote" | null;

interface EvaluationResult {
  decision: CanaryDecision;
  evaluation?: CanaryEvaluationSummary;
  evidence?: { generated: boolean; sources: number };
}

export interface VariantOption {
  dirName: string;
  name: string;
  isChampion: boolean;
  isCanary: boolean;
}

export function EvolutionActions({
  variants,
  packs,
  canaryActive,
  canaryPercent,
}: {
  variants: VariantOption[];
  packs: Array<{ dirName: string; name: string }>;
  canaryActive: boolean;
  canaryPercent: number;
}) {
  const t = useTranslations("evolutionActions");
  const common = useTranslations("common");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const champion =
    variants.find((variant) => variant.isChampion)?.dirName ??
    variants.find((variant) => variant.dirName === "baseline")?.dirName ??
    variants[0]?.dirName ??
    "";
  const candidate =
    variants.find((variant) => !variant.isChampion)?.dirName ?? "";

  const [baselineDir, setBaselineDir] = useState(champion);
  const [variantDir, setVariantDir] = useState(candidate);
  const [percent, setPercent] = useState(0);
  const [trafficPercent, setTrafficPercent] = useState(canaryPercent);
  const [evidenceText, setEvidenceText] = useState("");
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [reason, setReason] = useState("");
  const [targetPack, setTargetPack] = useState(packs[0]?.dirName ?? "");
  const [apply, setApply] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as Record<string, unknown> & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error ?? `request failed (${response.status})`);
    }
    return payload;
  }

  async function runAction() {
    setPending(true);
    setError(null);
    try {
      if (mode === "start") {
        await post("/api/evolution/canary/start", {
          baselineDir,
          variantDir,
          percent,
        });
        toast.success(t("canaryStarted"));
      } else if (mode === "traffic") {
        await post("/api/evolution/canary/traffic", {
          percent: trafficPercent,
        });
        toast.success(t("trafficUpdated", { percent: trafficPercent }));
      } else if (mode === "evaluate") {
        const payload = (await post("/api/evolution/canary/evaluate", {
          evidenceText: evidenceText.trim() || undefined,
        })) as {
          decision: CanaryDecision;
          evaluation?: CanaryEvaluationSummary;
          evidence?: { generated: boolean; sources: number };
        };
        setResult({
          decision: payload.decision,
          ...(payload.evaluation ? { evaluation: payload.evaluation } : {}),
          ...(payload.evidence ? { evidence: payload.evidence } : {}),
        });
        if (payload.decision.rollback) {
          toast.error(
            t("rolledBackReason", {
              reason: payload.decision.reason ?? "regression",
            }),
          );
        } else {
          toast.success(t("canaryPassed"));
        }
        router.refresh();
        return;
      } else if (mode === "rollback") {
        await post("/api/evolution/canary/rollback", {
          reason: reason || t("reasonPlaceholder"),
        });
        toast.success(t("rollbackDone"));
      } else if (mode === "promote") {
        const payload = await post("/api/evolution/promote", {
          variantDir,
          targetDir: targetPack,
          apply,
          confirmation,
        });
        const files = Array.isArray(payload.files)
          ? (payload.files as string[]).join(", ")
          : "";
        if (apply) {
          toast.success(
            t("promotedResult", {
              pack: targetPack,
              backup: payload.backupDir
                ? ` Backup: ${String(payload.backupDir)}`
                : "",
            }),
          );
        } else {
          toast.success(t("dryRunResult", { files: files || common("none") }));
        }
      }
      setMode(null);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : t("actionFailed"),
      );
    } finally {
      setPending(false);
    }
  }

  const canStart = variants.length >= 2 && baselineDir && variantDir;
  const canEvaluate = canaryActive;
  const canPromote = variants.length > 0 && packs.length > 0 && variantDir;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMode("start")}
          disabled={!canStart}
        >
          <Beaker className="size-3.5" />
          {t("startCanary")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setTrafficPercent(canaryPercent);
            setMode("traffic");
          }}
          disabled={!canaryActive}
        >
          <Gauge className="size-3.5" />
          {t("traffic")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setResult(null);
            setMode("evaluate");
          }}
          disabled={!canEvaluate}
        >
          <ShieldCheck className="size-3.5" />
          {t("evaluate")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMode("rollback")}
          disabled={!canaryActive}
        >
          <RotateCcw className="size-3.5" />
          {t("rollback")}
        </Button>
        <Button
          size="sm"
          onClick={() => setMode("promote")}
          disabled={!canPromote}
        >
          <Rocket className="size-3.5" />
          {t("promote")}
        </Button>
      </div>

      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setMode(null);
            setError(null);
            setResult(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {mode === "start"
                ? t("startTitle")
                : mode === "traffic"
                  ? t("trafficTitle")
                  : mode === "evaluate"
                    ? t("evaluateTitle")
                    : mode === "rollback"
                      ? t("rollbackTitle")
                      : t("promoteTitle")}
            </DialogTitle>
            <DialogDescription>
              {mode === "start"
                ? t("startDesc")
                : mode === "traffic"
                  ? t("trafficDesc")
                  : mode === "evaluate"
                    ? t("evaluateDesc")
                    : mode === "rollback"
                      ? t("rollbackDesc")
                      : t("promoteDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {mode === "start" ? (
              <>
                <Field label={t("championBaseline")}>
                  <Select
                    value={baselineDir}
                    onChange={setBaselineDir}
                    options={variants.map((variant) => ({
                      value: variant.dirName,
                      label: `${variant.name}${variant.isChampion ? ` · ${common("champion")}` : ""}`,
                    }))}
                  />
                </Field>
                <Field label={t("candidate")}>
                  <Select
                    value={variantDir}
                    onChange={setVariantDir}
                    options={variants
                      .filter((variant) => variant.dirName !== baselineDir)
                      .map((variant) => ({
                        value: variant.dirName,
                        label: variant.name,
                      }))}
                  />
                </Field>
                <Field label={t("trafficPercentLabel", { percent })}>
                  <input
                    type="range"
                    min={0}
                    max={99}
                    value={percent}
                    onChange={(event) => setPercent(Number(event.target.value))}
                    className="w-full accent-emerald-500"
                  />
                </Field>
              </>
            ) : null}

            {mode === "traffic" ? (
              <Field
                label={t("trafficPercentLabel", { percent: trafficPercent })}
              >
                <input
                  type="range"
                  min={0}
                  max={99}
                  value={trafficPercent}
                  onChange={(event) =>
                    setTrafficPercent(Number(event.target.value))
                  }
                  className="w-full accent-emerald-500"
                />
              </Field>
            ) : null}

            {mode === "evaluate" ? (
              <>
                <Field label={t("evidenceOptional")}>
                  <Textarea
                    value={evidenceText}
                    onChange={(event) => setEvidenceText(event.target.value)}
                    placeholder={EVIDENCE_PLACEHOLDER}
                    className="min-h-32 font-mono text-[11px]"
                  />
                </Field>
                <p className="text-[10px] text-zinc-500">
                  {t("evidenceOptionalHint")}
                </p>
                {result ? (
                  <div className="rounded-lg border border-border bg-zinc-950/60 p-3 text-[11px] text-zinc-300">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${
                          result.decision.rollback
                            ? "border-red-500/40 text-red-300"
                            : "border-emerald-500/40 text-emerald-300"
                        }`}
                      >
                        {result.decision.rollback
                          ? t("evaluationRolledBack")
                          : t("evaluationPassed")}
                      </span>
                      {result.evidence ? (
                        <span className="text-[10px] text-zinc-500">
                          {result.evidence.generated
                            ? t("autoEvidence")
                            : t("manualEvidence")}{" "}
                          ·{" "}
                          {t("evidenceSources", {
                            count: result.evidence.sources,
                          })}
                        </span>
                      ) : null}
                    </div>
                    {result.evaluation ? (
                      <div className="mt-2 space-y-1">
                        <p>
                          {t("championScore")}:{" "}
                          <span className="font-mono text-zinc-100">
                            {result.evaluation.champion.averageScore.toFixed(2)}
                          </span>{" "}
                          · {t("passRate")}{" "}
                          <span className="font-mono text-zinc-100">
                            {result.evaluation.champion.passRate.toFixed(2)}
                          </span>
                        </p>
                        <p>
                          {t("candidateScore")}:{" "}
                          <span className="font-mono text-zinc-100">
                            {result.evaluation.candidate.averageScore.toFixed(
                              2,
                            )}
                          </span>{" "}
                          · {t("passRate")}{" "}
                          <span className="font-mono text-zinc-100">
                            {result.evaluation.candidate.passRate.toFixed(2)}
                          </span>
                        </p>
                        <p className="font-mono text-[10px] text-zinc-400">
                          Δ score {signed(result.evaluation.delta.score)} · Δ
                          pass rate {signed(result.evaluation.delta.passRate)} ·
                          cost {result.evaluation.delta.costRatio.toFixed(2)}×
                        </p>
                        <p className="text-[10px] text-zinc-500">
                          {t("thresholds")}:{" "}
                          {t("thresholdScore", {
                            value: signed(-result.evaluation.thresholds.score),
                          })}{" "}
                          ·{" "}
                          {t("thresholdPassRate", {
                            value: signed(
                              -result.evaluation.thresholds.passRate,
                            ),
                          })}{" "}
                          ·{" "}
                          {t("thresholdCost", {
                            value:
                              result.evaluation.thresholds.costMultiplier.toFixed(
                                1,
                              ),
                          })}
                        </p>
                      </div>
                    ) : null}
                    {result.decision.reason ? (
                      <p className="mt-1 text-[10px] text-zinc-500">
                        {result.decision.reason}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {mode === "rollback" ? (
              <Field label={t("reason")}>
                <Input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={t("reasonPlaceholder")}
                />
              </Field>
            ) : null}

            {mode === "promote" ? (
              <>
                <Field label={t("variant")}>
                  <Select
                    value={variantDir}
                    onChange={setVariantDir}
                    options={variants
                      .filter((variant) => !variant.isChampion)
                      .map((variant) => ({
                        value: variant.dirName,
                        label: variant.name,
                      }))}
                  />
                </Field>
                <Field label={t("targetPack")}>
                  <Select
                    value={targetPack}
                    onChange={setTargetPack}
                    options={packs.map((pack) => ({
                      value: pack.dirName,
                      label: `${pack.name} (${pack.dirName})`,
                    }))}
                  />
                </Field>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={apply}
                    onChange={(event) => setApply(event.target.checked)}
                    className="size-3.5 accent-emerald-500"
                  />
                  {t("applyChanges")}
                </label>
                {apply ? (
                  <Field label={t("typePromote")}>
                    <Input
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      placeholder="PROMOTE"
                    />
                  </Field>
                ) : null}
              </>
            ) : null}

            {error ? (
              <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMode(null)}
              disabled={pending}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={runAction}
              disabled={
                pending ||
                (mode === "evaluate" && !canEvaluate) ||
                (mode === "promote" &&
                  (apply ? confirmation !== "PROMOTE" : false))
              }
            >
              {pending
                ? t("working")
                : mode === "start"
                  ? t("startButton")
                  : mode === "traffic"
                    ? t("trafficButton")
                    : mode === "evaluate"
                      ? t("evaluateButton")
                      : mode === "rollback"
                        ? t("rollbackButton")
                        : apply
                          ? t("applyPromotion")
                          : t("dryRunPromotion")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-zinc-300">{label}</p>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full rounded-md border border-border bg-zinc-950 px-2 text-sm text-zinc-200 outline-none focus:border-ring"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
