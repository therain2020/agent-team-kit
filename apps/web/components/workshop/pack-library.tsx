"use client";

import { Button } from "@/components/ui/button";
import { cn, formatCny } from "@/lib/utils";
import type { WorkshopPackView } from "@/lib/workshop-link";
import {
  AlertTriangle,
  CheckCircle2,
  Package,
  Plus,
  Wrench,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

export function PackLibrary({
  packs,
  selectedDir,
  onSelect,
}: {
  packs: WorkshopPackView[];
  selectedDir?: string;
  onSelect: (dirName: string) => void;
}) {
  const t = useTranslations("workshopSurface");

  if (packs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Package className="size-6 text-zinc-600" />
        <div>
          <p className="text-sm font-medium text-zinc-300">
            {t("noPacksTitle")}
          </p>
          <p className="mt-1 max-w-xs text-[11px] text-muted-foreground">
            {t("noPacksDesc")}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/packs/new">
            <Plus className="size-3.5" />
            {t("newPack")}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {packs.map((pack) => {
          const selected = pack.dirName === selectedDir;
          const totalCost = pack.workflows.reduce(
            (sum, workflow) => sum + workflow.costCny,
            0,
          );
          return (
            <li
              key={pack.dirName}
              className={cn(
                "rounded-lg border transition-colors",
                selected
                  ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                  : "border-border bg-zinc-950/30 hover:border-zinc-600",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(pack.dirName)}
                aria-pressed={selected}
                className="w-full rounded-t-lg px-2.5 py-2 text-left"
              >
                <div className="flex items-center gap-1.5">
                  {pack.valid ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-3.5 shrink-0 text-red-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">
                    {pack.name}
                  </span>
                  <span className="shrink-0 rounded border border-border px-1 py-0.5 font-mono text-[9px] text-zinc-500">
                    v{pack.version}
                  </span>
                </div>
                <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
                  packs/{pack.dirName}
                </p>
                {pack.valid ? (
                  <>
                    <div className="mt-1.5 grid grid-cols-4 gap-1 text-center">
                      <Metric label={t("agents")} value={pack.agentCount} />
                      <Metric label={t("skills")} value={pack.skillCount} />
                      <Metric
                        label={t("workflows")}
                        value={pack.workflowCount}
                      />
                      <Metric label={t("policies")} value={pack.policyCount} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                      <span className="truncate">
                        {t("simulateCost", { cost: formatCny(totalCost) })}
                      </span>
                      {pack.warnings.length > 0 ? (
                        <span className="shrink-0 text-amber-400/80">
                          {t("warningsCount", { count: pack.warnings.length })}
                        </span>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="mt-1.5 space-y-0.5">
                    <p className="text-[10px] text-red-300">
                      {t("errorsCount", { count: pack.errors.length })}
                    </p>
                    {pack.errors.slice(0, 2).map((error) => (
                      <p
                        key={error}
                        className="truncate text-[10px] text-red-300/70"
                      >
                        • {error}
                      </p>
                    ))}
                  </div>
                )}
              </button>
              <div className="flex items-center justify-between gap-2 border-t border-border/60 px-2.5 py-1">
                <Link
                  href={`/packs/${encodeURIComponent(pack.dirName)}`}
                  className="text-[10px] text-zinc-500 hover:text-zinc-200"
                >
                  {t("openDetail")}
                </Link>
                <Link
                  href={`/packs/${encodeURIComponent(pack.dirName)}/studio`}
                  className="inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-200"
                >
                  <Wrench className="size-3" />
                  {t("openStudio")}
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
      <footer className="border-t border-border p-2">
        <Button asChild size="sm" variant="ghost" className="w-full">
          <Link href="/packs/new">
            <Plus className="size-3.5" />
            {t("newPack")}
          </Link>
        </Button>
      </footer>
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border px-1 py-0.5">
      <p className="font-mono text-[11px] text-zinc-200">{value}</p>
      <p className="truncate text-[8px] uppercase tracking-wider text-zinc-600">
        {label}
      </p>
    </div>
  );
}
