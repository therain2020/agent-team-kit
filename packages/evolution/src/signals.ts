import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface IterationSignal {
  at: string;
  iterationId: string;
  taskId: string;
  domain: string;
  coder: string;
  verified: boolean;
  applied: boolean;
  risk: "low" | "medium" | "high";
  tokens: number;
  error?: string;
}

export type SignalSourceKind = "iterations" | "archive" | "manual";

/**
 * Traceable pointer from an evolution cycle back to the failure signal that
 * motivated it. The cycle record is the durable copy: JSONL files stay an
 * adapter layer and never become the source of truth (D-52).
 */
export interface EvolutionSignalRef {
  signalId: string;
  source: SignalSourceKind;
  signal: string;
  iterationId?: string;
  taskId?: string;
  domain?: string;
  variantId?: string;
  agentId?: string;
}

export interface IterationSignalFile {
  path: string;
  signals: IterationSignal[];
  lines: number;
  corrupt: number;
  duplicates: number;
}

const RISK_LEVELS = new Set(["low", "medium", "high"]);

export function defaultSignalsRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.KIT_SIGNALS_ROOT ??
    path.join(os.homedir(), ".agent-team-kit", "signals")
  );
}

export function defaultIterationsPath(root?: string): string {
  return path.join(root ?? defaultSignalsRoot(), "iterations.jsonl");
}

/**
 * Reads `iterations.jsonl` defensively. Missing files, blank lines and
 * corrupt JSON are skipped; duplicate records (same iteration, task and
 * timestamp) are collapsed on first occurrence. The result is deterministic
 * regardless of how many times the file was appended to.
 */
export async function readIterationSignals(
  file: string = defaultIterationsPath(),
): Promise<IterationSignalFile> {
  const empty: IterationSignalFile = {
    path: file,
    signals: [],
    lines: 0,
    corrupt: 0,
    duplicates: 0,
  };

  if (!existsSync(file)) {
    return empty;
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return empty;
  }

  const signals: IterationSignal[] = [];
  const seen = new Set<string>();
  let lines = 0;
  let corrupt = 0;
  let duplicates = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!isIterationSignal(parsed)) {
      corrupt += 1;
      continue;
    }
    const id = iterationSignalId(parsed);
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    signals.push(parsed);
  }
  return { path: file, signals, lines, corrupt, duplicates };
}

export function isIterationSignal(value: unknown): value is IterationSignal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === "string" &&
    typeof record.iterationId === "string" &&
    record.iterationId.length > 0 &&
    typeof record.taskId === "string" &&
    record.taskId.length > 0 &&
    typeof record.domain === "string" &&
    typeof record.coder === "string" &&
    typeof record.verified === "boolean" &&
    typeof record.applied === "boolean" &&
    typeof record.risk === "string" &&
    RISK_LEVELS.has(record.risk) &&
    typeof record.tokens === "number" &&
    Number.isFinite(record.tokens) &&
    (record.error === undefined || typeof record.error === "string")
  );
}

export function hashSignalId(input: string, prefix = "sig"): string {
  const digest = createHash("sha256").update(input).digest("hex").slice(0, 16);
  return `${prefix}_${digest}`;
}

export function iterationSignalId(
  signal: Pick<IterationSignal, "iterationId" | "taskId" | "at">,
): string {
  return hashSignalId(`${signal.iterationId}|${signal.taskId}|${signal.at}`);
}

export function describeIterationSignal(signal: IterationSignal): string {
  const failure = signal.error ? `: ${signal.error}` : "";
  return `${signal.iterationId}/${signal.taskId} ${signal.domain}: verification failed${failure}`;
}

export function iterationSignalRef(
  signal: IterationSignal,
): EvolutionSignalRef {
  return {
    signalId: iterationSignalId(signal),
    source: "iterations",
    signal: describeIterationSignal(signal),
    iterationId: signal.iterationId,
    taskId: signal.taskId,
    domain: signal.domain,
  };
}

export function dedupeSignalRefs(
  refs: readonly EvolutionSignalRef[],
): EvolutionSignalRef[] {
  const seen = new Set<string>();
  const result: EvolutionSignalRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.signalId)) {
      continue;
    }
    seen.add(ref.signalId);
    result.push(ref);
  }
  return result;
}

export interface DomainFitness {
  domain: string;
  total: number;
  verified: number;
  applied: number;
  failed: number;
  passRate: number;
  applyRate: number;
  avgTokens: number;
  risks: Record<string, number>;
}

export interface ImprovementProposal {
  domain: string;
  title: string;
  rationale: string;
  suggestedRules: string[];
}

export interface SignalSummary {
  total: number;
  verified: number;
  applied: number;
  passRate: number;
  applyRate: number;
  domains: DomainFitness[];
}

export function summarizeSignals(signals: IterationSignal[]): SignalSummary {
  const byDomain = new Map<string, IterationSignal[]>();
  for (const signal of signals) {
    const list = byDomain.get(signal.domain) ?? [];
    list.push(signal);
    byDomain.set(signal.domain, list);
  }

  const domains = [...byDomain.entries()]
    .map(([domain, list]) => {
      const verified = list.filter((signal) => signal.verified).length;
      const applied = list.filter((signal) => signal.applied).length;
      const risks: Record<string, number> = {};
      let tokens = 0;
      for (const signal of list) {
        risks[signal.risk] = (risks[signal.risk] ?? 0) + 1;
        tokens += signal.tokens;
      }
      return {
        domain,
        total: list.length,
        verified,
        applied,
        failed: list.length - verified,
        passRate: list.length > 0 ? verified / list.length : 0,
        applyRate: verified > 0 ? applied / verified : 0,
        avgTokens: list.length > 0 ? Math.round(tokens / list.length) : 0,
        risks,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));

  const total = signals.length;
  const verified = signals.filter((signal) => signal.verified).length;
  const applied = signals.filter((signal) => signal.applied).length;

  return {
    total,
    verified,
    applied,
    passRate: total > 0 ? verified / total : 0,
    applyRate: verified > 0 ? applied / verified : 0,
    domains,
  };
}

export function proposeImprovements(
  summary: SignalSummary,
  options: { minSignals?: number; passRate?: number } = {},
): ImprovementProposal[] {
  const minSignals = options.minSignals ?? 2;
  const passRateThreshold = options.passRate ?? 0.5;
  const proposals: ImprovementProposal[] = [];

  for (const domain of summary.domains) {
    if (domain.total < minSignals || domain.passRate >= passRateThreshold) {
      continue;
    }
    proposals.push({
      domain: domain.domain,
      title: `Strengthen the ${domain.domain} builder instructions`,
      rationale: `${domain.failed}/${domain.total} ${domain.domain} tasks failed verification (${Math.round(domain.passRate * 100)}% pass).`,
      suggestedRules: [
        "Before finishing, run the configured verification commands and fix failures.",
        "Keep the diff minimal; do not touch unrelated files.",
        "If a check cannot run, report it explicitly instead of claiming success.",
        "Prefer one concrete, verifiable change over a broad refactor.",
      ],
    });
  }

  return proposals;
}
