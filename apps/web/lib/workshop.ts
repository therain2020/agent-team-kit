import path from "node:path";
import {
  type WorkshopInstallRecord,
  listInstalledWorkshop,
  searchWorkshop,
} from "@kit/workshop";
import { getRepoRoot } from "./paths";

export function getWorkshopRoot(): string {
  return process.env.KIT_WORKSHOP_ROOT ?? path.join(getRepoRoot(), "workshop");
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
