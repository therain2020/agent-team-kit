"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { AlertChannel, AlertTier, OnCallPolicy, OpsGate } from "@kit/ops";
import { Check, RadioTower } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const TIERS: AlertTier[] = ["P0", "P1", "P2", "P3"];
const CHANNELS: AlertChannel[] = ["im", "email"];

export function OpsPolicyForm({
  initialPolicy,
  initialGate,
}: {
  initialPolicy: OnCallPolicy;
  initialGate: OpsGate;
}) {
  const t = useTranslations("ops");
  const router = useRouter();
  const [policy, setPolicy] = useState<OnCallPolicy>(initialPolicy);
  const [gate, setGate] = useState<OpsGate>(initialGate);
  const [saving, setSaving] = useState(false);

  function toggleChannel(
    tier: AlertTier,
    channel: AlertChannel,
    enabled: boolean,
  ) {
    setPolicy((current) => {
      const existing = current.channels[tier];
      const next = enabled
        ? [...existing, channel]
        : existing.filter((item) => item !== channel);
      return {
        ...current,
        channels: { ...current.channels, [tier]: next },
      };
    });
  }

  function patchNightMode(next: Partial<OnCallPolicy["nightMode"]>) {
    setPolicy((current) => ({
      ...current,
      nightMode: { ...current.nightMode, ...next },
    }));
  }

  function toggleQuietWindow(enabled: boolean) {
    setPolicy((current) => ({
      ...current,
      quietWindow: enabled
        ? {
            start: current.quietWindow?.start ?? "23:00",
            end: current.quietWindow?.end ?? "07:00",
            timezone: current.nightMode.timezone,
          }
        : null,
    }));
  }

  function patchQuietWindow(
    next: Partial<NonNullable<OnCallPolicy["quietWindow"]>>,
  ) {
    setPolicy((current) =>
      current.quietWindow
        ? {
            ...current,
            quietWindow: { ...current.quietWindow, ...next },
          }
        : current,
    );
  }

  function setTierMinutes(
    field: "aggregationMinutes" | "ackSlaMinutes",
    tier: AlertTier,
    value: number,
  ) {
    setPolicy((current) => {
      if (field === "aggregationMinutes") {
        return {
          ...current,
          aggregationMinutes: {
            ...current.aggregationMinutes,
            [tier]: value,
          },
        };
      }
      return {
        ...current,
        ackSlaMinutes: { ...current.ackSlaMinutes, [tier]: value },
      };
    });
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/ops/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(policy),
      });
      const payload = (await response.json()) as {
        policy?: OnCallPolicy;
        gate?: OpsGate;
        error?: string;
      };
      if (!response.ok || !payload.policy || !payload.gate) {
        throw new Error(payload.error ?? t("saveFailed"));
      }
      setPolicy(payload.policy);
      setGate(payload.gate);
      toast.success(t("saved"));
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RadioTower className="size-4 text-sky-400" />
          {t("policyTitle")}
        </CardTitle>
        <CardDescription>{t("policyDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            {t("channelsTitle")}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 pr-4 font-medium">{t("tier")}</th>
                  {CHANNELS.map((channel) => (
                    <th key={channel} className="pb-2 pr-4 font-medium">
                      {t(channel)}
                    </th>
                  ))}
                  <th className="pb-2 pr-4 font-medium">{t("aggregation")}</th>
                  <th className="pb-2 font-medium">{t("ackSla")}</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((tier) => (
                  <tr key={tier} className="border-t border-border/60">
                    <td className="py-2 pr-4 font-mono text-xs text-zinc-200">
                      {tier}
                    </td>
                    {CHANNELS.map((channel) => (
                      <td key={channel} className="py-2 pr-4">
                        <input
                          type="checkbox"
                          aria-label={`${tier} ${t(channel)}`}
                          checked={policy.channels[tier].includes(channel)}
                          onChange={(event) =>
                            toggleChannel(tier, channel, event.target.checked)
                          }
                          className="size-4 accent-emerald-500"
                        />
                      </td>
                    ))}
                    <td className="py-2 pr-4">
                      <Input
                        type="number"
                        min={0}
                        value={policy.aggregationMinutes[tier]}
                        onChange={(event) =>
                          setTierMinutes(
                            "aggregationMinutes",
                            tier,
                            Math.max(0, Number(event.target.value) || 0),
                          )
                        }
                        className="h-8 w-24"
                      />
                    </td>
                    <td className="py-2">
                      <Input
                        type="number"
                        min={1}
                        value={policy.ackSlaMinutes[tier]}
                        onChange={(event) =>
                          setTierMinutes(
                            "ackSlaMinutes",
                            tier,
                            Math.max(1, Number(event.target.value) || 1),
                          )
                        }
                        className="h-8 w-24"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-border px-4 py-3">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="checkbox"
                checked={policy.nightMode.enabled}
                onChange={(event) =>
                  patchNightMode({ enabled: event.target.checked })
                }
                className="size-4 accent-emerald-500"
              />
              {t("nightModeEnabled")}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                htmlFor="ops-night-start"
                className="space-y-1 text-xs text-zinc-500"
              >
                <span>{t("start")}</span>
                <Input
                  id="ops-night-start"
                  type="time"
                  value={policy.nightMode.start}
                  onChange={(event) =>
                    patchNightMode({ start: event.target.value })
                  }
                  disabled={!policy.nightMode.enabled}
                />
              </label>
              <label
                htmlFor="ops-night-end"
                className="space-y-1 text-xs text-zinc-500"
              >
                <span>{t("end")}</span>
                <Input
                  id="ops-night-end"
                  type="time"
                  value={policy.nightMode.end}
                  onChange={(event) =>
                    patchNightMode({ end: event.target.value })
                  }
                  disabled={!policy.nightMode.enabled}
                />
              </label>
            </div>
            <label
              htmlFor="ops-night-timezone"
              className="block space-y-1 text-xs text-zinc-500"
            >
              <span>{t("timezone")}</span>
              <Input
                id="ops-night-timezone"
                value={policy.nightMode.timezone}
                onChange={(event) =>
                  patchNightMode({ timezone: event.target.value })
                }
                disabled={!policy.nightMode.enabled}
              />
            </label>
            <label
              htmlFor="ops-night-action"
              className="block space-y-1 text-xs text-zinc-500"
            >
              <span>{t("action")}</span>
              <select
                id="ops-night-action"
                value={policy.nightMode.action}
                onChange={(event) =>
                  patchNightMode({
                    action: event.target.value as
                      | "read_only"
                      | "pause_side_effects",
                  })
                }
                disabled={!policy.nightMode.enabled}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-zinc-200 outline-none focus-visible:border-ring"
              >
                <option value="read_only">{t("readOnly")}</option>
                <option value="pause_side_effects">
                  {t("pauseSideEffects")}
                </option>
              </select>
            </label>
          </div>

          <div className="space-y-3 rounded-lg border border-border px-4 py-3">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="checkbox"
                checked={policy.quietWindow !== null}
                onChange={(event) => toggleQuietWindow(event.target.checked)}
                className="size-4 accent-emerald-500"
              />
              {t("quietWindowEnabled")}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                htmlFor="ops-quiet-start"
                className="space-y-1 text-xs text-zinc-500"
              >
                <span>{t("start")}</span>
                <Input
                  id="ops-quiet-start"
                  type="time"
                  value={policy.quietWindow?.start ?? "23:00"}
                  onChange={(event) =>
                    patchQuietWindow({ start: event.target.value })
                  }
                  disabled={policy.quietWindow === null}
                />
              </label>
              <label
                htmlFor="ops-quiet-end"
                className="space-y-1 text-xs text-zinc-500"
              >
                <span>{t("end")}</span>
                <Input
                  id="ops-quiet-end"
                  type="time"
                  value={policy.quietWindow?.end ?? "07:00"}
                  onChange={(event) =>
                    patchQuietWindow({ end: event.target.value })
                  }
                  disabled={policy.quietWindow === null}
                />
              </label>
            </div>
            <label
              htmlFor="ops-monthly-budget"
              className="block space-y-1 text-xs text-zinc-500"
            >
              <span>{t("monthlyBudget")}</span>
              <Input
                id="ops-monthly-budget"
                type="number"
                min={1}
                value={policy.monthlyBudget ?? ""}
                placeholder={t("unlimited")}
                onChange={(event) =>
                  setPolicy((current) => ({
                    ...current,
                    monthlyBudget:
                      event.target.value === ""
                        ? null
                        : Math.max(1, Number(event.target.value) || 1),
                  }))
                }
              />
            </label>
            <p className="text-[11px] text-zinc-500">
              {t("monthlyBudgetHint")}
            </p>
          </div>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-500">
            {gate.readOnly && policy.nightMode.enabled
              ? t("nightModeGateHint")
              : t("policyAuditHint")}
          </p>
          <Button onClick={save} disabled={saving}>
            <Check className="size-4" />
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
