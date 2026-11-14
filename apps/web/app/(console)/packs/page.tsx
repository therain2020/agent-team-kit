import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { RunPackDialog } from "@/components/packs/run-pack-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listPacks } from "@/lib/packs";
import { formatCny } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Package,
  Plus,
  Wrench,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function PacksPage() {
  const t = await getTranslations("packs");
  const packs = await listPacks();

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild size="sm">
            <Link href="/packs/new">
              <Plus className="size-3.5" />
              {t("newPack")}
            </Link>
          </Button>
        }
      />

      {packs.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t("noPacksTitle")}
          description={t("noPacksDesc")}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {packs.map((pack) => {
            const invalid = Boolean(pack.errors?.length);
            return (
              <Card key={pack.dirName} className="flex flex-col">
                <CardHeader className="flex-row items-start justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {invalid ? (
                        <AlertTriangle className="size-4 text-red-400" />
                      ) : (
                        <CheckCircle2 className="size-4 text-emerald-400" />
                      )}
                      {pack.name}
                      <Badge variant="outline">v{pack.version}</Badge>
                    </CardTitle>
                    <p className="mt-1 font-mono text-[10px] text-zinc-500">
                      packs/{pack.dirName} · {pack.apiVersion}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/packs/${encodeURIComponent(pack.dirName)}/studio`}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-zinc-200"
                    >
                      <Wrench className="size-3" />
                      Studio
                    </Link>
                    <Link
                      href={`/packs/${encodeURIComponent(pack.dirName)}`}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-zinc-200"
                    >
                      {t("inspect")}
                      <ArrowRight className="size-3" />
                    </Link>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col gap-3">
                  {invalid ? (
                    <ul className="space-y-1 text-[11px] text-red-300">
                      {pack.errors?.slice(0, 4).map((error) => (
                        <li key={error}>• {error}</li>
                      ))}
                    </ul>
                  ) : (
                    <>
                      <div className="grid grid-cols-4 gap-2 text-center">
                        <Metric label={t("agents")} value={pack.agentCount} />
                        <Metric label={t("skills")} value={pack.skillCount} />
                        <Metric
                          label={t("workflows")}
                          value={pack.workflowCount}
                        />
                        <Metric
                          label={t("policies")}
                          value={pack.policyCount}
                        />
                      </div>
                      <div className="space-y-1">
                        {pack.workflows.map((workflow) => (
                          <div
                            key={workflow.id}
                            className="flex items-center justify-between rounded border border-border px-2 py-1.5 text-[11px]"
                          >
                            <span className="font-mono text-zinc-300">
                              {workflow.id}
                            </span>
                            <span className="text-zinc-500">
                              {t("workflowMeta", {
                                stages: workflow.stages,
                                cost: formatCny(workflow.estimatedCostCny),
                              })}
                            </span>
                          </div>
                        ))}
                      </div>
                      {pack.warnings.length > 0 ? (
                        <p className="text-[10px] text-amber-400/80">
                          {t("warnings", {
                            count: pack.warnings.length,
                            first: pack.warnings[0] ?? "",
                          })}
                        </p>
                      ) : null}
                    </>
                  )}
                  <div className="mt-auto flex items-center justify-end">
                    {invalid ? (
                      <Badge variant="danger">{t("invalidFix")}</Badge>
                    ) : (
                      <RunPackDialog
                        packDir={pack.dirName}
                        workflows={pack.workflows}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border px-2 py-1.5">
      <p className="font-mono text-sm text-zinc-200">{value}</p>
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
    </div>
  );
}
