import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type EvolutionRecord, type VariantMeta, scoreVariant } from "./evolve";
import type { EvolutionRepository } from "./repository";

export const DEFAULT_STATE = "variants/state.json";

export interface CanaryState {
  champion: { path: string };
  canary?: {
    path: string;
    variantId: string;
    agentId: string;
    percent: number;
    status: "active" | "rolled_back" | "promoted";
    since: string;
    reason?: string;
    evalSnapshotPath?: string;
  };
}

export interface CanaryDecision {
  rollback: boolean;
  reason?: string;
}

export async function startCanary(
  baselineDir: string,
  variantDir: string,
  percent: number,
  statePath = DEFAULT_STATE,
  repo?: EvolutionRepository,
  evalDir?: string,
): Promise<CanaryState> {
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    throw new Error("percent must be between 1 and 99");
  }

  const variantMeta = await readMeta(variantDir);
  await readMeta(baselineDir);

  const state: CanaryState = {
    champion: { path: path.resolve(baselineDir) },
    canary: {
      path: path.resolve(variantDir),
      variantId: variantMeta.id,
      agentId: variantMeta.agentId,
      percent,
      status: "active",
      since: new Date().toISOString(),
      ...(evalDir ? { evalSnapshotPath: path.resolve(evalDir) } : {}),
    },
  };

  if (repo) {
    const stored = await repo.getState();
    const ok = await repo.setState(state, stored?.version);
    if (!ok) {
      throw new Error("canary state changed concurrently");
    }
  } else {
    await writeState(statePath, state);
  }
  return state;
}

export async function evaluateCanary(
  inputs: string[],
  options: {
    stub?: boolean;
    archive?: string;
    statePath?: string;
    repo?: EvolutionRepository;
    evalDir?: string;
  } = {},
): Promise<{
  state: CanaryState;
  champion: EvolutionRecord[];
  variant: EvolutionRecord[];
  decision: CanaryDecision;
}> {
  const statePath = options.statePath ?? DEFAULT_STATE;
  const stored = options.repo ? await options.repo.getState() : null;
  const state = options.repo ? stored?.state : await readState(statePath);
  if (!state?.canary || state.canary.status !== "active") {
    throw new Error("no active canary");
  }
  if (inputs.length === 0) {
    throw new Error("at least one input is required");
  }

  const champion: EvolutionRecord[] = [];
  const variant: EvolutionRecord[] = [];
  const evalDir = options.evalDir ?? state.canary.evalSnapshotPath;

  for (const input of inputs) {
    champion.push(
      await scoreVariant(
        state.champion.path,
        state.champion.path,
        input,
        state.canary.agentId,
        {
          stub: options.stub,
          archive: options.archive,
          ...(options.repo ? { repo: options.repo } : {}),
          ...(evalDir ? { evalDir } : {}),
        },
      ),
    );
    variant.push(
      await scoreVariant(
        state.canary.path,
        state.champion.path,
        input,
        state.canary.agentId,
        {
          stub: options.stub,
          archive: options.archive,
          ...(options.repo ? { repo: options.repo } : {}),
          ...(evalDir ? { evalDir } : {}),
        },
      ),
    );
  }

  const decision = decideRollback(champion, variant);
  state.canary.status = decision.rollback ? "rolled_back" : "active";
  state.canary.reason = decision.reason;
  if (options.repo) {
    const ok = await options.repo.setState(state, stored?.version);
    if (!ok) {
      throw new Error("canary state changed concurrently");
    }
  } else {
    await writeState(statePath, state);
  }

  return { state, champion, variant, decision };
}

export function decideRollback(
  champion: EvolutionRecord[],
  variant: EvolutionRecord[],
): CanaryDecision {
  const championPass = passRate(champion);
  const variantPass = passRate(variant);
  const championScore = averageScore(champion);
  const variantScore = averageScore(variant);
  const championCost = averageCost(champion);
  const variantCost = averageCost(variant);

  if (variantPass < championPass - 0.1) {
    return {
      rollback: true,
      reason: `pass rate ${variantPass.toFixed(2)} below champion ${championPass.toFixed(2)}`,
    };
  }
  if (variantScore < championScore - 0.1) {
    return {
      rollback: true,
      reason: `average score ${variantScore.toFixed(2)} below champion ${championScore.toFixed(2)}`,
    };
  }
  if (championCost > 0 && variantCost > championCost * 1.5) {
    return {
      rollback: true,
      reason: `cost ${variantCost.toFixed(4)} exceeds 1.5x champion ${championCost.toFixed(4)}`,
    };
  }

  return { rollback: false };
}

export async function canaryStatus(
  statePath = DEFAULT_STATE,
  repo?: EvolutionRepository,
): Promise<CanaryState | null> {
  if (repo) {
    return (await repo.getState())?.state ?? null;
  }
  return readState(statePath);
}

export async function rollbackCanary(
  reason = "manual rollback",
  statePath = DEFAULT_STATE,
  repo?: EvolutionRepository,
): Promise<CanaryState> {
  const stored = repo ? await repo.getState() : null;
  const state = repo ? stored?.state : await readState(statePath);
  if (!state?.canary) {
    throw new Error("no canary configured");
  }
  state.canary.status = "rolled_back";
  state.canary.reason = reason;
  if (repo) {
    const ok = await repo.setState(state, stored?.version);
    if (!ok) {
      throw new Error("canary state changed concurrently");
    }
  } else {
    await writeState(statePath, state);
  }
  return state;
}

export async function markCanaryPromoted(
  reason = "promoted by evolution cycle",
  statePath = DEFAULT_STATE,
  repo?: EvolutionRepository,
): Promise<CanaryState> {
  const stored = repo ? await repo.getState() : null;
  const state = repo ? stored?.state : await readState(statePath);
  if (!state?.canary) {
    throw new Error("no canary configured");
  }
  state.canary.status = "promoted";
  state.canary.reason = reason;
  if (repo) {
    const ok = await repo.setState(state, stored?.version);
    if (!ok) {
      throw new Error("canary state changed concurrently");
    }
  } else {
    await writeState(statePath, state);
  }
  return state;
}

async function readMeta(dir: string): Promise<VariantMeta> {
  const metaPath = path.join(dir, "variant.json");
  if (!existsSync(metaPath)) {
    throw new Error(`variant.json missing: ${dir}`);
  }
  return JSON.parse(await readFile(metaPath, "utf8")) as VariantMeta;
}

async function readState(statePath: string): Promise<CanaryState | null> {
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(await readFile(statePath, "utf8")) as CanaryState;
}

async function writeState(
  statePath: string,
  state: CanaryState,
): Promise<void> {
  await mkdir(path.dirname(path.resolve(statePath)), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function passRate(records: EvolutionRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  return records.filter((record) => record.pass).length / records.length;
}

function averageScore(records: EvolutionRecord[]): number {
  const values = records.flatMap((record) => Object.values(record.scores));
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageCost(records: EvolutionRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  return (
    records.reduce((sum, record) => sum + record.costCny, 0) / records.length
  );
}
