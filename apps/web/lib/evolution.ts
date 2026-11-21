import path from "node:path";
import {
  type CanaryState,
  type DivergenceGuardResult,
  type DriftSummary,
  type EvaluatorAgreement,
  type EvolutionCycleRecord,
  type EvolutionDecisionRecord,
  type EvolutionFreezeState,
  type EvolutionGovernanceEvent,
  type EvolutionRecord,
  type OutcomeObservation,
  type OutcomeSummary,
  StoreEvolutionRepository,
  type VariantMeta,
  buildDivergencePoints,
  defaultGovernancePath,
  divergenceGuard,
  evaluatorAgreement,
  loadGovernanceEvents,
  readOutcomeObservations,
  summarizeOutcomes,
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
  freeze: EvolutionFreezeState;
  variants: VariantView[];
  cycles: EvolutionCycleRecord[];
  decisions: EvolutionDecisionRecord[];
  /** Outcome observations from acceptance/human review (70 §3.4). */
  outcomes: OutcomeObservation[];
  outcomeSummary: OutcomeSummary;
  agreement: EvaluatorAgreement;
  /** Score-up/outcome-down guard state over reviewed cycles. */
  divergence: DivergenceGuardResult;
  /** Drift findings from the most recent cycle that computed them. */
  drift: DriftSummary | null;
  governanceEvents: EvolutionGovernanceEvent[];
  archivePath: string;
  statePath: string;
  freezePath: string;
  cyclesPath: string;
  governancePath: string;
  repoRoot: string;
}

export async function loadEvolutionData(): Promise<EvolutionData> {
  await ensureStoreSchema();
  const repoRoot = getRepoRoot();
  const variantsRoot = path.join(repoRoot, "variants");
  const repo = new StoreEvolutionRepository(getStore(), { variantsRoot });
  await repo.ensureReady();

  const governanceFile = defaultGovernancePath(variantsRoot);
  const [storedState, freeze, records, cycles, storedVariants, decisions] =
    await Promise.all([
      repo.getState(),
      repo.getFreeze(),
      repo.latestScores(),
      repo.listCycles(50),
      repo.listVariants(),
      repo.listDecisions(20),
    ]);
  const [outcomeFile, governanceEvents] = await Promise.all([
    readOutcomeObservations(),
    loadGovernanceEvents(governanceFile, 10),
  ]);
  const divergence = divergenceGuard(
    buildDivergencePoints(cycles, outcomeFile.outcomes),
  );
  const drift = cycles.find((cycle) => cycle.drift)?.drift ?? null;

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
    freeze: freeze ?? { workspaceId: repo.workspaceId, status: "active" },
    variants,
    cycles,
    decisions,
    outcomes: outcomeFile.outcomes,
    outcomeSummary: summarizeOutcomes(outcomeFile.outcomes),
    agreement: evaluatorAgreement(cycles, outcomeFile.outcomes),
    divergence,
    drift,
    governanceEvents,
    archivePath: path.join(variantsRoot, "archive.jsonl"),
    statePath: path.join(variantsRoot, "state.json"),
    freezePath: path.join(variantsRoot, "freeze.json"),
    cyclesPath: path.join(variantsRoot, "cycles.jsonl"),
    governancePath: governanceFile,
    repoRoot,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
