import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type EvolutionBudgetLedger,
  type EvolutionBudgetPhase,
  type EvolutionBudgetStatus,
  cnyToMicro,
  evolutionBudgetPurpose,
  microToCny,
  newId,
} from "@kit/core";
import { calculateCostCny, createModelGateway } from "@kit/model";
import { loadPack } from "@kit/pack";
import {
  DEFAULT_STATE,
  evaluateCanary,
  markCanaryPromoted,
  startCanary,
} from "./canary";
import {
  type EvolutionCallAttribution,
  type EvolutionCostAttribution,
  attributedEvolutionGateway,
} from "./cost-attribution";
import {
  DEFAULT_DIVERGENCE_WINDOW,
  type DivergenceSummary,
  buildDivergencePoints,
  divergenceGuard,
  divergenceSummary,
} from "./divergence";
import {
  type DriftBaseline,
  type DriftSummary,
  detectDrift,
  driftSummary,
  inputDistributionOf,
  modelPinFor,
  readDriftBaseline,
  writeDriftBaseline,
} from "./drift";
import {
  type EvolutionRecord,
  compareVariants,
  initVariant,
  proposeVariant,
  scoreVariant,
} from "./evolve";
import {
  DEFAULT_CONVERGENCE_WINDOW,
  type FreezeOptions,
  budgetStop,
  convergenceGuard,
  freezeEvolution,
  frozenRationale,
  loadFreezeState,
} from "./freeze";
import {
  type EvolutionGovernanceEvent,
  appendGovernanceEvent,
  defaultGovernancePath,
} from "./governance";
import {
  type OutcomeObservation,
  type OutcomeSource,
  defaultOutcomesPath,
  evaluatorAgreement,
  latestOutcomeForCycle,
  readOutcomeObservations,
} from "./outcome";
import type { EvolutionRepository } from "./repository";
import {
  type EvolutionSignalRef,
  dedupeSignalRefs,
  defaultIterationsPath,
  hashSignalId,
  iterationSignalRef,
  readIterationSignals,
} from "./signals";
import {
  createEvalSnapshot,
  defaultCyclesRoot,
  evaluatorHashForPack,
  findPreviousEvalSnapshot,
} from "./snapshot";

export const DEFAULT_CYCLES = "variants/cycles.jsonl";

/**
 * One ledger reservation/charge for a cycle phase. A cycle makes at most one
 * reservation per phase (proposal, score, canary), so a phase is charged once
 * even though it may issue several model calls.
 */
export interface EvolutionBudgetRef {
  phase: EvolutionBudgetPhase;
  purpose: string;
  reservationId: string;
  chargeId: string | null;
  budgetId: string | null;
  estimatedCnyMicro: number;
  estimatedTokens: number;
  costCnyMicro: number;
  tokens: number;
  overshoot: boolean;
}

/**
 * Ledger vs cycle reconciliation. `deltaCnyMicro` is the ledger charge total
 * minus the micro-CNY the cycle committed; it must be zero for a healthy
 * cycle, otherwise the cycle record and the ledger disagree.
 */
export interface EvolutionBudgetReconciliation {
  ledgerCnyMicro: number;
  cycleCnyMicro: number;
  deltaCnyMicro: number;
  ok: boolean;
  chargeIds: string[];
}

export interface EvolutionCycleRecord {
  cycleId: string;
  packDir: string;
  agentId: string;
  hypothesis: string;
  signals: string[];
  signalRefs: EvolutionSignalRef[];
  signalSources: string[];
  baselineName: string;
  candidateName: string;
  baselinePass: boolean | null;
  candidatePass: boolean | null;
  baselineScore: number | null;
  candidateScore: number | null;
  costCny: number;
  decision: "promoted" | "canary" | "rejected" | "skipped" | "failed";
  rationale: string;
  autoApplied: boolean;
  createdAt: string;
  /**
   * Outcome of the budget gate: admitted, denied, or no ledger attached.
   * Optional for records written before the ledger existed; runEvolutionCycle
   * always writes it.
   */
  budgetStatus?: EvolutionBudgetStatus;
  /** One entry per charged phase (proposal / score / canary). */
  budgetRefs?: EvolutionBudgetRef[];
  budgetReconciliation?: EvolutionBudgetReconciliation;
  error?: string;
  evalSnapshotPath?: string;
  evalSnapshotHash?: string;
  evaluatorHash?: string;
  evaluatorApprovalRef?: string;
  /**
   * Outcome signal for this cycle when a review/acceptance record already
   * exists (70 §3.4). Reviews usually arrive after the cycle, so the joined
   * view (`attachOutcomes`) is the primary surface; these fields keep the
   * cycle self-describing when the observation is present.
   */
  outcomeScore?: number | null;
  outcomePass?: boolean | null;
  outcomeSource?: OutcomeSource;
  outcomeRef?: string;
  /** Goodhart guard state observed at the start of the cycle. */
  divergence?: DivergenceSummary;
  /** Drift findings observed at the start of the cycle (70 §3.5). */
  drift?: DriftSummary;
}

export interface CycleOptions {
  packDir: string;
  /**
   * Caller-owned cycle id. The trigger plane reserves the job id before the
   * cycle starts, so the ledger admission, TriggerRun and cycle record share
   * one identity.
   */
  cycleId?: string;
  agentId?: string;
  inputFile: string;
  hypothesis?: string;
  signals?: string[];
  stub?: boolean;
  autoApply?: boolean;
  force?: boolean;
  budgetCny?: number;
  budgetTokens?: number;
  archivePath?: string;
  signalsRoot?: string;
  iterationsPath?: string;
  cyclesPath?: string;
  statePath?: string;
  freezePath?: string;
  convergenceWindow?: number;
  variantsRoot?: string;
  percent?: number;
  repo?: EvolutionRepository;
  /**
   * Shared budget ledger. Defaults to `repo.budget`, so store-backed callers
   * (CLI, autopilot) ledger every cycle without touching their call sites.
   */
  budget?: EvolutionBudgetLedger;
  /**
   * Per-call cost ledger sink. Defaults to `repo.costSink`, so store-backed
   * callers ledger every cycle without touching their call sites.
   */
  cost?: EvolutionCostAttribution;
  workspaceId?: string;
  cyclesRoot?: string;
  hiddenEvalsDir?: string;
  freezeSnapshot?: boolean;
  allowEvaluatorChange?: boolean;
  evaluatorApprovalRef?: string;
  /** Outcome observations (acceptance/human review); defaults under signals root. */
  outcomesPath?: string;
  /** Consecutive divergent cycles that pause evolution. */
  divergenceWindow?: number;
  /** Drift baseline file (default `<variantsRoot>/drift-baseline.json`). */
  driftBaselinePath?: string;
  /** Divergence/drift event log (default `<variantsRoot>/governance.jsonl`). */
  governancePath?: string;
  /** Provider pin for model-drift detection (default KIT_MODEL_PROVIDER_PIN). */
  modelPin?: string;
}

export async function runEvolutionCycle(
  options: CycleOptions,
): Promise<EvolutionCycleRecord> {
  const cycleId = options.cycleId?.trim() || newId("cyc");
  const createdAt = new Date().toISOString();
  const packDir = path.resolve(options.packDir);
  const archivePath = options.archivePath ?? "variants/archive.jsonl";
  const iterationsPath =
    options.iterationsPath ?? defaultIterationsPath(options.signalsRoot);
  const cyclesPath = options.cyclesPath ?? DEFAULT_CYCLES;
  const statePath = options.statePath ?? DEFAULT_STATE;
  const variantsRoot =
    options.variantsRoot ?? path.join(path.dirname(archivePath), "");
  const freezePath =
    options.freezePath ?? path.join(variantsRoot, "freeze.json");
  const outcomesPath =
    options.outcomesPath ?? defaultOutcomesPath(options.signalsRoot);
  const driftBaselinePath =
    options.driftBaselinePath ?? path.join(variantsRoot, "drift-baseline.json");
  const governancePath =
    options.governancePath ?? defaultGovernancePath(variantsRoot);
  const divergenceWindow = Math.max(
    1,
    options.divergenceWindow ?? DEFAULT_DIVERGENCE_WINDOW,
  );
  let outcomes: OutcomeObservation[] = [];
  const repo = options.repo;
  if (repo) {
    await repo.ensureReady();
  }
  const freezeOptions: FreezeOptions = {
    freezePath,
    ...(repo ? { repo } : {}),
  };
  const convergenceWindow = Math.max(
    1,
    options.convergenceWindow ?? DEFAULT_CONVERGENCE_WINDOW,
  );
  const loadRecentCycles = async (
    limit: number,
  ): Promise<EvolutionCycleRecord[]> =>
    repo
      ? await repo.listCycles(limit)
      : await loadEvolutionCycles(cyclesPath, limit);
  const ledger = options.budget ?? repo?.budget;
  const workspaceId = options.workspaceId ?? repo?.workspaceId ?? "default";
  const costSink = options.cost?.sink ?? repo?.costSink;
  const costAttribution: EvolutionCallAttribution | undefined = costSink
    ? {
        attribution: {
          sink: costSink,
          workspaceId: options.cost?.workspaceId ?? workspaceId,
        },
        workspaceId,
        changeId: cycleId,
      }
    : undefined;
  const cycleBudgetCnyMicro =
    options.budgetCny === undefined ? null : cnyToMicro(options.budgetCny);
  let budgetStatus: EvolutionBudgetStatus = ledger ? "admitted" : "unledgered";
  const budgetRefs: EvolutionBudgetRef[] = [];
  let cycleChargedCnyMicro = 0;
  let budgetOvershoot = false;

  const reconcileBudget = async (): Promise<
    EvolutionBudgetReconciliation | undefined
  > => {
    if (!ledger) {
      return undefined;
    }
    try {
      const ledgerTotals = await ledger.reconcileEvolution({
        workspaceId,
        cycleId,
      });
      const cycleCnyMicro = budgetRefs.reduce(
        (sum, ref) => sum + ref.costCnyMicro,
        0,
      );
      const deltaCnyMicro = ledgerTotals.chargedCnyMicro - cycleCnyMicro;
      return {
        ledgerCnyMicro: ledgerTotals.chargedCnyMicro,
        cycleCnyMicro,
        deltaCnyMicro,
        ok: deltaCnyMicro === 0,
        chargeIds: ledgerTotals.chargeIds,
      };
    } catch {
      // Reconciliation is diagnostic; never mask the cycle result with it.
      return undefined;
    }
  };
  const withOutcome = (record: EvolutionCycleRecord): EvolutionCycleRecord => {
    const outcome = latestOutcomeForCycle(outcomes, record.cycleId);
    if (!outcome) {
      return record;
    }
    return {
      ...record,
      outcomeScore: outcome.score,
      outcomePass: outcome.pass,
      outcomeSource: outcome.source,
      ...(outcome.ref ? { outcomeRef: outcome.ref } : {}),
    };
  };
  const recordGovernance = async (
    input: Omit<
      EvolutionGovernanceEvent,
      "eventId" | "createdAt" | "workspaceId"
    >,
  ): Promise<void> => {
    try {
      await appendGovernanceEvent({ ...input, workspaceId }, governancePath);
    } catch {
      // Events are explanatory; the cycle record and freeze state remain the
      // durable copy, so a failed append must not change the cycle outcome.
    }
  };
  const persistCycle = async (record: EvolutionCycleRecord) => {
    const reconciliation = await reconcileBudget();
    const saved = await finish(
      cyclesPath,
      withOutcome({
        ...record,
        budgetStatus,
        budgetRefs: [...budgetRefs],
        ...(reconciliation ? { budgetReconciliation: reconciliation } : {}),
      }),
      repo,
    );
    if (saved.decision === "rejected" || saved.decision === "failed") {
      await maybeFreezeOnConvergence({
        loadRecentCycles,
        window: convergenceWindow,
        freezeOptions,
      });
    }
    return saved;
  };
  const budgetExceeded = async (
    phase: EvolutionBudgetPhase | "admission",
    reason: string,
    extra: Partial<EvolutionCycleRecord> = {},
  ) => {
    budgetStatus = "budget_exceeded";
    return await persistCycle({
      ...baseRecord,
      ...snapshotFields,
      ...extra,
      decision: "skipped",
      costCny: round(microToCny(cycleChargedCnyMicro)),
      rationale: `budget_exceeded before ${phase}: ${reason}`,
    });
  };
  /**
   * Reserve before the phase's model calls and commit the actual usage after
   * it. A denial stops the cycle before any further model call. If a phase
   * throws after some calls already ran, the usage recorded by the action is
   * still committed, so a failed cycle never hides spend; a phase that spent
   * nothing releases its reservation instead.
   */
  const runPhase = async <T>(
    phase: EvolutionBudgetPhase,
    estimate: { cnyMicro: number; tokens: number },
    usage: { costCny: number; tokens: number },
    action: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
    if (budgetOvershoot) {
      // 60 §7.3: an overshoot is booked truthfully and the run pauses instead
      // of spending further phases against a breached cap.
      return {
        ok: false,
        reason: "a previous phase overshot the evolution budget",
      };
    }
    if (cycleBudgetCnyMicro !== null) {
      const remaining = cycleBudgetCnyMicro - cycleChargedCnyMicro;
      if (estimate.cnyMicro > remaining) {
        return {
          ok: false,
          reason: `${phase} estimate ${microToCny(estimate.cnyMicro)} CNY exceeds the remaining cycle budget ${microToCny(Math.max(0, remaining))} CNY`,
        };
      }
    }
    if (!ledger) {
      const value = await action();
      cycleChargedCnyMicro += cnyToMicro(usage.costCny);
      return { ok: true, value };
    }
    const reservation = await ledger.reserveEvolution({
      workspaceId,
      cycleId,
      phase,
      amountCnyMicro: estimate.cnyMicro,
      amountTokens: estimate.tokens,
    });
    if (!reservation.ok) {
      return {
        ok: false,
        reason: reservation.message ?? "reservation denied",
      };
    }
    const settle = async (): Promise<void> => {
      const costCnyMicro = cnyToMicro(usage.costCny);
      const tokens = Math.max(0, Math.round(usage.tokens));
      if (!reservation.reservationId) {
        // Zero-amount reservation: nothing was billed, nothing to reconcile.
        cycleChargedCnyMicro += costCnyMicro;
        return;
      }
      const committed = await ledger.commitEvolution(
        reservation.reservationId,
        { cnyMicro: costCnyMicro, tokens },
      );
      if (!committed.ok) {
        throw new Error(
          committed.message ?? `evolution budget commit failed for ${phase}`,
        );
      }
      budgetRefs.push({
        phase,
        purpose: evolutionBudgetPurpose(phase),
        reservationId: reservation.reservationId,
        chargeId: committed.chargeId,
        budgetId: reservation.budgetId,
        estimatedCnyMicro: estimate.cnyMicro,
        estimatedTokens: estimate.tokens,
        costCnyMicro,
        tokens,
        overshoot: committed.overshoot,
      });
      if (committed.overshoot) {
        budgetOvershoot = true;
      }
      cycleChargedCnyMicro += costCnyMicro;
    };

    let value: T;
    try {
      value = await action();
    } catch (error) {
      if (usage.costCny > 0 || usage.tokens > 0) {
        await settle().catch(() => undefined);
      } else if (reservation.reservationId) {
        await ledger
          .releaseEvolution(reservation.reservationId)
          .catch(() => undefined);
      }
      throw error;
    }
    await settle();
    return { ok: true, value };
  };
  let snapshotFields: Partial<EvolutionCycleRecord> = {};
  const baseRecord: EvolutionCycleRecord = {
    cycleId,
    packDir,
    agentId: options.agentId ?? "",
    hypothesis: "",
    signals: [],
    signalRefs: [],
    signalSources: [],
    baselineName: "",
    candidateName: "",
    baselinePass: null,
    candidatePass: null,
    baselineScore: null,
    candidateScore: null,
    costCny: 0,
    decision: "failed",
    rationale: "",
    autoApplied: false,
    createdAt,
    budgetStatus,
    budgetRefs: [],
  };

  try {
    // A freeze is a hard stop: no model calls, no variant writes, no snapshot.
    // It is checked before the evidence file so a missing input cannot mask it.
    const freeze = await loadFreezeState(freezeOptions);
    if (freeze.status === "frozen") {
      return await persistCycle({
        ...baseRecord,
        decision: "skipped",
        rationale: frozenRationale(freeze),
      });
    }

    // Goodhart divergence (70 §3.4) is checked before convergence: when
    // scores rose while outcomes stayed flat or fell, the optimization target
    // itself is suspect, so the reason is recorded as `divergence`, not
    // `convergence`. The check reads outcomes only; it never spends.
    outcomes = (await readOutcomeObservations(outcomesPath)).outcomes;
    const recentCycles = await loadRecentCycles(
      Math.max(convergenceWindow + 5, 50),
    );
    const divergence = divergenceGuard(
      buildDivergencePoints(recentCycles, outcomes),
      { window: divergenceWindow },
    );
    baseRecord.divergence = divergenceSummary(divergence);
    if (divergence.divergent && divergence.hint) {
      const frozen = await freezeEvolution(
        { kind: "divergence", reason: divergence.hint, actor: "system" },
        freezeOptions,
      );
      await recordGovernance({
        kind: "divergence",
        action: "paused",
        reason: divergence.hint,
        cycleIds: divergence.cycleIds,
        details: { ...divergenceSummary(divergence) },
      });
      return await persistCycle({
        ...baseRecord,
        decision: "skipped",
        rationale: frozenRationale(frozen),
      });
    }

    // Convergence is checked before any spend: once the trailing streak of
    // no-improvement cycles reaches the window, auto-freeze and stop.
    const guard = convergenceGuard(recentCycles, convergenceWindow);
    if (guard.frozen && guard.hint) {
      const frozen = await freezeEvolution(
        { kind: "convergence", reason: guard.hint, actor: "system" },
        freezeOptions,
      );
      return await persistCycle({
        ...baseRecord,
        decision: "skipped",
        rationale: frozenRationale(frozen),
      });
    }

    if (!existsSync(options.inputFile)) {
      throw new Error(`evidence input missing: ${options.inputFile}`);
    }
    if (options.budgetCny !== undefined && options.budgetCny <= 0) {
      budgetStatus = "budget_exceeded";
      return await persistCycle({
        ...baseRecord,
        decision: "skipped",
        rationale: "budget_exceeded: evolution budget is zero",
      });
    }

    const loaded = await loadPack(packDir);
    if (!loaded.ok) {
      throw new Error(loaded.errors.join("\n"));
    }

    const archiveRecords = await compareVariants(archivePath, repo);
    const agentId =
      options.agentId ?? chooseAgent(loaded.agents, archiveRecords);
    if (!agentId) {
      throw new Error("no evolvable agent found");
    }
    const agent = loaded.agents.get(agentId);
    if (!agent) {
      throw new Error(`unknown agent: ${agentId}`);
    }
    baseRecord.agentId = agentId;

    const iterations = await readIterationSignals(iterationsPath);

    // Drift (70 §3.5): the input distribution, evaluator-vs-human agreement
    // and the provider pin are compared with the previous cycle's baseline.
    // A finding forces a full champion re-evaluation: this cycle re-scores the
    // baseline against the frozen snapshot instead of trusting the incremental
    // history, and the reason is written as an event.
    const agreement = evaluatorAgreement(recentCycles, outcomes);
    const currentBaseline: DriftBaseline = {
      modelPin:
        options.modelPin ??
        modelPinFor(
          agent.frontmatter.model,
          process.env.KIT_MODEL_PROVIDER_PIN,
        ),
      inputDistribution: inputDistributionOf(iterations.signals),
      agreement: agreement.rate,
      sample: agreement.sample,
      updatedAt: new Date().toISOString(),
    };
    const previousBaseline = await readDriftBaseline(driftBaselinePath).catch(
      () => null,
    );
    const drift = detectDrift({
      previous: previousBaseline,
      current: currentBaseline,
    });
    baseRecord.drift = driftSummary(drift);
    if (drift.drifted) {
      await recordGovernance({
        kind: "drift",
        action: drift.reevaluateChampion ? "reevaluate" : "alert",
        reason: drift.reasons.join("; "),
        cycleIds: [cycleId],
        details: { ...driftSummary(drift) },
      });
    }
    // The baseline is advisory: a failed write only means the next cycle sees
    // no previous snapshot, never that this cycle fails.
    await writeDriftBaseline(driftBaselinePath, currentBaseline).catch(
      () => undefined,
    );

    const manualRefs = (options.signals ?? []).map((signal) => ({
      signalId: hashSignalId(`manual ${signal}`),
      source: "manual" as const,
      signal,
    }));
    const iterationRefs = iterations.signals
      .filter((signal) => !signal.verified)
      .map(iterationSignalRef);
    const signalRefs = dedupeSignalRefs([
      ...manualRefs,
      ...collectSignals(archiveRecords),
      ...iterationRefs,
    ]).slice(-8);
    const signals = signalRefs.map((ref) => ref.signal);
    baseRecord.signalRefs = signalRefs;
    baseRecord.signalSources = describeSignalSources(signalRefs, {
      archivePath,
      iterationsPath,
    });
    if (signals.length === 0 && !options.force) {
      return await persistCycle({
        ...baseRecord,
        agentId,
        decision: "skipped",
        rationale:
          "no failure signals in iterations or the archive; pass force to explore anyway",
      });
    }

    const cyclesRoot = options.cyclesRoot ?? defaultCyclesRoot();
    const evaluatorHash = await evaluatorHashForPack(loaded.dir);
    const previous = await findPreviousEvalSnapshot({
      cyclesRoot,
      excludeCycleId: cycleId,
      packDir: loaded.dir,
    });
    const evaluatorChanged =
      previous !== null && previous.manifest.evaluatorHash !== evaluatorHash;
    if (evaluatorChanged && !options.allowEvaluatorChange) {
      return await persistCycle({
        ...baseRecord,
        evaluatorHash,
        decision: "skipped",
        rationale: `evaluator changed since cycle ${previous.manifest.cycleId}; pass --approve-evaluator-change with an approval reference`,
      });
    }

    const snapshot = await createEvalSnapshot({
      cycleId,
      packDir: loaded.dir,
      cyclesRoot,
      ...(options.hiddenEvalsDir
        ? { hiddenEvalsDir: options.hiddenEvalsDir }
        : {}),
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.freezeSnapshot === undefined
        ? {}
        : { freeze: options.freezeSnapshot }),
      expectedEvaluatorHash: evaluatorHash,
    });
    snapshotFields = {
      evalSnapshotPath: snapshot.dir,
      evalSnapshotHash: snapshot.manifestHash,
      evaluatorHash: snapshot.manifest.evaluatorHash,
      ...(evaluatorChanged
        ? {
            evaluatorApprovalRef:
              options.evaluatorApprovalRef ?? "operator-approved",
          }
        : {}),
    };

    const hypothesis =
      options.hypothesis?.trim() ||
      (signals.length > 0
        ? `Improve ${agentId} against ${signals.length} failure signal(s) from ${citeSignals(signalRefs)} without changing tools or permissions.`
        : `Explore a more robust ${agentId} instruction set without changing tools or permissions.`);

    const current = await readFile(
      path.join(loaded.dir, agent.spec.file),
      "utf8",
    );
    const currentInstructions = stripFrontmatter(current);
    const evidenceChars = fileChars(options.inputFile);
    const proposalEstimate = estimateEvolutionCall(
      hypothesis.length + signals.join("").length + currentInstructions.length,
      2000,
    );
    // A cycle scores baseline + candidate (draft + judge each) and evaluates
    // the canary against one input (champion + variant, draft + judge each).
    const scoreEstimate = estimateEvolutionCalls(4, evidenceChars, 2048);
    const canaryEstimate = estimateEvolutionCalls(2, evidenceChars, 2048);
    const cycleEstimate = {
      cnyMicro:
        proposalEstimate.cnyMicro +
        scoreEstimate.cnyMicro +
        canaryEstimate.cnyMicro,
      tokens:
        proposalEstimate.tokens + scoreEstimate.tokens + canaryEstimate.tokens,
    };
    if (ledger) {
      const admission = await ledger.admitEvolution({
        workspaceId,
        estimateCnyMicro: cycleEstimate.cnyMicro,
        estimateTokens: cycleEstimate.tokens,
      });
      if (!admission.ok) {
        return await budgetExceeded(
          "admission",
          admission.reason ?? "evolution budget is not available",
          { agentId, hypothesis, signals },
        );
      }
    }
    if (
      cycleBudgetCnyMicro !== null &&
      cycleEstimate.cnyMicro > cycleBudgetCnyMicro
    ) {
      return await budgetExceeded(
        "admission",
        `estimated cycle cost ${microToCny(cycleEstimate.cnyMicro)} CNY exceeds the configured cycle budget ${microToCny(cycleBudgetCnyMicro)} CNY`,
        { agentId, hypothesis, signals },
      );
    }

    const proposalUsage = { costCny: 0, tokens: 0 };
    const proposalRun = await runPhase(
      "proposal",
      proposalEstimate,
      proposalUsage,
      async () => {
        const result = await proposeInstructions({
          agentId,
          currentInstructions,
          signals,
          hypothesis,
          stub: options.stub ?? false,
          ...(costAttribution ? { cost: costAttribution } : {}),
        });
        proposalUsage.costCny = result.costCny;
        proposalUsage.tokens = result.tokens;
        return result;
      },
    );
    if (!proposalRun.ok) {
      return await budgetExceeded("proposal", proposalRun.reason, {
        agentId,
        hypothesis,
        signals,
      });
    }
    const proposal = proposalRun.value;

    // Stop-loss #1: the proposal is the first model call; if it already blows
    // the cycle budget, stop before any variant or score is written.
    const proposalStop = budgetStop(
      { costCny: proposal.costCny, tokens: proposal.tokens },
      { budgetCny: options.budgetCny, budgetTokens: options.budgetTokens },
    );
    if (proposalStop) {
      budgetStatus = "budget_exceeded";
      return await persistCycle({
        ...baseRecord,
        ...snapshotFields,
        agentId,
        hypothesis,
        signals,
        costCny: round(proposal.costCny),
        decision: "skipped",
        rationale: proposalStop,
      });
    }

    const stamp = cycleId.replace(/[^a-z0-9]/gi, "").slice(-10);
    const baselineDir = path.join(variantsRoot, `cycle-${stamp}-baseline`);
    const candidateDir = path.join(variantsRoot, `cycle-${stamp}-candidate`);
    const baseline = await initVariant(
      loaded.dir,
      baselineDir,
      `cycle-${stamp}-baseline`,
    );
    if (repo) {
      await repo.saveVariant({
        meta: baseline.meta,
        dir: baseline.dir,
        packDir: loaded.dir,
      });
    }

    const proposalFile = path.join(variantsRoot, "proposals", `${cycleId}.md`);
    await mkdir(path.dirname(proposalFile), { recursive: true });
    await writeFile(proposalFile, proposal.instructions, "utf8");

    const candidate = await proposeVariant(
      baseline.dir,
      agentId,
      proposalFile,
      candidateDir,
      `cycle-${stamp}-candidate`,
      agent.frontmatter.model,
    );
    if (repo) {
      await repo.saveVariant({
        meta: candidate.meta,
        dir: candidate.dir,
        packDir: loaded.dir,
      });
    }

    // Baseline and candidate scoring are one phase: both must run for the
    // comparison to mean anything, so they are reserved and charged together.
    const scoreUsage = { costCny: 0, tokens: 0 };
    const scoreRun = await runPhase(
      "score",
      scoreEstimate,
      scoreUsage,
      async () => {
        const baselineScore = await scoreVariant(
          baseline.dir,
          loaded.dir,
          options.inputFile,
          agentId,
          {
            stub: options.stub,
            archive: archivePath,
            evalDir: snapshot.dir,
            ...(repo ? { repo } : {}),
            ...(costAttribution ? { cost: costAttribution } : {}),
          },
        );
        scoreUsage.costCny += baselineScore.costCny;
        scoreUsage.tokens += baselineScore.tokens;
        const candidateScore = await scoreVariant(
          candidate.dir,
          loaded.dir,
          options.inputFile,
          agentId,
          {
            stub: options.stub,
            archive: archivePath,
            evalDir: snapshot.dir,
            ...(repo ? { repo } : {}),
            ...(costAttribution ? { cost: costAttribution } : {}),
          },
        );
        scoreUsage.costCny += candidateScore.costCny;
        scoreUsage.tokens += candidateScore.tokens;
        return { baselineScore, candidateScore };
      },
    );
    if (!scoreRun.ok) {
      return await budgetExceeded("score", scoreRun.reason, {
        agentId,
        hypothesis,
        signals,
        baselineName: baseline.meta.name,
        candidateName: candidate.meta.name,
      });
    }
    const { baselineScore, candidateScore } = scoreRun.value;

    let costCny =
      proposal.costCny + baselineScore.costCny + candidateScore.costCny;
    let tokens = proposal.tokens + baselineScore.tokens + candidateScore.tokens;
    const baselineAvg = averageScore(baselineScore);
    const candidateAvg = averageScore(candidateScore);
    const improved = options.stub
      ? candidateScore.pass
      : (candidateScore.pass && !baselineScore.pass) ||
        (candidateScore.pass &&
          baselineScore.pass &&
          candidateAvg >= baselineAvg + 0.02);

    const withScores: EvolutionCycleRecord = {
      ...baseRecord,
      ...snapshotFields,
      agentId,
      hypothesis,
      signals,
      baselineName: baseline.meta.name,
      candidateName: candidate.meta.name,
      baselinePass: baselineScore.pass,
      candidatePass: candidateScore.pass,
      baselineScore: baselineAvg,
      candidateScore: candidateAvg,
      costCny: round(costCny),
    };

    // Stop-loss #2: scoring spent the second and third model calls.
    const scoreStop = budgetStop(
      { costCny, tokens },
      { budgetCny: options.budgetCny, budgetTokens: options.budgetTokens },
    );
    if (scoreStop) {
      budgetStatus = "budget_exceeded";
      return await persistCycle({
        ...withScores,
        decision: "skipped",
        rationale: scoreStop,
      });
    }

    if (!improved) {
      return await persistCycle({
        ...withScores,
        decision: "rejected",
        rationale: candidateScore.pass
          ? `candidate ${candidateAvg.toFixed(2)} did not beat baseline ${baselineAvg.toFixed(2)} by 0.02`
          : `candidate failed: ${candidateScore.rationale}`,
      });
    }

    await startCanary(baseline.dir, candidate.dir, {
      trafficPercent: options.percent ?? 0,
      statePath,
      ...(repo ? { repo } : {}),
      evalDir: snapshot.dir,
    });
    const canaryUsage = { costCny: 0, tokens: 0 };
    const canaryRun = await runPhase(
      "canary",
      canaryEstimate,
      canaryUsage,
      async () => {
        const value = await evaluateCanary([options.inputFile], {
          stub: options.stub,
          archive: archivePath,
          statePath,
          evalDir: snapshot.dir,
          ...(repo ? { repo } : {}),
          ...(costAttribution
            ? { cost: { ...costAttribution, phase: "canary" } }
            : {}),
        });
        for (const record of [...value.champion, ...value.variant]) {
          canaryUsage.costCny += record.costCny;
          canaryUsage.tokens += record.tokens;
        }
        return value;
      },
    );
    if (!canaryRun.ok) {
      return await budgetExceeded("canary", canaryRun.reason, {
        agentId,
        hypothesis,
        signals,
        baselineName: baseline.meta.name,
        candidateName: candidate.meta.name,
        baselinePass: baselineScore.pass,
        candidatePass: candidateScore.pass,
        baselineScore: averageScore(baselineScore),
        candidateScore: averageScore(candidateScore),
      });
    }
    const canary = canaryRun.value;
    costCny += [...canary.champion, ...canary.variant].reduce(
      (sum, record) => sum + record.costCny,
      0,
    );
    tokens += [...canary.champion, ...canary.variant].reduce(
      (sum, record) => sum + record.tokens,
      0,
    );
    const updated: EvolutionCycleRecord = {
      ...withScores,
      costCny: round(costCny),
    };

    // Stop-loss #3: the canary evaluation is the last spend of the cycle.
    const canaryStop = budgetStop(
      { costCny, tokens },
      { budgetCny: options.budgetCny, budgetTokens: options.budgetTokens },
    );
    if (canaryStop) {
      budgetStatus = "budget_exceeded";
      return await persistCycle({
        ...updated,
        decision: "skipped",
        rationale: canaryStop,
      });
    }

    if (canary.decision.rollback) {
      return await persistCycle({
        ...updated,
        decision: "rejected",
        rationale: `canary rolled back: ${canary.decision.reason ?? "regression"}`,
      });
    }

    if (options.autoApply && !options.stub) {
      const { promoteVariant } = await import("./evolve");
      await promoteVariant(candidate.dir, loaded.dir, true, repo);
      await markCanaryPromoted(`auto-promoted by evolution cycle ${cycleId}`, {
        statePath,
        ...(repo ? { repo } : {}),
      });
      return await persistCycle({
        ...updated,
        decision: "promoted",
        autoApplied: true,
        rationale: "candidate passed the canary and was promoted with a backup",
      });
    }

    return await persistCycle({
      ...updated,
      decision: "canary",
      rationale: options.stub
        ? "stub mode: deterministic checks passed; live quality scoring and promotion remain manual"
        : "candidate passed the canary; promotion awaits an explicit operator action",
    });
  } catch (error) {
    return await persistCycle({
      ...baseRecord,
      ...snapshotFields,
      decision: "failed",
      error: error instanceof Error ? error.message : String(error),
      rationale: "evolution cycle failed",
    });
  }
}

export async function loadEvolutionCycles(
  cyclesPath = DEFAULT_CYCLES,
  limit = 50,
  repo?: EvolutionRepository,
): Promise<EvolutionCycleRecord[]> {
  if (repo) {
    return await repo.listCycles(limit);
  }
  if (!existsSync(cyclesPath)) {
    return [];
  }
  const text = await readFile(cyclesPath, "utf8");
  const records = text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as EvolutionCycleRecord;
        return [
          {
            ...record,
            signalRefs: record.signalRefs ?? [],
            signalSources: record.signalSources ?? [],
            budgetStatus: record.budgetStatus ?? "unledgered",
            budgetRefs: record.budgetRefs ?? [],
          },
        ];
      } catch {
        return [];
      }
    });
  return records.slice(-limit).reverse();
}

async function proposeInstructions(input: {
  agentId: string;
  currentInstructions: string;
  signals: string[];
  hypothesis?: string;
  stub: boolean;
  cost?: EvolutionCallAttribution;
}): Promise<{ instructions: string; costCny: number; tokens: number }> {
  if (input.stub || process.env.KIT_MODEL_MODE === "stub") {
    return {
      instructions: deterministicInstructions(
        input.currentInstructions,
        input.signals,
      ),
      costCny: 0,
      tokens: 0,
    };
  }

  const baseGateway = createModelGateway();
  const gateway = input.cost
    ? attributedEvolutionGateway(baseGateway, {
        attribution: input.cost.attribution,
        workspaceId: input.cost.workspaceId,
        changeId: input.cost.changeId,
        phase: input.cost.phase ?? "proposal",
      })
    : baseGateway;
  const response = await gateway.complete({
    model: "deepseek-pro",
    instructions: `You are a meta-agent improving another agent's role instructions.

Rules:
- Return ONLY the new role instructions, no frontmatter, no commentary.
- Do not add or change tools, permissions, models, or files.
- Keep the existing output contract and citation rules.
- Fix the failure signals directly and keep the instructions under 2000 characters.
- Do not mention these instructions or the meta-agent.`,
    input: `Agent: ${input.agentId}

Hypothesis to test:
${input.hypothesis || "- improve reliability against the failure signals"}

Current instructions:
${input.currentInstructions}

Recent failure signals:
${input.signals.length > 0 ? input.signals.map((signal) => `- ${signal}`).join("\n") : "- explore a more robust approach"}`,
  });
  return {
    instructions: response.text.trim().slice(0, 4000),
    costCny: response.usage.costCny ?? 0,
    tokens: response.usage.inputTokens + response.usage.outputTokens,
  };
}

/**
 * After a non-improving cycle is recorded, auto-freeze when the trailing
 * no-improvement streak reaches the convergence window. The freeze is
 * idempotent with the start-of-cycle guard; failures here must not invalidate
 * the cycle that was already persisted.
 */
async function maybeFreezeOnConvergence(input: {
  loadRecentCycles: (limit: number) => Promise<EvolutionCycleRecord[]>;
  window: number;
  freezeOptions: FreezeOptions;
}): Promise<void> {
  try {
    const current = await loadFreezeState(input.freezeOptions);
    if (current.status === "frozen") {
      return;
    }
    const recent = await input.loadRecentCycles(input.window + 5);
    const guard = convergenceGuard(recent, input.window);
    if (guard.frozen && guard.hint) {
      await freezeEvolution(
        { kind: "convergence", reason: guard.hint, actor: "system" },
        input.freezeOptions,
      );
    }
  } catch {
    // Freezes are advisory to the cycle record; a failed write must not turn
    // an already-persisted cycle into a duplicate failure record.
  }
}

/**
 * Conservative upper bound for a single model call, mirroring the engine's
 * estimator: 1 char ≈ 1 token plus 500 overhead, and the requested output
 * bound. Sized for the most expensive alias so the reservation never under-reserves.
 */
function estimateEvolutionCall(
  inputChars: number,
  maxOutputTokens: number,
): { cnyMicro: number; tokens: number } {
  return estimateEvolutionCalls(1, inputChars, maxOutputTokens);
}

function estimateEvolutionCalls(
  calls: number,
  inputChars: number,
  maxOutputTokens: number,
): { cnyMicro: number; tokens: number } {
  const inputTokens = Math.max(1, Math.ceil(inputChars) + 500);
  const outputTokens = Math.max(1, Math.ceil(maxOutputTokens));
  const count = Math.max(1, Math.ceil(calls));
  return {
    cnyMicro: cnyToMicro(
      calculateCostCny("deepseek-pro", inputTokens, outputTokens) * count,
    ),
    tokens: (inputTokens + outputTokens) * count,
  };
}

function fileChars(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function deterministicInstructions(current: string, signals: string[]): string {
  const rules = [
    "Every factual claim must carry an inline [S#] citation that exists in the evidence set.",
    "If the evidence does not support a claim, say so and do not invent it.",
    "Follow the required output structure exactly and keep the Recommendations section.",
    "Before finishing, verify each citation against the evidence set.",
  ];
  const focus = signals
    .slice(-3)
    .map((signal) => `- Address this observed failure: ${signal}`)
    .join("\n");
  return `${current.trim()}

## Reliability rules (evolved)
${rules.map((rule) => `- ${rule}`).join("\n")}
${focus ? `\n### Recent failure focus\n${focus}` : ""}
`;
}

function collectSignals(records: EvolutionRecord[]): EvolutionSignalRef[] {
  return records
    .filter((record) => !record.pass)
    .slice(-5)
    .map((record) => ({
      signalId: hashSignalId(
        `archive ${record.variantId} ${record.createdAt} ${record.rationale}`,
      ),
      source: "archive" as const,
      signal: `${record.agentId}${record.name ? `/${record.name}` : ""}: ${record.rationale || "failed evaluation"}`,
      variantId: record.variantId,
      agentId: record.agentId,
    }));
}

function describeSignalSources(
  refs: EvolutionSignalRef[],
  paths: { archivePath: string; iterationsPath: string },
): string[] {
  const sources: string[] = [];
  if (refs.some((ref) => ref.source === "manual")) {
    sources.push("manual");
  }
  if (refs.some((ref) => ref.source === "archive")) {
    sources.push(`archive:${paths.archivePath}`);
  }
  if (refs.some((ref) => ref.source === "iterations")) {
    sources.push(`iterations:${paths.iterationsPath}`);
  }
  return sources;
}

/**
 * Names the signal sources and the most recent refs so the hypothesis is
 * traceable on its own, without re-reading the cycle record.
 */
function citeSignals(refs: EvolutionSignalRef[]): string {
  const kinds: string[] = [];
  for (const ref of refs) {
    const kind =
      ref.source === "iterations"
        ? "iterations.jsonl"
        : ref.source === "archive"
          ? "archive.jsonl"
          : "operator signals";
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  const examples = refs
    .slice(-2)
    .map((ref) => {
      if (ref.source === "iterations" && ref.iterationId) {
        return `${ref.iterationId}/${ref.taskId ?? "task"}`;
      }
      return ref.source === "archive" && ref.variantId ? ref.variantId : "";
    })
    .filter(Boolean);
  const suffix = examples.length > 0 ? ` (${examples.join(", ")})` : "";
  return `${kinds.join(" + ")}${suffix}`;
}

function chooseAgent(
  agents: ReadonlyMap<string, unknown>,
  records: EvolutionRecord[],
): string | undefined {
  const failedAgents = records
    .filter((record) => !record.pass)
    .map((record) => record.agentId);
  const failed = failedAgents.at(-1);
  if (failed && agents.has(failed)) {
    return failed;
  }
  const candidates = [...agents.keys()].filter((id) => id !== "manager");
  return candidates.at(-1) ?? candidates[0];
}

async function finish(
  cyclesPath: string,
  record: EvolutionCycleRecord,
  repo?: EvolutionRepository,
): Promise<EvolutionCycleRecord> {
  if (repo) {
    await repo.appendCycle(record);
    return record;
  }
  await mkdir(path.dirname(path.resolve(cyclesPath)), { recursive: true });
  await appendFile(cyclesPath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function averageScore(record: EvolutionRecord): number {
  const values = Object.values(record.scores);
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
