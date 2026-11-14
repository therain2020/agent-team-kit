import path from "node:path";
import {
  type CanaryState,
  type EvolutionCycleRecord,
  type EvolutionRecord,
  PostgresEvolutionRepository,
  type VariantMeta,
} from "@kit/evolution";
import { getRepoRoot } from "./paths";
import { ensureStoreSchema, getStore } from "./store";

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
  await ensureStoreSchema();
  const repoRoot = getRepoRoot();
  const variantsRoot = path.join(repoRoot, "variants");
  const repo = new PostgresEvolutionRepository(getStore(), { variantsRoot });
  await repo.ensureReady();

  const [storedState, records, cycles, storedVariants] = await Promise.all([
    repo.getState(),
    repo.latestScores(),
    repo.listCycles(50),
    repo.listVariants(),
  ]);

  const state = storedState?.state ?? null;
  const byVariant = new Map(
    records.map((record) => [record.variantId, record]),
  );
  const variants: VariantView[] = storedVariants.map(({ meta, dir }) => {
    const latest = byVariant.get(meta.id) ?? null;
    const absolute = dir ? path.resolve(dir) : "";
    return {
      dirName: dir ? path.basename(dir) : meta.id,
      meta,
      latest,
      averageScore: latest ? average(Object.values(latest.scores)) : 0,
      isChampion: absolute !== "" && state?.champion.path === absolute,
      isCanary: absolute !== "" && state?.canary?.path === absolute,
      canaryStatus:
        absolute !== "" && state?.canary?.path === absolute
          ? state.canary.status
          : undefined,
    };
  });

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
    archivePath: path.join(variantsRoot, "archive.jsonl"),
    statePath: path.join(variantsRoot, "state.json"),
    cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
    repoRoot,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
