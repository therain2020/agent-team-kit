import {
  AUTONOMOUS_ORIGIN_KINDS,
  type AutoApproveScope,
  type AutopilotConfig,
  type RunOriginKind,
} from "@kit/core";

/**
 * Pure helpers for the auto-approval scope control on `/triggers` (96 §5.2).
 *
 * `scope` is optional in `autopilot.yaml`; an absent value means `scheduled`
 * (schedule/event/information only). `all` must be chosen explicitly because
 * it also covers manual/web/cli/api jobs.
 */

export type AutoApprove = NonNullable<
  NonNullable<AutopilotConfig["approval"]>["autoApprove"]
>;

/** Origins that only `scope: all` adds on top of the autonomous set. */
export const INTERACTIVE_ORIGIN_KINDS: ReadonlyArray<RunOriginKind> = [
  "manual",
  "web",
  "cli",
  "api",
];

export function resolveAutoApproveScope(
  autoApprove?: Pick<AutoApprove, "scope"> | null,
): AutoApproveScope {
  return autoApprove?.scope === "all" ? "all" : "scheduled";
}

/**
 * Everything the policy may decide on for a scope. Kept in the same order the
 * UI shows them so observers can read the coverage at a glance.
 */
export function autoApproveCoveredOrigins(
  scope: AutoApproveScope,
): RunOriginKind[] {
  return scope === "all"
    ? [...AUTONOMOUS_ORIGIN_KINDS, ...INTERACTIVE_ORIGIN_KINDS]
    : [...AUTONOMOUS_ORIGIN_KINDS];
}

/**
 * `scope: all` widens the policy to manual/web/cli/api jobs, so it always needs
 * an explicit confirmation before it is saved (even while auto-approval is off:
 * the widened scope is latent and would activate with the next enable).
 */
export function requiresScopeAllConfirmation(scope: AutoApproveScope): boolean {
  return scope === "all";
}

/** Fill defaults and make the effective scope explicit for rendering. */
export function normalizeAutoApprove(
  autoApprove?: Partial<AutoApprove> | null,
): AutoApprove {
  return {
    enabled: autoApprove?.enabled ?? false,
    maxRisk: autoApprove?.maxRisk ?? "low",
    onTimeout: autoApprove?.onTimeout ?? "wait",
    scope: resolveAutoApproveScope(autoApprove),
    ...(autoApprove?.maxRunCostCny !== undefined
      ? { maxRunCostCny: autoApprove.maxRunCostCny }
      : {}),
  };
}

/** Write the effective scope back so a saved `all` never silently drifts. */
export function autoApproveForSave(autoApprove: AutoApprove): AutoApprove {
  return { ...autoApprove, scope: resolveAutoApproveScope(autoApprove) };
}

/** Drop the optional cost cap without dropping the scope selection. */
export function withoutRunCost(autoApprove: AutoApprove): AutoApprove {
  return {
    enabled: autoApprove.enabled,
    maxRisk: autoApprove.maxRisk,
    onTimeout: autoApprove.onTimeout,
    scope: autoApprove.scope,
  };
}
