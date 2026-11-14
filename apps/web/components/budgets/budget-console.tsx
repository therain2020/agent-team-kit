"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BudgetOverview, BudgetView } from "@/lib/budgets";
import { formatCny } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";

export function BudgetConsole({ overview }: { overview: BudgetOverview }) {
  const t = useTranslations("budgets");
  const router = useRouter();
  const eligible = useMemo(
    () => overview.budgets.filter((budget) => budget.limitCny !== null),
    [overview.budgets],
  );
  const [budgetId, setBudgetId] = useState(eligible[0]?.budgetId ?? "");
  const [amount, setAmount] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function increase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budgetId) {
      toast.error(t("noBudgets"));
      return;
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error(t("increaseFailed"));
      return;
    }
    if (!reason.trim()) {
      toast.error(t("reasonRequired"));
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/budgets/${encodeURIComponent(budgetId)}/increase`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cny: value, reason: reason.trim() }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? t("increaseFailed"));
      }
      toast.success(t("increaseSuccess"));
      setReason("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("increaseFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("increaseTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-zinc-500">{t("increaseHint")}</p>
          <form
            onSubmit={increase}
            className="flex flex-wrap items-end gap-3 text-xs"
          >
            <label className="flex flex-col gap-1 text-zinc-400">
              {t("budget")}
              <select
                value={budgetId}
                onChange={(event) => setBudgetId(event.target.value)}
                className="min-w-64 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-zinc-200"
              >
                {eligible.map((budget) => (
                  <option key={budget.budgetId} value={budget.budgetId}>
                    {budget.scope} · {budget.targetKey}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-zinc-400">
              {t("amountCny")}
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-32 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-zinc-200"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-zinc-400">
              {t("reason")}
              <input
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-zinc-200"
              />
            </label>
            <Button type="submit" disabled={busy || eligible.length === 0}>
              {t("increaseAction")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("tableTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {overview.budgets.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("noBudgets")}</p>
          ) : (
            <table className="min-w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">{t("scope")}</th>
                  <th className="py-2 pr-4">{t("target")}</th>
                  <th className="py-2 pr-4">{t("limit")}</th>
                  <th className="py-2 pr-4">{t("spent")}</th>
                  <th className="py-2 pr-4">{t("reserved")}</th>
                  <th className="py-2 pr-4">{t("used")}</th>
                  <th className="py-2">{t("status")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.budgets.map((budget) => (
                  <BudgetRow key={budget.budgetId} budget={budget} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("chargesTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {overview.charges.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("noBudgets")}</p>
          ) : (
            <table className="min-w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 pr-4">{t("chargeRun")}</th>
                  <th className="py-2 pr-4">{t("chargeStage")}</th>
                  <th className="py-2 pr-4">{t("chargePurpose")}</th>
                  <th className="py-2 pr-4">{t("chargeCost")}</th>
                  <th className="py-2">{t("chargeTokens")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.charges.map((charge) => (
                  <tr
                    key={charge.chargeId}
                    className="border-t border-zinc-800/60 text-zinc-300"
                  >
                    <td className="py-2 pr-4 font-mono">{charge.runId}</td>
                    <td className="py-2 pr-4">{charge.stageId ?? "—"}</td>
                    <td className="py-2 pr-4">{charge.purpose}</td>
                    <td className="py-2 pr-4">{formatCny(charge.costCny)}</td>
                    <td className="py-2">{charge.tokens}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BudgetRow({ budget }: { budget: BudgetView }) {
  const t = useTranslations("budgets");
  const variant = budget.exceeded
    ? "danger"
    : budget.alert
      ? "warning"
      : "success";
  const label = budget.exceeded
    ? t("statusExceeded")
    : budget.alert
      ? t("statusWarning")
      : t("statusOk");
  return (
    <tr className="border-t border-zinc-800/60 text-zinc-300">
      <td className="py-2 pr-4 font-mono">{budget.scope}</td>
      <td className="py-2 pr-4 font-mono">{budget.targetKey}</td>
      <td className="py-2 pr-4">
        {budget.limitCny === null ? "—" : formatCny(budget.limitCny)}
        {budget.limitTokens !== null ? ` / ${budget.limitTokens} tok` : ""}
      </td>
      <td className="py-2 pr-4">{formatCny(budget.spentCny)}</td>
      <td className="py-2 pr-4">{formatCny(budget.reservedCny)}</td>
      <td className="py-2 pr-4">
        {budget.percent === null ? "—" : `${budget.percent}%`}
        {budget.limitTokens !== null ? ` · ${budget.usedTokens} tok` : ""}
      </td>
      <td className="py-2">
        <Badge variant={variant}>{label}</Badge>
      </td>
    </tr>
  );
}
