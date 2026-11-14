import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { RunPackDialog } from "@/components/packs/run-pack-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadPackDetail } from "@/lib/packs";
import { formatCny } from "@/lib/utils";
import {
  ArrowLeft,
  Bot,
  GitBranch,
  PackageSearch,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ dirName: string }>;
}) {
  const t = await getTranslations("packDetail");
  const { dirName: raw } = await params;
  const dirName = decodeURIComponent(raw);
  const detail = await loadPackDetail(dirName);

  if (!detail) {
    return (
      <div className="space-y-5">
        <PageHeader title={t("invalidTitle")} description={dirName} />
        <EmptyState
          icon={PackageSearch}
          title={t("invalidTitle")}
          description={t("invalidDesc")}
          action={
            <Button asChild size="sm" variant="outline">
              <Link href="/packs">{t("backToPacks")}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const { loaded, simulation } = detail;
  const simulationByWorkflow = new Map(
    simulation.workflows.map((workflow) => [workflow.id, workflow]),
  );

  return (
    <div className="space-y-5">
      <Link
        href="/packs"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-zinc-200"
      >
        <ArrowLeft className="size-3.5" />
        {t("back")}
      </Link>

      <PageHeader
        title={loaded.pack.metadata.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">v{loaded.pack.metadata.version}</Badge>
            <span className="font-mono text-xs">packs/{dirName}</span>
            <span className="text-zinc-600">·</span>
            <span className="text-xs">{loaded.pack.apiVersion}</span>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={`/packs/${encodeURIComponent(dirName)}/studio`}>
                <Wrench className="size-3.5" />
                Studio
              </Link>
            </Button>
            <RunPackDialog
              packDir={dirName}
              workflows={loaded.workflows.map((workflow) => ({
                id: workflow.id,
                stages: workflow.stages.length,
                estimatedCostCny:
                  simulationByWorkflow.get(workflow.id)?.totalCostCny ?? 0,
              }))}
            />
          </div>
        }
      />

      {loaded.warnings.length > 0 ? (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
          {loaded.warnings.map((warning) => (
            <p key={warning}>• {warning}</p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {loaded.workflows.map((workflow) => {
          const sim = simulationByWorkflow.get(workflow.id);
          return (
            <Card key={workflow.id}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <GitBranch className="size-4 text-emerald-400" />
                  {workflow.id}
                </CardTitle>
                <span className="text-[11px] text-zinc-500">
                  {t("workflowMeta", {
                    stages: workflow.stages.length,
                    cost: formatCny(sim?.totalCostCny ?? 0),
                  })}
                </span>
              </CardHeader>
              <CardContent className="space-y-1.5">
                <p className="mb-2 text-[11px] text-zinc-500">
                  {t("trigger", { event: workflow.trigger.event })}
                </p>
                {workflow.stages.map((stage, index) => (
                  <div
                    key={stage.id}
                    className="flex items-start gap-2 rounded border border-border px-2 py-1.5 text-[11px]"
                  >
                    <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-zinc-600">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-zinc-300">
                          {stage.id}
                        </span>
                        <Badge
                          variant={stage.type === "agent" ? "info" : "default"}
                        >
                          {stage.type}
                        </Badge>
                        {stage.agent ? (
                          <span className="text-zinc-500">
                            {t("agent", { agent: stage.agent })}
                          </span>
                        ) : null}
                        {stage.gate ? (
                          <Badge variant="warning">
                            {t("gate", { gate: stage.gate })}
                          </Badge>
                        ) : null}
                      </div>
                      {stage.inputFrom ? (
                        <p className="mt-0.5 text-[10px] text-zinc-600">
                          {t("inputFrom", { stage: stage.inputFrom })}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4 text-sky-400" />
              {t("agentsTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {loaded.pack.agents.map((agent) => {
              const frontmatter = loaded.agents.get(agent.id)?.frontmatter;
              return (
                <div
                  key={agent.id}
                  className="rounded border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-zinc-200">
                      {agent.id}
                    </span>
                    <Badge variant="outline">{agent.model}</Badge>
                    <span className="ml-auto font-mono text-[10px] text-zinc-600">
                      {agent.file}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    {t("skillsLine", {
                      skills: agent.skills.join(", ") || t("noSkills"),
                    })}
                    {frontmatter?.description
                      ? ` · ${frontmatter.description}`
                      : ""}
                  </p>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="size-4 text-zinc-400" />
              {t("skillsPoliciesTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("skillsCount", { count: loaded.skills.size })}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {[...loaded.skills.keys()].map((skill) => (
                  <Badge key={skill} variant="outline">
                    {skill}
                  </Badge>
                ))}
                {loaded.skills.size === 0 ? (
                  <span className="text-[11px] text-zinc-600">
                    {t("noSkills")}
                  </span>
                ) : null}
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("policiesCount", { count: loaded.policies.length })}
              </p>
              <div className="mt-1 space-y-1">
                {loaded.policies.map((policy) => (
                  <pre
                    key={JSON.stringify(policy)}
                    className="max-h-24 overflow-auto rounded border border-border bg-zinc-950 p-2 font-mono text-[10px] text-zinc-400"
                  >
                    {JSON.stringify(policy, null, 2)}
                  </pre>
                ))}
                {loaded.policies.length === 0 ? (
                  <span className="text-[11px] text-zinc-600">
                    {t("noPolicies")}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-zinc-500">
              <ShieldCheck className="size-3.5" />
              {t("compatibility", {
                range: loaded.pack.metadata.compatibility.kit,
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
