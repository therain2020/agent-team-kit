import path from "node:path";
import { StoreEvolutionRepository } from "@kit/evolution";
import { getRepoRoot } from "./paths";
import { ensureStoreSchema, getStore } from "./store";

export async function getEvolutionRepo(): Promise<StoreEvolutionRepository> {
  await ensureStoreSchema();
  return new StoreEvolutionRepository(getStore(), {
    variantsRoot: path.join(getRepoRoot(), "variants"),
  });
}
