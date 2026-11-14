import type { AutopilotConfig } from "@kit/core";
import type { AutonomyPresetRecord } from "@kit/ops";

/**
 * Overlay an active self-hosted LIVE preset onto a pack's autopilot config.
 * The pack file stays untouched: rollback only needs to clear the preset.
 */
export function applyAutonomyPreset(
  config: AutopilotConfig,
  preset: AutonomyPresetRecord | null,
): AutopilotConfig {
  if (!preset) {
    return config;
  }
  const { applyMode, dailyCostCny, dailyRuns, maxTasks } = preset.config;
  return {
    ...config,
    enabled: true,
    iterations: config.iterations.map((iteration) => ({
      ...iteration,
      mode: "LIVE",
      applyMode,
      maxTasks: Math.min(iteration.maxTasks, maxTasks),
      budget: {
        ...iteration.budget,
        dailyRuns,
        dailyCostCny,
      },
    })),
  };
}
