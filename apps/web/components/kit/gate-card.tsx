"use client";

import { Badge } from "@/components/ui/badge";
import type { GateResult } from "@/lib/runs";
import { cn, formatCny } from "@/lib/utils";
import { ShieldCheck, ShieldX } from "lucide-react";
import { useTranslations } from "next-intl";

export function GateCard({ gate }: { gate: GateResult }) {
  const t = useTranslations("gate");
  const dimensions = Object.keys(gate.scores);

  return (
    <div className="border border-px-line bg-px-ink/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-px-line bg-px-panel2/60 px-3 py-2">
        {gate.pass ? (
          <ShieldCheck className="size-4 text-px-ok" />
        ) : (
          <ShieldX className="size-4 text-px-danger" />
        )}
        <span className="font-mono text-[11px] font-bold tracking-[0.08em] text-px-text">
          {t("attempt", { attempt: gate.attempt })}
        </span>
        <Badge variant={gate.pass ? "success" : "danger"}>
          {gate.pass ? t("pass") : t("fail")}
        </Badge>
        <span className="font-mono text-[10px] text-px-muted">
          {t("judge", {
            model: gate.judgeModel,
            cost: formatCny(gate.costCny),
          })}
        </span>
        <span className="ml-auto font-mono text-[10px] text-px-faint">
          {gate.stageId}
        </span>
      </div>
      <div className="grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          {dimensions.length === 0 ? (
            <p className="text-xs text-px-muted">{t("noScores")}</p>
          ) : (
            dimensions.map((name) => {
              const score = gate.scores[name] ?? 0;
              const threshold = gate.thresholds[name] ?? 0;
              const passed = score >= threshold;
              return (
                <div
                  key={name}
                  className="grid grid-cols-[9rem_1fr_3.5rem] items-center gap-2"
                >
                  <span className="truncate font-mono text-[10.5px] text-px-muted">
                    {name}
                  </span>
                  <div className="relative h-2 overflow-hidden border border-px-line bg-px-ink">
                    <div
                      className={cn(
                        "h-full",
                        passed ? "bg-emerald-400" : "bg-red-400",
                      )}
                      style={{
                        width: `${Math.min(100, Math.max(0, score * 100))}%`,
                      }}
                    />
                    <span
                      className="absolute top-0 h-full w-0.5 bg-px-cream"
                      style={{
                        left: `${Math.min(100, Math.max(0, threshold * 100))}%`,
                      }}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-right font-mono text-[10.5px] tabular-nums",
                      passed ? "text-emerald-300" : "text-red-300",
                    )}
                  >
                    {score.toFixed(2)}
                    <span className="text-px-faint">
                      /{threshold.toFixed(2)}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </div>
        {gate.rationale ? (
          <p className="max-w-sm text-[11px] leading-5 text-px-muted sm:text-right">
            {gate.rationale}
          </p>
        ) : null}
      </div>
    </div>
  );
}
