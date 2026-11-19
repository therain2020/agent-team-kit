"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CostOverview } from "@/lib/costs";
import { formatCny } from "@/lib/utils";
import { useTranslations } from "next-intl";

export function CostAttribution({ overview }: { overview: CostOverview }) {
  const t = useTranslations("costs");
  const reconcileVariant = overview.reconciliation.ok ? "success" : "danger";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t("windowCost", { days: overview.windowDays })}
          value={formatCny(overview.totalCny)}
        />
        <Stat
          label={t("unitCost")}
          value={`${formatCny(overview.unitCost.averageCny)} / ${overview.unitCost.artifactCount}`}
        />
        <Stat
          label={t("untracked")}
          value={String(overview.untrackedCalls)}
          variant={overview.untrackedCalls > 0 ? "warning" : "success"}
          note={t("untrackedHint")}
        />
        <Stat
          label={t("reconcile")}
          value={
            overview.reconciliation.hasBills
              ? `${(overview.reconciliation.diffRatio * 100).toFixed(2)}%`
              : t("noBills")
          }
          variant={
            overview.reconciliation.hasBills ? reconcileVariant : "warning"
          }
          note={t("reconcileHint")}
        />
      </div>

      {overview.anomalies.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("anomaliesTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {overview.anomalies.map((anomaly) => (
              <div
                key={anomaly.dayKey}
                className="flex flex-wrap items-center gap-3 border-t border-zinc-800/60 py-1.5 text-zinc-300"
              >
                <Badge variant="warning">z {anomaly.zScore}</Badge>
                <span className="font-mono">{anomaly.dayKey}</span>
                <span>
                  {formatCny(anomaly.costCny)} ·{" "}
                  {t("baseline", { value: formatCny(anomaly.baselineMeanCny) })}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("dailyTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {overview.daily.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("empty")}</p>
          ) : (
            <table className="min-w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">{t("day")}</th>
                  <th className="py-2 pr-4">{t("cost")}</th>
                  <th className="py-2 pr-4">{t("calls")}</th>
                  <th className="py-2 pr-4">{t("untracked")}</th>
                  <th className="py-2">{t("tokens")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.daily.map((row) => (
                  <tr
                    key={row.dayKey}
                    className="border-t border-zinc-800/60 text-zinc-300"
                  >
                    <td className="py-2 pr-4 font-mono">{row.dayKey}</td>
                    <td className="py-2 pr-4">{formatCny(row.costCny)}</td>
                    <td className="py-2 pr-4">{row.trackedCalls}</td>
                    <td className="py-2 pr-4">{row.untrackedCalls}</td>
                    <td className="py-2 font-mono">
                      {row.tokensIn + row.tokensOut}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("artifactsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {overview.unitCost.artifacts.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("empty")}</p>
          ) : (
            <table className="min-w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">{t("artifact")}</th>
                  <th className="py-2 pr-4">{t("stage")}</th>
                  <th className="py-2 pr-4">{t("cost")}</th>
                  <th className="py-2">{t("calls")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.unitCost.artifacts.map((artifact) => (
                  <tr
                    key={`${artifact.artifactId}:${artifact.runId}`}
                    className="border-t border-zinc-800/60 text-zinc-300"
                  >
                    <td className="py-2 pr-4 font-mono">
                      {artifact.artifactId}
                    </td>
                    <td className="py-2 pr-4 font-mono">
                      {artifact.stageId ?? "—"}
                    </td>
                    <td className="py-2 pr-4">{formatCny(artifact.costCny)}</td>
                    <td className="py-2">{artifact.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("reconcileTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="mb-2 text-[11px] text-zinc-500">{t("reconcileDesc")}</p>
          {overview.reconciliation.rows.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("noBills")}</p>
          ) : (
            <table className="min-w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">{t("provider")}</th>
                  <th className="py-2 pr-4">{t("ledger")}</th>
                  <th className="py-2 pr-4">{t("billed")}</th>
                  <th className="py-2 pr-4">{t("variance")}</th>
                  <th className="py-2">{t("status")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.reconciliation.rows.map((row) => (
                  <tr
                    key={row.provider}
                    className="border-t border-zinc-800/60 text-zinc-300"
                  >
                    <td className="py-2 pr-4 font-mono">{row.provider}</td>
                    <td className="py-2 pr-4">{formatCny(row.ledgerCny)}</td>
                    <td className="py-2 pr-4">{formatCny(row.billedCny)}</td>
                    <td className="py-2 pr-4">
                      {(row.diffRatio * 100).toFixed(2)}%
                    </td>
                    <td className="py-2">
                      <Badge variant={row.ok ? "success" : "danger"}>
                        {row.ok ? t("withinTolerance") : t("outOfTolerance")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {overview.bills.length > 0 ? (
            <ul className="mt-3 space-y-1 text-[11px] text-zinc-500">
              {overview.bills.map((bill) => (
                <li key={`${bill.provider}:${bill.periodStart}:${bill.source}`}>
                  {bill.provider} · {bill.periodStart} → {bill.periodEnd} ·{" "}
                  {formatCny(bill.amountCny)} · {bill.source}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  variant,
}: {
  label: string;
  value: string;
  note?: string;
  variant?: "success" | "warning" | "danger";
}) {
  const tone =
    variant === "danger"
      ? "text-rose-400"
      : variant === "warning"
        ? "text-amber-400"
        : "text-zinc-100";
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">
          {label}
        </p>
        <p className={`font-mono text-lg ${tone}`}>{value}</p>
        {note ? <p className="text-[11px] text-zinc-500">{note}</p> : null}
      </CardContent>
    </Card>
  );
}
