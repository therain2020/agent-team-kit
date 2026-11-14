import path from "node:path";
import { PostgresEvolutionRepository } from "@kit/evolution";
import { getRepoRoot } from "./paths";
import { ensureStoreSchema, getStore } from "./store";

export async function getEvolutionRepo(): Promise<PostgresEvolutionRepository> {
  await ensureStoreSchema();
  return new PostgresEvolutionRepository(getStore(), {
    variantsRoot: path.join(getRepoRoot(), "variants"),
  });
}
