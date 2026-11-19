import { PageHeader } from "@/components/kit/page-header";
import { OpsSurface } from "@/components/ops/ops-surface";
import { loadAutopilotOverview } from "@/lib/autopilot";
import { loadBudgetOverview } from "@/lib/budgets";
import { loadCapacityOverview } from "@/lib/capacity";
import { loadActiveModes, loadDegradationAudit } from "@/lib/degradation";
import { loadKillSwitchState } from "@/lib/kill-switch";
import { loadLkgOverview } from "@/lib/lkg";
import { currentOperatorId } from "@/lib/operator";
import { loadOpsConsole } from "@/lib/ops";
import { resolveOpsSection } from "@/lib/ops-sections";
import { DEFAULT_DEPENDENCIES } from "@kit/core";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  const [
    { section },
    t,
    ops,
    modes,
    audit,
    budgets,
    killSwitch,
    autopilot,
    lkg,
    capacity,
  ] = await Promise.all([
    searchParams,
    getTranslations("opsSurface"),
    loadOpsConsole(),
    loadActiveModes(),
    loadDegradationAudit(20),
    loadBudgetOverview(),
    loadKillSwitchState(),
    loadAutopilotOverview(),
    loadLkgOverview(),
    loadCapacityOverview(),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <OpsSurface
        initial={{
          ops,
          modes,
          audit,
          dependencies: DEFAULT_DEPENDENCIES.map((dependency) => ({
            id: dependency.id,
            kind: dependency.kind,
            criticality: dependency.criticality,
            failureMode: dependency.failureMode,
            description: dependency.description,
          })),
          budgets,
          killSwitch,
          autopilot,
          lkg,
          capacity,
        }}
        operator={currentOperatorId()}
        initialSection={resolveOpsSection(section)}
        initialNow={Date.now()}
      />
    </div>
  );
}
