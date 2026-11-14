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
import type { EvolutionRepository } from "./repository";

export const DEFAULT_CYCLES = "variants/cycles.jsonl";

export interface EvolutionCycleRecord {
  cycleId: string;
  packDir: string;
  agentId: string;
  hypothesis: string;
  signals: string[];
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
}

export interface CycleOptions {
  packDir: string;
  agentId?: string;
  inputFile: string;
  signals?: string[];
  stub?: boolean;
  autoApply?: boolean;
  force?: boolean;
  budgetCny?: number;
  archivePath?: string;
  cyclesPath?: string;
  statePath?: string;
  variantsRoot?: string;
  percent?: number;
  repo?: EvolutionRepository;
}

export async function runEvolutionCycle(
  options: CycleOptions,
): Promise<EvolutionCycleRecord> {
  const cycleId = newId("cyc");
  const createdAt = new Date().toISOString();
  const packDir = path.resolve(options.packDir);
  const archivePath = options.archivePath ?? "variants/archive.jsonl";
  const cyclesPath = options.cyclesPath ?? DEFAULT_CYCLES;
  const statePath = options.statePath ?? DEFAULT_STATE;
  const variantsRoot =
    options.variantsRoot ?? path.join(path.dirname(archivePath), "");
  const repo = options.repo;
  if (repo) {
    await repo.ensureReady();
  }
  const persistCycle = (record: EvolutionCycleRecord) =>
    finish(cyclesPath, record, repo);
  const baseRecord: EvolutionCycleRecord = {
    cycleId,
    packDir,
    agentId: options.agentId ?? "",
    hypothesis: "",
    signals: [],
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

    const agentId =
      options.agentId ??
      chooseAgent(loaded.agents, await compareVariants(archivePath, repo));
    if (!agentId) {
      throw new Error("no evolvable agent found");
    }
    const agent = loaded.agents.get(agentId);
    if (!agent) {
      throw new Error(`unknown agent: ${agentId}`);
    }

    const signals = [
      ...(options.signals ?? []),
      ...collectSignals(await compareVariants(archivePath, repo)),
    ].slice(-8);
    if (signals.length === 0 && !options.force) {
      return await persistCycle({
        ...baseRecord,
        agentId,
        decision: "skipped",
        rationale:
          "no failure signals in the archive; pass force to explore anyway",
      });
    }

    const hypothesis =
      signals.length > 0
        ? `Improve ${agentId} against the latest failure signals without changing tools or permissions.`
        : `Explore a more robust ${agentId} instruction set without changing tools or permissions.`;

    const current = await readFile(
      path.join(loaded.dir, agent.spec.file),
      "utf8",
    );
    const currentInstructions = stripFrontmatter(current);
    const proposal = await proposeInstructions({
      agentId,
      currentInstructions,
      signals,
      stub: options.stub ?? false,
    });

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
        ...(repo ? { repo } : {}),
      },
    );

    let costCny =
      proposal.costCny + baselineScore.costCny + candidateScore.costCny;
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

    if (!improved) {
      return await persistCycle({
        ...withScores,
        decision: "rejected",
        rationale: candidateScore.pass
          ? `candidate ${candidateAvg.toFixed(2)} did not beat baseline ${baselineAvg.toFixed(2)} by 0.02`
          : `candidate failed: ${candidateScore.rationale}`,
      });
    }

    await startCanary(
      baseline.dir,
      candidate.dir,
      options.percent ?? 20,
      statePath,
      repo,
    );
    const canary = await evaluateCanary([options.inputFile], {
      stub: options.stub,
      archive: archivePath,
      statePath,
      ...(repo ? { repo } : {}),
    });
    costCny += [...canary.champion, ...canary.variant].reduce(
      (sum, record) => sum + record.costCny,
      0,
    );
    const updated: EvolutionCycleRecord = {
      ...withScores,
      costCny: round(costCny),
    };

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
      await markCanaryPromoted(
        `auto-promoted by evolution cycle ${cycleId}`,
        statePath,
        repo,
      );
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
        return [JSON.parse(line) as EvolutionCycleRecord];
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
  stub: boolean;
}): Promise<{ instructions: string; costCny: number }> {
  if (input.stub || process.env.KIT_MODEL_MODE === "stub") {
    return {
      instructions: deterministicInstructions(
        input.currentInstructions,
        input.signals,
      ),
      costCny: 0,
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

Current instructions:
${input.currentInstructions}

Recent failure signals:
${input.signals.length > 0 ? input.signals.map((signal) => `- ${signal}`).join("\n") : "- explore a more robust approach"}`,
  });
  return {
    instructions: response.text.trim().slice(0, 4000),
    costCny: response.usage.costCny ?? 0,
  };
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

function collectSignals(records: EvolutionRecord[]): string[] {
  return records
    .filter((record) => !record.pass)
    .slice(-5)
    .map(
      (record) =>
        `${record.agentId}${record.name ? `/${record.name}` : ""}: ${record.rationale || "failed evaluation"}`,
    );
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
