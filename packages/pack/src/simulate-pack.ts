import type { LoadedPack } from "./load-pack";

const PRICES: Record<
  string,
  { inputCnyPer1k: number; outputCnyPer1k: number }
> = {
  "deepseek-flash": { inputCnyPer1k: 0.001, outputCnyPer1k: 0.002 },
  "deepseek-pro": { inputCnyPer1k: 0.002, outputCnyPer1k: 0.008 },
};

const INPUT_TOKENS_PER_AGENT_STAGE = 1500;
const OUTPUT_TOKENS_PER_AGENT_STAGE = 600;
const RUN_BUDGET_CNY = 5;

export interface SimulationStage {
  id: string;
  type: "workflow" | "agent" | "coder";
  agent?: string;
  coder?: string;
  model?: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostCny: number;
  gate?: string;
}

export interface SimulationWorkflow {
  id: string;
  stages: SimulationStage[];
  totalCostCny: number;
  budgetWarning?: string;
}

export interface SimulationReport {
  pack: { name: string; version: string };
  workflows: SimulationWorkflow[];
  warnings: string[];
  note: string;
}

export function simulatePack(loaded: LoadedPack): SimulationReport {
  const warnings = [...loaded.warnings];

  const workflows = loaded.workflows.map((workflow) => {
    const stages = workflow.stages.map((stage): SimulationStage => {
      if (stage.type === "workflow" || stage.type === "coder") {
        return {
          id: stage.id,
          type: stage.type,
          ...(stage.type === "coder" && stage.coder
            ? { coder: stage.coder }
            : {}),
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          estimatedCostCny: 0,
          ...(stage.gate ? { gate: stage.gate } : {}),
        };
      }

      const agentId = stage.agent ?? "";
      const agent = loaded.agents.get(agentId);
      const model = agent?.frontmatter.model ?? "unknown";
      const price = PRICES[model];

      if (!price) {
        warnings.push(
          `no price entry for model "${model}" (agent ${agentId}); cost treated as 0`,
        );
      }

      const inputPrice = price?.inputCnyPer1k ?? 0;
      const outputPrice = price?.outputCnyPer1k ?? 0;
      const cost =
        (INPUT_TOKENS_PER_AGENT_STAGE / 1000) * inputPrice +
        (OUTPUT_TOKENS_PER_AGENT_STAGE / 1000) * outputPrice;

      return {
        id: stage.id,
        type: stage.type,
        agent: agentId,
        model,
        estimatedInputTokens: INPUT_TOKENS_PER_AGENT_STAGE,
        estimatedOutputTokens: OUTPUT_TOKENS_PER_AGENT_STAGE,
        estimatedCostCny: round(cost),
        ...(stage.gate ? { gate: stage.gate } : {}),
      };
    });

    const totalCostCny = round(
      stages.reduce((sum, stage) => sum + stage.estimatedCostCny, 0),
    );

    return {
      id: workflow.id,
      stages,
      totalCostCny,
      ...(totalCostCny > RUN_BUDGET_CNY
        ? {
            budgetWarning: `estimated ${totalCostCny} CNY exceeds run budget ${RUN_BUDGET_CNY} CNY`,
          }
        : {}),
    };
  });

  return {
    pack: {
      name: loaded.pack.metadata.name,
      version: loaded.pack.metadata.version,
    },
    workflows,
    warnings,
    note: "Illustrative estimate; token counts are fixed per stage and prices are placeholders.",
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
