import {
  type PriceTable,
  computeCostMicro,
  loadPriceTable,
  resolveModelPrice,
} from "@kit/model";
import type { LoadedPack } from "./load-pack";

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

export interface SimulationOptions {
  /**
   * Versioned price table shared with actual cost attribution (60 §3.3). The
   * defaults read `KIT_PRICE_TABLE_JSON`, so a repriced deployment estimates
   * with exactly the version that would charge the run.
   */
  priceTable?: PriceTable;
  at?: Date;
}

export function simulatePack(
  loaded: LoadedPack,
  options: SimulationOptions = {},
): SimulationReport {
  const warnings = [...loaded.warnings];
  const priceTable = options.priceTable ?? loadPriceTable();
  const at = options.at ?? new Date();

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
      const price = resolveModelPrice(priceTable, model, at);

      if (!price.tracked) {
        warnings.push(
          `no price entry for model "${model}" (agent ${agentId}) in price table ${price.priceVersion}; cost treated as 0`,
        );
      }

      const costMicro = computeCostMicro(
        price,
        INPUT_TOKENS_PER_AGENT_STAGE,
        OUTPUT_TOKENS_PER_AGENT_STAGE,
      );

      return {
        id: stage.id,
        type: stage.type,
        agent: agentId,
        model,
        estimatedInputTokens: INPUT_TOKENS_PER_AGENT_STAGE,
        estimatedOutputTokens: OUTPUT_TOKENS_PER_AGENT_STAGE,
        estimatedCostCny: round(costMicro / 1_000_000),
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
