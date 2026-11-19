import path from "node:path";
import {
  type WorkshopInstallRecord,
  listInstalledWorkshop,
  searchWorkshop,
} from "@kit/workshop";
import { getPacksRoot, getRepoRoot } from "./paths";

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
