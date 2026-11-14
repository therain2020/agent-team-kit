import { FactoryFloor } from "@/components/factory/factory-floor";
import { loadInboxData } from "@/lib/approvals";
import type { FactoryItem } from "@/lib/factory";

export const dynamic = "force-dynamic";

export default async function FactoryPage() {
  const data = await loadInboxData();
  const items: FactoryItem[] = [
    ...data.paused
      .filter((item) => item.approval)
      .map((item) => ({
        kind: "approval" as const,
        requestId: item.approval?.requestId,
        runId: item.run.runId,
        workflowId: item.run.workflowId,
        stageName: item.approval?.stageName,
        riskClass: item.approval?.riskClass ?? "medium",
        summary: item.approval?.summary ?? "",
        costCny: item.costCny,
        updatedAt: item.run.updatedAt,
        expiresAt: item.approval?.expiresAt,
      })),
    ...data.failed.map((item) => ({
      kind: "failed" as const,
      runId: item.run.runId,
      workflowId: item.run.workflowId,
      riskClass: "high" as const,
      summary: item.reason,
      costCny: item.costCny,
      updatedAt: item.run.updatedAt,
      artifactCount: item.artifactCount,
    })),
  ];

  return <FactoryFloor initialItems={items} />;
}
