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
