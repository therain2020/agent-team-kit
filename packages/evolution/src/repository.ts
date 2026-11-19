import type { CanaryState, EvolutionDecisionRecord } from "./canary";
import type { EvolutionCycleRecord } from "./cycle";
import type { EvolutionRecord, VariantMeta } from "./evolve";
import type { EvolutionFreezeState } from "./freeze";

export interface StoredCanaryState {
  state: CanaryState;
  version: number;
}

export interface StoredVariant {
  meta: VariantMeta;
  dir: string;
}

/**
 * Durable home for evolution variants, scores, cycles and champion/canary
 * state. The Postgres implementation stores variant file contents in the
 * content-addressed blob store; the file implementation is used by tests and
 * legacy local workflows.
 */
export interface EvolutionRepository {
  readonly kind: "postgres" | "sqlite" | "file";
  readonly workspaceId: string;
  ensureReady(): Promise<void>;
  saveVariant(input: {
    meta: VariantMeta;
    dir: string;
    packDir?: string;
  }): Promise<void>;
  getVariant(ref: string): Promise<StoredVariant | null>;
  listVariants(packDir?: string): Promise<StoredVariant[]>;
  materializeVariant(variantId: string, destDir: string): Promise<void>;
  appendScore(record: EvolutionRecord): Promise<void>;
  listScores(variantId?: string): Promise<EvolutionRecord[]>;
  latestScores(): Promise<EvolutionRecord[]>;
  appendCycle(record: EvolutionCycleRecord): Promise<void>;
  listCycles(limit?: number): Promise<EvolutionCycleRecord[]>;
  appendDecision(record: EvolutionDecisionRecord): Promise<void>;
  listDecisions(limit?: number): Promise<EvolutionDecisionRecord[]>;
  getState(): Promise<StoredCanaryState | null>;
  setState(state: CanaryState, expectedVersion?: number): Promise<boolean>;
  setStateWithDecision(
    state: CanaryState,
    decision: EvolutionDecisionRecord,
    expectedVersion?: number,
  ): Promise<boolean>;
  /** Workspace-level freeze switch; null means evolution is active. */
  getFreeze(): Promise<EvolutionFreezeState | null>;
  setFreeze(state: EvolutionFreezeState): Promise<void>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}
