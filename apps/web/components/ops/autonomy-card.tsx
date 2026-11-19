"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OpsAutonomyView } from "@/lib/ops";
import { Gauge } from "lucide-react";
import { useTranslations } from "next-intl";

export function AutonomyCard({ autonomy }: { autonomy: OpsAutonomyView }) {
  const t = useTranslations("ops");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-emerald-400" />
          {t("autonomyTitle")}
          <Badge
            variant={
              autonomy.level === "self-hosted-live" ? "success" : "outline"
            }
          >
            {t(`autonomyLevel_${autonomy.level}`)}
          </Badge>
        </CardTitle>
        <CardDescription>{t("autonomyDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-zinc-300">
        {autonomy.preset ? (
          <>
            <p className="font-mono text-xs text-zinc-400">
              {autonomy.preset.presetId}
            </p>
            <p className="text-xs text-zinc-500">
              {t("autonomyApplied", {
                actor: autonomy.preset.appliedBy,
                time: autonomy.preset.appliedAt,
              })}
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              <span>
                {t("autonomyApplyMode", {
                  mode: autonomy.preset.config.applyMode,
                })}
              </span>
              <span>
                {t("autonomyBudget", {
                  cny: autonomy.preset.config.dailyCostCny,
                  runs: autonomy.preset.config.dailyRuns,
                })}
              </span>
              <span>
                {t("autonomyMaxTasks", {
                  count: autonomy.preset.config.maxTasks,
                })}
              </span>
              <span>
                {t("autonomyNightException", {
                  state: autonomy.preset.config.allowNight
                    ? t("autonomyOn")
                    : t("autonomyOff"),
                })}
              </span>
            </div>
            <p className="text-xs text-zinc-500">{t("autonomyRollbackHint")}</p>
          </>
        ) : (
          <>
            <p className="text-xs text-zinc-500">{t("autonomyManualHint")}</p>
            {!autonomy.liveAllowed ? (
              <p className="text-xs text-amber-300">
                {t("autonomyLiveClosed")}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
