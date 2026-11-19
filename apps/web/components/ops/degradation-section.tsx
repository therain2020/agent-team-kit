"use client";

import {
  DegradationControls,
  type DegradationModeView,
  type DependencyView,
} from "@/components/degradation/degradation-controls";
import { LkgCard } from "@/components/ops/lkg-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LkgView } from "@/lib/lkg";
import type { DegradedMode } from "@kit/core";
import type { DegradationAuditRecord } from "@kit/store";
import { ListChecks, ScrollText, ShieldAlert, Workflow } from "lucide-react";
import { useTranslations } from "next-intl";

export function DegradationSection({
  modes,
  audit,
  dependencies,
  lkg,
}: {
  modes: DegradedMode[];
  audit: DegradationAuditRecord[];
  dependencies: DependencyView[];
  lkg: LkgView[];
}) {
  const t = useTranslations("degradation");

  const modeViews: DegradationModeView[] = modes.map((mode) => ({
    modeId: mode.modeId,
    scope: mode.scope,
    workspaceId: mode.workspaceId,
    kind: mode.kind,
    behavior: mode.behavior,
    enteredAt: mode.enteredAt,
    enteredBy: mode.enteredBy,
  }));

  return (
    <div className="space-y-3">
      <DegradationControls modes={modeViews} dependencies={dependencies} />

      <div className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-red-400" />
              {t("activeTitle")}
            </CardTitle>
            <Badge variant="outline">{modes.length}</Badge>
          </CardHeader>
          <CardContent>
            {modes.length === 0 ? (
              <p className="text-[11px] text-zinc-500">{t("empty")}</p>
            ) : (
              <ul className="space-y-2">
                {modes.map((mode) => (
                  <li
                    key={mode.modeId}
                    className="rounded-lg border border-border px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          mode.kind === "read_only" ? "danger" : "warning"
                        }
                      >
                        {mode.kind === "read_only"
                          ? t("kindReadOnly")
                          : t("kindDegraded")}
                      </Badge>
                      <span className="font-mono text-[11px] text-zinc-200">
                        {mode.modeId}
                      </span>
                      <span className="text-[11px] text-zinc-500">
                        {mode.scope === "global"
                          ? t("globalLabel")
                          : `${t("workspaceLabel")} ${mode.workspaceId}`}
                      </span>
                      <span className="ml-auto font-mono text-[10px] text-zinc-600">
                        {mode.enteredAt} · {mode.enteredBy}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-400">
                      {mode.behavior}
                    </p>
                    <p className="mt-1 text-[10px] text-zinc-500">
                      {t("triggers")}:{" "}
                      {mode.triggers
                        .map(
                          (trigger) =>
                            `${trigger.dependencyId} — ${trigger.reason}`,
                        )
                        .join(" · ")}
                    </p>
                    <p className="text-[10px] text-zinc-500">
                      {t("floorLine", {
                        chars: mode.qualityFloor.minChars,
                        minutes: mode.exitCriteria.minStableMinutes,
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="size-4 text-zinc-400" />
              {t("auditTitle")}
            </CardTitle>
            <Badge variant="outline">{audit.length}</Badge>
          </CardHeader>
          <CardContent>
            {audit.length === 0 ? (
              <p className="text-[11px] text-zinc-500">{t("noAudit")}</p>
            ) : (
              <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {audit.map((entry) => (
                  <li
                    key={entry.auditId}
                    className="rounded border border-border px-3 py-1.5 text-[11px]"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          entry.action === "enter"
                            ? "warning"
                            : entry.action === "exit"
                              ? "success"
                              : "danger"
                        }
                      >
                        {entry.action === "enter"
                          ? t("auditEnter")
                          : entry.action === "exit"
                            ? t("auditExit")
                            : t("auditBlocked")}
                      </Badge>
                      <span className="font-mono text-zinc-300">
                        {entry.modeId}
                      </span>
                      <span className="text-zinc-500">
                        {entry.scope === "global"
                          ? t("globalLabel")
                          : `${t("workspaceLabel")} ${entry.workspaceId}`}
                      </span>
                      <span className="text-zinc-500">{entry.actor}</span>
                      <span className="ml-auto font-mono text-[10px] text-zinc-600">
                        {entry.occurredAt}
                      </span>
                    </div>
                    {Object.keys(entry.detail).length > 0 ? (
                      <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">
                        {JSON.stringify(entry.detail)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="size-4 text-sky-400" />
            {t("dependencyList")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-1.5 md:grid-cols-2">
            {dependencies.map((dependency) => (
              <li
                key={dependency.id}
                className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-border px-3 py-1.5 text-[11px]"
              >
                <span className="font-mono text-zinc-200">{dependency.id}</span>
                <Badge
                  variant={
                    dependency.failureMode === "fail_closed" ? "danger" : "info"
                  }
                >
                  {dependency.failureMode === "fail_closed"
                    ? t("failClosed")
                    : t("failOpen")}
                </Badge>
                <span className="text-zinc-500">{dependency.criticality}</span>
                <span className="min-w-0 truncate text-zinc-500">
                  {dependency.description}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <LkgCard entries={lkg} />

      <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3 text-[11px] text-zinc-500">
        <ListChecks className="mt-0.5 size-3.5 shrink-0" />
        <p>{t("note")}</p>
      </div>
    </div>
  );
}
