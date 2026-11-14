export type FactoryRisk = "low" | "medium" | "high";

export interface FactoryItem {
  kind: "approval" | "failed";
  requestId?: string;
  runId: string;
  workflowId?: string;
  stageName?: string;
  riskClass: FactoryRisk;
  summary: string;
  costCny: number;
  updatedAt: string;
  expiresAt?: string;
  artifactCount?: number;
}

const RISK_ORDER: Record<FactoryRisk, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function orderGateItems(items: FactoryItem[]): FactoryItem[] {
  return items
    .filter((item) => item.kind === "approval")
    .sort(
      (left, right) =>
        RISK_ORDER[left.riskClass] - RISK_ORDER[right.riskClass] ||
        left.updatedAt.localeCompare(right.updatedAt),
    );
}

export function lowRiskItems(items: FactoryItem[]): FactoryItem[] {
  return orderGateItems(items).filter((item) => item.riskClass === "low");
}

export function needsConfirmation(item: FactoryItem): boolean {
  return item.riskClass !== "low";
}
