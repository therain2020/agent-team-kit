"use client";

import { AutopilotConsole } from "@/components/autopilot/autopilot-console";
import { BudgetConsole } from "@/components/budgets/budget-console";
import type { DependencyView } from "@/components/degradation/degradation-controls";
import { KillSwitchConsole } from "@/components/kill-switch/kill-switch-console";
import { AutonomyCard } from "@/components/ops/autonomy-card";
import { CapacitySection } from "@/components/ops/capacity-section";
import { DegradationSection } from "@/components/ops/degradation-section";
import { ImpactChainCard, suggestionKey } from "@/components/ops/impact-chain";
import { OpsAlertsPanel } from "@/components/ops/ops-alerts-panel";
import { OpsPolicyForm } from "@/components/ops/ops-policy-form";
import { Badge } from "@/components/ui/badge";
import type { AutopilotOverview } from "@/lib/autopilot";
import type { BudgetOverview } from "@/lib/budgets";
import type { CapacityOverview } from "@/lib/capacity-math";
import type { KillSwitchState } from "@/lib/kill-switch";
import type { LkgView } from "@/lib/lkg";
import type { OpsConsoleData } from "@/lib/ops";
import {
  OPS_SECTIONS,
  type OpsSection,
  deriveImpactChain,
  opsSectionHref,
  opsShortcutFor,
  suggestionSection,
} from "@/lib/ops-sections";
import type { DegradedMode } from "@kit/core";
import type { DegradationAuditRecord } from "@kit/store";
import {
  ChevronRight,
  Gauge,
  type LucideIcon,
  ShieldAlert,
  Siren,
  Wallet,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

export interface OpsSurfaceData {
  ops: OpsConsoleData;
  modes: DegradedMode[];
  audit: DegradationAuditRecord[];
  dependencies: DependencyView[];
  budgets: BudgetOverview;
  killSwitch: KillSwitchState;
  autopilot: AutopilotOverview;
  lkg: LkgView[];
  capacity: CapacityOverview;
}

const SECTION_META: Record<
  OpsSection,
  {
    icon: LucideIcon;
    titleKey: string;
    descKey: string;
    shortcut: string | null;
  }
> = {
  alerts: {
    icon: Siren,
    titleKey: "sectionAlerts",
    descKey: "sectionAlertsDesc",
    shortcut: null,
  },
  degradation: {
    icon: ShieldAlert,
    titleKey: "sectionDegradation",
    descKey: "sectionDegradationDesc",
    shortcut: "d",
  },
  budget: {
    icon: Wallet,
    titleKey: "sectionBudget",
    descKey: "sectionBudgetDesc",
    shortcut: "b",
  },
  capacity: {
    icon: Gauge,
    titleKey: "sectionCapacity",
    descKey: "sectionCapacityDesc",
    shortcut: "c",
  },
  control: {
    icon: Wrench,
    titleKey: "sectionControl",
    descKey: "sectionControlDesc",
    shortcut: "k",
  },
};

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

export function OpsSurface({
  initial,
  operator,
  initialSection,
  initialNow,
}: {
  initial: OpsSurfaceData;
  operator: string;
  initialSection: OpsSection;
  initialNow: number;
}) {
  const t = useTranslations("opsSurface");
  const [active, setActive] = useState<OpsSection>(initialSection);
  const refs = useRef<Partial<Record<OpsSection, HTMLElement | null>>>({});

  const impact = deriveImpactChain({
    alerts: initial.ops.alerts,
    modes: initial.modes,
    budgets: initial.budgets.budgets,
    activeKillSwitches: initial.killSwitch.active.length,
    autopilot: {
      online: initial.autopilot.online,
      enabledPacks: initial.autopilot.packs.filter((pack) => pack.enabled)
        .length,
    },
    ackSlaMinutes: initial.ops.policy.ackSlaMinutes,
    now: initialNow,
  });

  const jump = useCallback((section: OpsSection, smooth = true) => {
    setActive(section);
    const element = refs.current[section];
    if (!element) {
      return;
    }
    element.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "start",
    });
    element.focus({ preventScroll: true });
    window.history.replaceState(null, "", opsSectionHref(section));
  }, []);

  useEffect(() => {
    if (initialSection === "alerts") {
      return;
    }
    const frame = window.requestAnimationFrame(() =>
      jump(initialSection, false),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [initialSection, jump]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isTypingTarget(event.target)) {
        return;
      }
      const section = opsShortcutFor(event.key, {
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
      });
      if (!section) {
        return;
      }
      event.preventDefault();
      jump(section);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [jump]);

  const attentionActions = impact.suggestions.filter(
    (suggestion) => suggestion !== "allClear",
  );

  return (
    <div className="space-y-4">
      <ImpactChainCard impact={impact} onJump={jump} />

      {impact.attention ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-100"
        >
          <span className="font-semibold uppercase tracking-wider text-amber-300">
            {t("attentionTitle")}
          </span>
          <span className="text-amber-200/80">{t("attentionBody")}</span>
          <span className="flex flex-wrap items-center gap-2">
            {attentionActions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => jump(suggestionSection(suggestion))}
                className="flex items-center gap-0.5 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] text-amber-200 outline-none hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-400/60"
              >
                {t(suggestionKey(suggestion))}
                <ChevronRight className="size-3" />
              </button>
            ))}
          </span>
        </div>
      ) : null}

      {initial.ops.gate.readOnly ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            {t("nightModeActive", {
              reason: initial.ops.gate.reason ?? t("nightModeFallback"),
            })}
          </span>
        </div>
      ) : null}

      <nav
        aria-label={t("sectionNav")}
        className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-1 border-b border-border bg-background/95 px-1 py-2 backdrop-blur"
      >
        {OPS_SECTIONS.map((section) => {
          const meta = SECTION_META[section];
          const Icon = meta.icon;
          const isActive = active === section;
          return (
            <button
              key={section}
              type="button"
              onClick={() => jump(section)}
              aria-current={isActive ? "true" : undefined}
              className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                isActive
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-accent hover:text-zinc-200"
              }`}
            >
              <Icon className="size-3.5" />
              {t(meta.titleKey)}
              {meta.shortcut ? (
                <kbd className="rounded border border-border bg-zinc-900 px-1 font-mono text-[9px] text-zinc-500">
                  {meta.shortcut}
                </kbd>
              ) : null}
            </button>
          );
        })}
        <span className="ml-auto hidden text-[10px] text-zinc-600 sm:inline">
          {t("shortcutHint")}
        </span>
      </nav>

      <OpsSectionBlock
        section="alerts"
        register={(element) => {
          refs.current.alerts = element;
        }}
      >
        <OpsAlertsPanel
          initialAlerts={initial.ops.alerts}
          policy={initial.ops.policy}
          operator={operator}
          initialNow={initialNow}
        />
        <OpsPolicyForm
          initialPolicy={initial.ops.policy}
          initialGate={initial.ops.gate}
        />
      </OpsSectionBlock>

      <OpsSectionBlock
        section="degradation"
        register={(element) => {
          refs.current.degradation = element;
        }}
      >
        <DegradationSection
          modes={initial.modes}
          audit={initial.audit}
          dependencies={initial.dependencies}
          lkg={initial.lkg}
        />
      </OpsSectionBlock>

      <OpsSectionBlock
        section="budget"
        register={(element) => {
          refs.current.budget = element;
        }}
      >
        <BudgetConsole overview={initial.budgets} />
      </OpsSectionBlock>

      <OpsSectionBlock
        section="capacity"
        register={(element) => {
          refs.current.capacity = element;
        }}
      >
        <CapacitySection overview={initial.capacity} />
      </OpsSectionBlock>

      <OpsSectionBlock
        section="control"
        register={(element) => {
          refs.current.control = element;
        }}
      >
        <KillSwitchConsole initial={initial.killSwitch} />
        <AutonomyCard autonomy={initial.ops.autonomy} />
        <div className="space-y-2 pt-1">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {t("autopilotTitle")}
            <Badge variant={initial.autopilot.online ? "success" : "warning"}>
              {initial.autopilot.online
                ? t("autopilotOnline")
                : t("autopilotOffline")}
            </Badge>
          </h3>
          <p className="text-[11px] text-zinc-500">{t("autopilotDesc")}</p>
        </div>
        <AutopilotConsole overview={initial.autopilot} />
      </OpsSectionBlock>
    </div>
  );
}

function OpsSectionBlock({
  section,
  register,
  children,
}: {
  section: OpsSection;
  register: (element: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("opsSurface");
  const meta = SECTION_META[section];
  const Icon = meta.icon;
  return (
    <section
      id={`ops-${section}`}
      ref={register}
      tabIndex={-1}
      aria-labelledby={`ops-${section}-title`}
      className="scroll-mt-20 space-y-3 rounded-lg border border-border/50 bg-zinc-950/20 p-3 outline-none focus-visible:border-emerald-500/40 focus-visible:ring-1 focus-visible:ring-emerald-500/25"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2
          id={`ops-${section}-title`}
          className="flex items-center gap-2 text-sm font-semibold text-zinc-100"
        >
          <Icon className="size-4 text-zinc-400" />
          {t(meta.titleKey)}
        </h2>
        {meta.shortcut ? (
          <kbd className="rounded border border-border bg-zinc-900 px-1 font-mono text-[10px] text-zinc-500">
            {meta.shortcut}
          </kbd>
        ) : null}
        <p className="text-[11px] text-zinc-500">{t(meta.descKey)}</p>
      </header>
      {children}
    </section>
  );
}
