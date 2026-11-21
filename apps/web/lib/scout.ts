import { type ScoutRunResult, runScout } from "@kit/source";
import { getRepoRoot } from "./paths";
import { ensureStoreSchema, getStore } from "./store";

export const SCOUT_NETWORK_ENV = "KIT_SCOUT_ALLOW_NETWORK";

/**
 * Network access is authorized by deployment config only (98 §7.3, 50 §3.3).
 * A request may not grant itself egress.
 */
export function scoutNetworkAllowed(): boolean {
  return process.env[SCOUT_NETWORK_ENV] === "1";
}

/** One-line interest → read-only research → information events. */
export async function runInterestScout(
  interest: string,
  workspaceId: string,
): Promise<ScoutRunResult> {
  await ensureStoreSchema();
  return runScout(getStore(), {
    workspaceId,
    interest,
    allowNetwork: scoutNetworkAllowed(),
    repoRoot: getRepoRoot(),
  });
}
