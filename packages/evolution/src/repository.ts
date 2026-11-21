import type { EvolutionBudgetLedger } from "@kit/core";
import type { CostLedgerSink } from "@kit/model";
import type { ChangeProposalService } from "@kit/store";
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
  /**
   * Shared budget ledger. Store-backed repositories expose the budget service
   * so every cycle reserves/commits its model calls; file repositories (tests,
   * legacy local flows) leave it undefined and cycles stay `unledgered`.
   */
  readonly budget?: EvolutionBudgetLedger;
  /**
   * Per-call cost ledger sink. Store-backed repositories expose it so every
   * cycle charges its model calls to the cycle (`changeId`) without each call
   * site passing a sink; file repositories leave it undefined.
   */
  readonly costSink?: CostLedgerSink;
  /**
   * Unified change pipeline. Store-backed repositories expose it so an
   * auto-promoted cycle can persist its rollbackable `cycle.promote` proposal
   * (85 §3.5.6); file repositories leave it undefined.
   */
  readonly changeProposals?: ChangeProposalService;
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
