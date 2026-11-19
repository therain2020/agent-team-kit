"use client";

import { Badge } from "@/components/ui/badge";
import {
  type ImpactChain,
  type ImpactSuggestion,
  type OpsSection,
  suggestionSection,
} from "@/lib/ops-sections";
import {
  Link2,
  type LucideIcon,
  ShieldAlert,
  Siren,
  Wallet,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";

export function ImpactChainCard({
  impact,
  onJump,
}: {
  impact: ImpactChain;
  onJump: (section: OpsSection) => void;
}) {
  const t = useTranslations("opsSurface");

  const anomaly =
    impact.openAlerts === 0 && impact.activeKillSwitches === 0
      ? t("anomalyNone")
      : [
          impact.openAlerts > 0
            ? t("anomalySummary", {
                count: impact.openAlerts,
                tier: impact.worstTier ?? "—",
              })
            : null,
          impact.overdueAlerts > 0
            ? t("anomalyOverdue", { count: impact.overdueAlerts })
            : null,
          impact.activeKillSwitches > 0
            ? t("anomalyKillSwitch", { count: impact.activeKillSwitches })
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const degradation =
    impact.modeCount === 0 || impact.modeKind === null
      ? t("degradationNone")
      : t("degradationActive", {
          kind:
            impact.modeKind === "read_only"
              ? t("degradationReadOnly")
              : t("degradationDegraded"),
          count: impact.modeCount,
        });

  const budget =
    impact.exceededBudgets === 0 && impact.alertingBudgets === 0
      ? t("budgetNone")
      : [
          t("budgetSummary", {
            exceeded: impact.exceededBudgets,
            alerting: impact.alertingBudgets,
          }),
          impact.worstPercent !== null
            ? t("budgetWorst", { percent: impact.worstPercent })
            : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const actions = impact.suggestions.map((suggestion) =>
    t(suggestionKey(suggestion)),
  );

  return (
    <section
      aria-labelledby="ops-impact-title"
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <h2
          id="ops-impact-title"
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-300"
        >
          <Link2 className="size-3.5 text-emerald-400" />
          {t("impactTitle")}
        </h2>
        <Badge variant={severityVariant(impact.severity)}>
          {t(`severity_${impact.severity}`)}
        </Badge>
        {impact.attention ? (
          <span className="text-[11px] text-amber-300">
            {t("impactAttention", {
              count: impact.suggestions.filter((item) => item !== "allClear")
                .length,
            })}
          </span>
        ) : (
          <span className="text-[11px] text-emerald-300">
            {t("impactClear")}
          </span>
        )}
        <span className="ml-auto hidden text-[10px] text-zinc-600 sm:inline">
          {t("impactHint")}
        </span>
      </header>
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        <ChainStep
          index={1}
          icon={Siren}
          label={t("stepAnomaly")}
          value={anomaly}
          tone={impact.openAlerts > 0 ? "warn" : "neutral"}
          onClick={() => onJump("alerts")}
          jumpLabel={t("jumpTo", { section: t("sectionAlerts") })}
        />
        <ChainStep
          index={2}
          icon={ShieldAlert}
          label={t("stepDegradation")}
          value={degradation}
          tone={impact.modeCount > 0 ? "danger" : "neutral"}
          onClick={() => onJump("degradation")}
          jumpLabel={t("jumpTo", { section: t("sectionDegradation") })}
        />
        <ChainStep
          index={3}
          icon={Wallet}
          label={t("stepBudget")}
          value={budget}
          tone={
            impact.exceededBudgets > 0
              ? "danger"
              : impact.alertingBudgets > 0
                ? "warn"
                : "neutral"
          }
          onClick={() => onJump("budget")}
          jumpLabel={t("jumpTo", { section: t("sectionBudget") })}
        />
        <ChainStep
          index={4}
          icon={Wrench}
          label={t("stepAction")}
          value={
            <span className="space-y-0.5">
              {actions.map((action) => (
                <span
                  key={action}
                  className="block text-[11px] leading-snug text-zinc-300"
                >
                  {action}
                </span>
              ))}
            </span>
          }
          tone={impact.attention ? "warn" : "ok"}
          onClick={() =>
            onJump(suggestionSection(impact.suggestions[0] ?? "allClear"))
          }
          jumpLabel={t("jumpToAction")}
        />
      </div>
    </section>
  );
}

function ChainStep({
  index,
  icon: Icon,
  label,
  value,
  tone,
  onClick,
  jumpLabel,
}: {
  index: number;
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  tone: "neutral" | "warn" | "danger" | "ok";
  onClick: () => void;
  jumpLabel: string;
}) {
  const toneClass =
    tone === "danger"
      ? "text-red-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "ok"
          ? "text-emerald-300"
          : "text-zinc-300";
  return (
    <button
      type="button"
      onClick={onClick}
      title={jumpLabel}
      className="group min-w-0 bg-card px-4 py-2.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <span className="font-mono text-zinc-600">{index}</span>
        <Icon className="size-3" />
        {label}
      </span>
      <span className={`mt-1 block min-w-0 text-xs ${toneClass}`}>{value}</span>
    </button>
  );
}

function severityVariant(severity: ImpactChain["severity"]) {
  if (severity === "danger") {
    return "danger" as const;
  }
  if (severity === "warning") {
    return "warning" as const;
  }
  return "success" as const;
}

export function suggestionKey(suggestion: ImpactSuggestion): string {
  switch (suggestion) {
    case "ackAlerts":
      return "suggestAckAlerts";
    case "ackOverdue":
      return "suggestAckOverdue";
    case "exitDegradation":
      return "suggestExitDegradation";
    case "increaseBudget":
      return "suggestIncreaseBudget";
    case "reviewBudget":
      return "suggestReviewBudget";
    case "releaseKillSwitch":
      return "suggestReleaseKillSwitch";
    case "pauseAutopilot":
      return "suggestPauseAutopilot";
    default:
      return "suggestAllClear";
  }
}
