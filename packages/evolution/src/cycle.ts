import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId } from "@kit/core";
import { createModelGateway } from "@kit/model";
import { loadPack } from "@kit/pack";
import {
  DEFAULT_STATE,
  evaluateCanary,
  markCanaryPromoted,
  startCanary,
} from "./canary";
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
  error?: string;
  evalSnapshotPath?: string;
  evalSnapshotHash?: string;
  evaluatorHash?: string;
  evaluatorApprovalRef?: string;
}

export interface CycleOptions {
  packDir: string;
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
  cyclesRoot?: string;
  hiddenEvalsDir?: string;
  workspaceId?: string;
  freezeSnapshot?: boolean;
  allowEvaluatorChange?: boolean;
  evaluatorApprovalRef?: string;
}

export async function runEvolutionCycle(
  options: CycleOptions,
): Promise<EvolutionCycleRecord> {
  const cycleId = newId("cyc");
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
  const persistCycle = async (record: EvolutionCycleRecord) => {
    const saved = await finish(cyclesPath, record, repo);
    if (saved.decision === "rejected" || saved.decision === "failed") {
      await maybeFreezeOnConvergence({
        loadRecentCycles,
        window: convergenceWindow,
        freezeOptions,
      });
    }
    return saved;
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

    // Convergence is checked before any spend: once the trailing streak of
    // no-improvement cycles reaches the window, auto-freeze and stop.
    const recentCycles = await loadRecentCycles(convergenceWindow + 5);
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
      return await persistCycle({
        ...baseRecord,
        decision: "skipped",
        rationale: "evolution budget is zero",
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
    const proposal = await proposeInstructions({
      agentId,
      currentInstructions,
      signals,
      hypothesis,
      stub: options.stub ?? false,
    });

    // Stop-loss #1: the proposal is the first model call; if it already blows
    // the cycle budget, stop before any variant or score is written.
    const proposalStop = budgetStop(
      { costCny: proposal.costCny, tokens: proposal.tokens },
      { budgetCny: options.budgetCny, budgetTokens: options.budgetTokens },
    );
    if (proposalStop) {
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
      },
    );
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
      },
    );

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
    const canary = await evaluateCanary([options.inputFile], {
      stub: options.stub,
      archive: archivePath,
      statePath,
      evalDir: snapshot.dir,
      ...(repo ? { repo } : {}),
    });
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

  const gateway = createModelGateway();
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
