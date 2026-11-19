import { InboxTower } from "@/components/inbox/inbox-tower";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { loadApprovalTower } from "@/lib/inbox";
import { loadRecentFailures } from "@/lib/inbox-failures";
import { currentOperatorId } from "@/lib/operator";
import { formatCny, timeAgo } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const t = await getTranslations("inbox");
  const locale = await getLocale();
  const operator = currentOperatorId();
  const [snapshot, failures] = await Promise.all([
    loadApprovalTower(),
    loadRecentFailures().catch(() => []),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <InboxTower initial={snapshot} operator={operator} />

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-red-400" />
          <h2 className="text-sm font-semibold text-zinc-200">
            {t("failedRuns")}
          </h2>
          <Badge variant={failures.length > 0 ? "danger" : "outline"}>
            {failures.length}
          </Badge>
        </div>

        {failures.length === 0 ? (
          <Card>
            <CardContent className="py-4 text-center text-xs text-muted-foreground">
              {t("noFailed")}
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {failures.map((failure) => (
              <Link
                key={failure.runId}
                href={`/runs/${encodeURIComponent(failure.runId)}`}
                className="min-w-0 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:bg-accent/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-xs text-zinc-200">
                    {failure.runId}
                  </span>
                  <Badge variant="danger" className="text-[10px]">
                    {t("failed")}
                  </Badge>
                  <span className="ml-auto text-[10px] text-zinc-500">
                    {t("artifactsCost", {
                      count: failure.artifactCount,
                      cost: formatCny(failure.costCny),
                    })}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">
                  {failure.reason}
                </p>
                <p className="mt-0.5 text-[10px] text-zinc-600">
                  {timeAgo(failure.updatedAt, locale)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
