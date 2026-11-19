import { ApprovalsSurface } from "@/components/approvals/approvals-surface";
import { PageHeader } from "@/components/kit/page-header";
import { parseApprovalsView } from "@/lib/approvals-view";
import { loadFactorySnapshot } from "@/lib/factory-server";
import { loadApprovalTower } from "@/lib/inbox";
import { currentOperatorId } from "@/lib/operator";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * One approvals surface, two views (82 §3). The SLA tower reads the approvals
 * entity (#141/#146); the line reads the paused-run projection and reconciles
 * against the world stream (#138/#148). Both ship in one server render so the
 * first switch costs no page load.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("approvals");
  const params = await searchParams;
  const [tower, factory] = await Promise.all([
    loadApprovalTower(),
    loadFactorySnapshot(),
  ]);

  const rawRequest = params.request;
  const requested =
    typeof rawRequest === "string"
      ? rawRequest
      : Array.isArray(rawRequest)
        ? (rawRequest[0] ?? null)
        : null;
  const rawRun = params.run;
  const runValue =
    typeof rawRun === "string"
      ? rawRun
      : Array.isArray(rawRun)
        ? (rawRun[0] ?? null)
        : null;
  const runId = runValue?.trim() || null;

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />
      <ApprovalsSurface
        initialTower={tower}
        initialItems={factory.items}
        operator={currentOperatorId()}
        // `?run=` comes from an office station (97 §3.3): land on the line
        // and preselect that run's first workpiece instead of the top card.
        initialView={runId ? "factory" : parseApprovalsView(params.view)}
        initialRequestId={requested}
        initialRunId={runId}
      />
    </div>
  );
}
