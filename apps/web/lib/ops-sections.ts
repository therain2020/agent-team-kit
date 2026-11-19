/**
 * Pure helpers for the unified `/ops` surface: section routing, keyboard
 * shortcuts, legacy redirects and the impact-chain summary. Kept free of
 * React/Next imports so it can be unit tested directly.
 */

export const OPS_SECTIONS = [
  "alerts",
  "degradation",
  "budget",
  "control",
] as const;

export type OpsSection = (typeof OPS_SECTIONS)[number];

export const DEFAULT_OPS_SECTION: OpsSection = "alerts";

/** Legacy one-page-per-concern routes folded into the unified surface. */
export const LEGACY_OPS_REDIRECTS = {
  "/degradation": "degradation",
  "/budgets": "budget",
  "/kill-switch": "control",
  "/autopilot": "control",
} as const satisfies Record<string, OpsSection>;

export type LegacyOpsPath = keyof typeof LEGACY_OPS_REDIRECTS;

/** Keyboard shortcuts: jump to a section and focus it (issue #163). */
export const OPS_SHORTCUTS = {
  d: "degradation",
  b: "budget",
  k: "control",
} as const satisfies Record<string, OpsSection>;

export type OpsShortcutKey = keyof typeof OPS_SHORTCUTS;

export function isOpsSection(value: unknown): value is OpsSection {
  return (
    typeof value === "string" &&
    (OPS_SECTIONS as readonly string[]).includes(value)
  );
}

/** Resolve `?section=` into a known section, defaulting to alerts. */
export function resolveOpsSection(
  value: string | string[] | undefined | null,
): OpsSection {
  const raw = Array.isArray(value) ? value[0] : value;
  return isOpsSection(raw) ? raw : DEFAULT_OPS_SECTION;
}

export function opsSectionHref(section: OpsSection): string {
  return section === DEFAULT_OPS_SECTION ? "/ops" : `/ops?section=${section}`;
}

/** Target URL for a legacy route, or null when the path is not legacy. */
export function legacyOpsRedirect(pathname: string): string | null {
  const section = (LEGACY_OPS_REDIRECTS as Record<string, OpsSection>)[
    pathname
  ];
  return section ? opsSectionHref(section) : null;
}

/**
 * Map a keydown to a section jump. Returns null when the key is not a
 * shortcut or a modifier is held (so ⌘K, ctrl shortcuts etc. are untouched).
 */
export function opsShortcutFor(
  key: string,
  modifiers?: { meta?: boolean; ctrl?: boolean; alt?: boolean },
): OpsSection | null {
  if (modifiers?.meta || modifiers?.ctrl || modifiers?.alt) {
    return null;
  }
  const lowered = key.toLowerCase();
  if (!Object.hasOwn(OPS_SHORTCUTS, lowered)) {
    return null;
  }
  return OPS_SHORTCUTS[lowered as OpsShortcutKey];
}

export type ImpactSeverity = "ok" | "warning" | "danger";

export type ImpactSuggestion =
  | "ackAlerts"
  | "ackOverdue"
  | "exitDegradation"
  | "increaseBudget"
  | "reviewBudget"
  | "releaseKillSwitch"
  | "pauseAutopilot"
  | "allClear";

export interface ImpactAlertInput {
  tier: string;
  status: string;
  firstSeenAt?: string;
}

export interface ImpactModeInput {
  kind: "degraded" | "read_only";
}

export interface ImpactBudgetInput {
  exceeded: boolean;
  alert: boolean;
  percent: number | null;
}

export interface ImpactInput {
  alerts: ImpactAlertInput[];
  modes: ImpactModeInput[];
  budgets: ImpactBudgetInput[];
  activeKillSwitches: number;
  autopilot: { online: boolean; enabledPacks: number };
  ackSlaMinutes?: Record<string, number | undefined>;
  now?: number;
}

export interface ImpactChain {
  severity: ImpactSeverity;
  openAlerts: number;
  overdueAlerts: number;
  worstTier: string | null;
  modeKind: "degraded" | "read_only" | null;
  modeCount: number;
  activeKillSwitches: number;
  exceededBudgets: number;
  alertingBudgets: number;
  worstPercent: number | null;
  autopilotOnline: boolean;
  enabledPacks: number;
  suggestions: ImpactSuggestion[];
  attention: boolean;
}

const TIER_RANK: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function isOverdue(
  alert: ImpactAlertInput,
  ackSlaMinutes: Record<string, number | undefined> | undefined,
  now: number,
): boolean {
  if (alert.status !== "open" || !alert.firstSeenAt) {
    return false;
  }
  const sla = ackSlaMinutes?.[alert.tier];
  if (sla === undefined) {
    return false;
  }
  const firstSeen = new Date(alert.firstSeenAt).getTime();
  if (!Number.isFinite(firstSeen)) {
    return false;
  }
  return now - firstSeen > sla * 60_000;
}

/**
 * Derive the four-step impact chain shown at the top of `/ops`:
 * current anomaly → degradation → budgets → suggested action.
 */
export function deriveImpactChain(input: ImpactInput): ImpactChain {
  const now = input.now ?? Date.now();
  const open = input.alerts.filter((alert) => alert.status === "open");
  const overdue = open.filter((alert) =>
    isOverdue(alert, input.ackSlaMinutes, now),
  );

  let worstTier: string | null = null;
  for (const alert of open) {
    if (
      worstTier === null ||
      (TIER_RANK[alert.tier] ?? 99) < (TIER_RANK[worstTier] ?? 99)
    ) {
      worstTier = alert.tier;
    }
  }

  const hasReadOnly = input.modes.some((mode) => mode.kind === "read_only");
  const modeKind: ImpactChain["modeKind"] =
    input.modes.length === 0 ? null : hasReadOnly ? "read_only" : "degraded";

  const exceeded = input.budgets.filter((budget) => budget.exceeded);
  const alerting = input.budgets.filter(
    (budget) => !budget.exceeded && budget.alert,
  );
  const worstPercent = input.budgets.reduce<number | null>((worst, budget) => {
    if (budget.percent === null) {
      return worst;
    }
    return worst === null || budget.percent > worst ? budget.percent : worst;
  }, null);

  let severity: ImpactSeverity = "ok";
  if (
    input.activeKillSwitches > 0 ||
    open.some((alert) => alert.tier === "P0") ||
    hasReadOnly ||
    exceeded.length > 0
  ) {
    severity = "danger";
  } else if (
    input.modes.length > 0 ||
    alerting.length > 0 ||
    open.some((alert) => alert.tier === "P1")
  ) {
    severity = "warning";
  }

  const suggestions: ImpactSuggestion[] = [];
  const add = (suggestion: ImpactSuggestion) => {
    if (!suggestions.includes(suggestion)) {
      suggestions.push(suggestion);
    }
  };

  if (input.activeKillSwitches > 0) {
    add("releaseKillSwitch");
  }
  if (input.modes.length > 0) {
    add("exitDegradation");
  }
  if (exceeded.length > 0) {
    add("increaseBudget");
  } else if (alerting.length > 0) {
    add("reviewBudget");
  }
  if (overdue.length > 0) {
    add("ackOverdue");
  } else if (open.length > 0) {
    add("ackAlerts");
  }
  const budgetPressure = exceeded.length > 0 || hasReadOnly;
  if (input.autopilot.enabledPacks > 0 && budgetPressure) {
    add("pauseAutopilot");
  }
  if (suggestions.length === 0) {
    add("allClear");
  }

  return {
    severity,
    openAlerts: open.length,
    overdueAlerts: overdue.length,
    worstTier,
    modeKind,
    modeCount: input.modes.length,
    activeKillSwitches: input.activeKillSwitches,
    exceededBudgets: exceeded.length,
    alertingBudgets: alerting.length,
    worstPercent,
    autopilotOnline: input.autopilot.online,
    enabledPacks: input.autopilot.enabledPacks,
    suggestions: suggestions.slice(0, 3),
    attention: severity !== "ok",
  };
}

/** Section a suggestion points at, used by the "needs you" bar. */
export function suggestionSection(suggestion: ImpactSuggestion): OpsSection {
  switch (suggestion) {
    case "ackAlerts":
    case "ackOverdue":
      return "alerts";
    case "exitDegradation":
      return "degradation";
    case "increaseBudget":
    case "reviewBudget":
      return "budget";
    case "releaseKillSwitch":
    case "pauseAutopilot":
      return "control";
    default:
      return DEFAULT_OPS_SECTION;
  }
}
