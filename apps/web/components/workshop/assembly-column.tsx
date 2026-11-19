"use client";

import { RunPackDialog } from "@/components/packs/run-pack-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCny } from "@/lib/utils";
import type { WorkshopPackView } from "@/lib/workshop-link";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  GitBranch,
  PackageSearch,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

export function AssemblyColumn({ pack }: { pack: WorkshopPackView | null }) {
  const t = useTranslations("workshopSurface");

  if (!pack) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <PackageSearch className="size-6 text-zinc-600" />
        <p className="text-sm font-medium text-zinc-300">
          {t("noSelectionTitle")}
        </p>
        <p className="max-w-xs text-[11px] text-muted-foreground">
          {t("noSelectionDesc")}
        </p>
      </div>
    );
  }

  const encoded = encodeURIComponent(pack.dirName);
  const totalCost = pack.workflows.reduce(
    (sum, workflow) => sum + workflow.costCny,
    0,
  );

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {pack.valid ? (
              <CheckCircle2 className="size-4 text-emerald-400" />
            ) : (
              <AlertTriangle className="size-4 text-red-400" />
            )}
            <h2 className="truncate text-sm font-semibold text-zinc-50">
              {pack.name}
            </h2>
            <Badge variant="outline">v{pack.version}</Badge>
            <Badge variant={pack.valid ? "success" : "danger"}>
              {pack.valid ? t("valid") : t("invalid")}
            </Badge>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
            packs/{pack.dirName}
          </p>
          {pack.description ? (
            <p className="mt-1 text-[11px] text-zinc-400">{pack.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {pack.valid ? (
            <RunPackDialog
              packDir={pack.dirName}
              workflows={pack.workflows.map((workflow) => ({
                id: workflow.id,
                stages: workflow.stages,
                estimatedCostCny: workflow.costCny,
              }))}
            />
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/packs/${encoded}/studio`}>
              <Wrench className="size-3.5" />
              {t("openStudio")}
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/packs/${encoded}`}>
              {t("openDetail")}
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </div>

      {pack.errors.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-red-500/25 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
          {pack.errors.slice(0, 6).map((error) => (
            <li key={error}>• {error}</li>
          ))}
        </ul>
      ) : null}
      {pack.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/90">
          {pack.warnings.slice(0, 4).map((warning) => (
            <li key={warning}>• {warning}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-4 gap-1.5">
        <Metric label={t("agents")} value={pack.agentCount} />
        <Metric label={t("skills")} value={pack.skillCount} />
        <Metric label={t("workflows")} value={pack.workflowCount} />
        <Metric label={t("policies")} value={pack.policyCount} />
      </div>
      <p className="text-[10px] text-zinc-500">
        {t("simulateCost", { cost: formatCny(totalCost) })}
      </p>

      <section>
        <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          <GitBranch className="size-3 text-emerald-400" />
          {t("workflowsTitle")}
        </h3>
        {pack.workflows.length === 0 ? (
          <p className="rounded border border-dashed border-border px-3 py-3 text-center text-[11px] text-zinc-500">
            {t("noWorkflows")}
          </p>
        ) : (
          <div className="space-y-2">
            {pack.workflows.map((workflow) => (
              <div
                key={workflow.id}
                className="rounded-lg border border-border bg-zinc-950/30 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px] text-zinc-200">
                    {workflow.id}
                  </span>
                  <span className="shrink-0 text-[10px] text-zinc-500">
                    {t("stageCount", { count: workflow.stages })} ·{" "}
                    {formatCny(workflow.costCny)}
                  </span>
                </div>
                <ul className="mt-1.5 space-y-1">
                  {workflow.stageViews.map((stage, index) => (
                    <li
                      key={stage.id}
                      className="flex items-center gap-1.5 rounded border border-border/70 px-1.5 py-1 text-[10px]"
                    >
                      <span className="w-3 shrink-0 text-right font-mono text-zinc-600">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">
                        {stage.id}
                      </span>
                      <Badge
                        variant={stage.type === "agent" ? "info" : "outline"}
                        className="px-1 py-0 text-[9px]"
                      >
                        {stage.type}
                      </Badge>
                      {stage.agent ? (
                        <span className="shrink-0 text-zinc-500">
                          {t("stageAgent", { agent: stage.agent })}
                        </span>
                      ) : null}
                      {stage.gate ? (
                        <span className="shrink-0 text-amber-300/80">
                          {t("stageGate", { gate: stage.gate })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          <Bot className="size-3 text-sky-400" />
          {t("rolesTitle")}
        </h3>
        {pack.roles.length === 0 ? (
          <p className="rounded border border-dashed border-border px-3 py-3 text-center text-[11px] text-zinc-500">
            {t("noRoles")}
          </p>
        ) : (
          <ul className="space-y-1">
            {pack.roles.map((role) => (
              <li
                key={role.id}
                className="rounded border border-border px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-zinc-200">
                    {role.id}
                  </span>
                  {role.isManager ? (
                    <Badge variant="violet" className="px-1.5 py-0 text-[9px]">
                      manager
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="px-1.5 py-0 text-[9px]">
                      {role.role}
                    </Badge>
                  )}
                  <span className="font-mono text-[9px] text-zinc-600">
                    {role.model}
                  </span>
                  {role.skills.length > 0 ? (
                    <span className="ml-auto truncate text-[9px] text-zinc-600">
                      {role.skills.join(", ")}
                    </span>
                  ) : null}
                </div>
                {role.description ? (
                  <p className="mt-0.5 line-clamp-2 text-[10px] text-zinc-500">
                    {role.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pack.skills.length > 0 ? (
        <section>
          <h3 className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            {t("skillsTitle")}
          </h3>
          <div className="flex flex-wrap gap-1">
            {pack.skills.map((skill) => (
              <Badge key={skill} variant="outline" className="font-mono">
                {skill}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border px-1.5 py-1 text-center">
      <p className="font-mono text-xs text-zinc-200">{value}</p>
      <p className="truncate text-[8px] uppercase tracking-wider text-zinc-600">
        {label}
      </p>
    </div>
  );
}
