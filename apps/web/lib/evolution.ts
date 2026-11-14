import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  type CanaryState,
  type EvolutionCycleRecord,
  type EvolutionRecord,
  type VariantMeta,
  canaryStatus,
  compareVariants,
  loadEvolutionCycles,
} from "@kit/evolution";
import { getRepoRoot } from "./paths";

export interface VariantView {
  dirName: string;
  meta: VariantMeta;
  latest: EvolutionRecord | null;
  averageScore: number;
  isChampion: boolean;
  isCanary: boolean;
  canaryStatus?: NonNullable<CanaryState["canary"]>["status"];
}

export interface EvolutionData {
  state: CanaryState | null;
  variants: VariantView[];
  cycles: EvolutionCycleRecord[];
  archivePath: string;
  statePath: string;
  cyclesPath: string;
  repoRoot: string;
}

export async function loadEvolutionData(): Promise<EvolutionData> {
  const repoRoot = getRepoRoot();
  const variantsRoot = path.join(repoRoot, "variants");
  const archivePath = path.join(variantsRoot, "archive.jsonl");
  const statePath = path.join(variantsRoot, "state.json");
  const cyclesPath = path.join(variantsRoot, "cycles.jsonl");
  const state = await canaryStatus(statePath);
  const records = await compareVariants(archivePath);
  const cycles = await loadEvolutionCycles(cyclesPath, 50);
  const byVariant = new Map(
    records.map((record) => [record.variantId, record]),
  );

  const variants: VariantView[] = [];
  if (existsSync(variantsRoot)) {
    const entries = await readdir(variantsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = path.join(variantsRoot, entry.name, "variant.json");
      if (!existsSync(metaPath)) {
        continue;
      }
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as VariantMeta;
      const latest = byVariant.get(meta.id) ?? null;
      const averageScore = latest ? average(Object.values(latest.scores)) : 0;
      const absolute = path.resolve(variantsRoot, entry.name);
      const isChampion = state?.champion.path === absolute;
      const isCanary = state?.canary?.path === absolute;
      variants.push({
        dirName: entry.name,
        meta,
        latest,
        averageScore,
        isChampion,
        isCanary,
        canaryStatus: isCanary ? state?.canary?.status : undefined,
      });
    }
  }

  variants.sort((a, b) => {
    if (a.isChampion !== b.isChampion) {
      return a.isChampion ? -1 : 1;
    }
    if (a.isCanary !== b.isCanary) {
      return a.isCanary ? -1 : 1;
    }
    return a.meta.name.localeCompare(b.meta.name);
  });

  return {
    state,
    variants,
    cycles,
    archivePath,
    statePath,
    cyclesPath,
    repoRoot,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
