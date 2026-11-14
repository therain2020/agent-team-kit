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
    <div className="rounded-md border border-border bg-zinc-950/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {gate.pass ? (
          <ShieldCheck className="size-4 text-emerald-400" />
        ) : (
          <ShieldX className="size-4 text-red-400" />
        )}
        <span className="text-xs font-medium text-zinc-200">
          {t("attempt", { attempt: gate.attempt })}
        </span>
        <Badge variant={gate.pass ? "success" : "danger"}>
          {gate.pass ? t("pass") : t("fail")}
        </Badge>
        <span className="text-[11px] text-zinc-500">
          {t("judge", {
            model: gate.judgeModel,
            cost: formatCny(gate.costCny),
          })}
        </span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {gate.stageId}
        </span>
      </div>
      <div className="grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-2">
          {dimensions.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("noScores")}</p>
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
                  <span className="truncate text-[11px] text-zinc-400">
                    {name}
                  </span>
                  <div className="relative h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        passed ? "bg-emerald-500/70" : "bg-red-500/70",
                      )}
                      style={{
                        width: `${Math.min(100, Math.max(0, score * 100))}%`,
                      }}
                    />
                    <span
                      className="absolute top-[-2px] h-2.5 w-px bg-zinc-400"
                      style={{
                        left: `${Math.min(100, Math.max(0, threshold * 100))}%`,
                      }}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-right font-mono text-[11px]",
                      passed ? "text-emerald-300" : "text-red-300",
                    )}
                  >
                    {score.toFixed(2)}
                    <span className="text-zinc-600">
                      /{threshold.toFixed(2)}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </div>
        {gate.rationale ? (
          <p className="max-w-sm text-[11px] leading-5 text-zinc-500 sm:text-right">
            {gate.rationale}
          </p>
        ) : null}
      </div>
    </div>
  );
}
