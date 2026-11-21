import path from "node:path";
import { getTemplatesRoot } from "@kit/pack";
import {
  type WorkshopInstallRecord,
  listInstalledWorkshop,
  searchWorkshop,
  sourcesRoot,
} from "@kit/workshop";
import { getComponentsRoot, getPacksRoot, getRepoRoot } from "./paths";

export function getWorkshopRoot(): string {
  return process.env.KIT_WORKSHOP_ROOT ?? path.join(getRepoRoot(), "workshop");
}

/**
 * Install destination for `kind: pack` items (plan 88 §3.4). Packs land in the
 * pack library so they can be loaded, simulated and opened in Studio right
 * after install.
 */
export function getWorkshopPacksRoot(): string {
  return getPacksRoot();
}

/** Local source library that receives `kind: source` installs. */
export function getWorkshopSourcesRoot(): string {
  return sourcesRoot();
}

/** Local template library that receives `kind: template` installs. */
export function getWorkshopTemplatesRoot(): string {
  return getTemplatesRoot();
}

/** Component library that receives agent/workflow/toolpack/skillpack installs. */
export function getWorkshopComponentsRoot(): string {
  return getComponentsRoot();
}

export async function loadInstalledWorkshop(): Promise<
  WorkshopInstallRecord[]
> {
  return listInstalledWorkshop(getWorkshopRoot());
}

export async function searchWorkshopMarket(query?: string) {
  return searchWorkshop({
    query,
    token: process.env.GITHUB_TOKEN,
    limit: 12,
  });
}
