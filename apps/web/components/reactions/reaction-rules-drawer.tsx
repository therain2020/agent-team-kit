import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DrawerShell } from "@/components/world/drawer-shell";
import { loadReactionsView } from "@/lib/reactions";
import { timeAgo } from "@/lib/utils";
import { Activity, Radio, ShieldCheck, X, Zap } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { ReactionRuleEditor } from "./reaction-rule-editor";
import { ReactionRuleToggle } from "./reaction-rule-toggle";

/**
 * ReactionRule console surface (98 §3.3/§3.5, 96 §5.6, issue #129).
 *
 * Observability: current rules with per-rule UTC-day usage, the version audit
 * trail, and recent event → rule → job firings. Control: observer edits via the
 * D-64 editor and rationale-backed enable/disable. Information events never
 * expose a "start job" button; dispatch is the trigger plane's job.
 */
export async function ReactionRulesDrawer({
  closeHref,
}: {
  closeHref: string;
}) {
  const [t, common, locale, view] = await Promise.all([
    getTranslations("reactions"),
    getTranslations("common"),
    getLocale(),
    loadReactionsView(),
  ]);

  return (
    <DrawerShell
      closeHref={closeHref}
      label={t("drawerTitle")}
      closeLabel={common("close")}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("eyebrow")}
          </p>
          <h2 className="text-sm font-semibold text-zinc-100">
            {t("drawerTitle")}
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">{t("drawerHint")}</p>
        </div>
        <Link
          href={closeHref}
          aria-label={common("close")}
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-accent hover:text-zinc-200"
        >
          <X className="size-4" />
        </Link>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Zap className="size-3.5 text-violet-400" />
              {t("rulesTitle")}
            </CardTitle>
            <Badge variant="outline">
              {t("ruleCount", { count: view.rules.length })}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {view.rules.length === 0 ? (
              <p className="text-[11px] text-zinc-500">{t("noRules")}</p>
            ) : (
              view.rules.map((rule) => {
                const usage = view.usage[rule.ruleId] ?? {
                  runs: 0,
                  costCny: 0,
                };
                return (
                  <div
                    key={rule.ruleId}
                    className="rounded-lg border border-border px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[11px] text-zinc-200">
                        {rule.name}
                      </span>
                      <Badge variant={rule.enabled ? "success" : "outline"}>
                        {rule.enabled ? t("enabled") : t("disabled")}
                      </Badge>
                      <Badge variant="outline">
                        {t("versionBadge", { version: rule.version })}
                      </Badge>
                      <Badge variant="outline">
                        {t("priorityBadge", { priority: rule.priority })}
                      </Badge>
                      <span className="ml-auto font-mono text-[9px] text-zinc-600">
                        {timeAgo(rule.updatedAt ?? "", locale)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-zinc-400">
                      {t("matchLine", {
                        eventType: rule.match.eventType,
                        topics: rule.match.topics.join(", ") || "—",
                        entities: rule.match.entities.join(", ") || "—",
                      })}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-400">
                      {t("targetLine", {
                        pack: rule.target.packDir,
                        workflow:
                          rule.target.workflow ?? rule.target.goal ?? "—",
                        mode: rule.runMode,
                      })}
                    </p>
                    <p className="font-mono text-[10px] text-zinc-500">
                      {t("usageLine", {
                        runs: usage.runs,
                        dailyRuns: rule.budget?.dailyRuns ?? "∞",
                        cost: usage.costCny,
                        dailyCost: rule.budget?.dailyCostCny ?? "∞",
                      })}
                    </p>
                    <p className="mt-0.5 text-[10px] text-zinc-500">
                      {rule.rationale}
                    </p>
                    <ReactionRuleToggle
                      ruleId={rule.ruleId}
                      enabled={rule.enabled}
                      version={rule.version}
                    />
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <ReactionRuleEditor rules={view.rules} />

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-xs">
              <Activity className="size-3.5 text-emerald-400" />
              {t("reactionsTitle")}
            </CardTitle>
            <Badge variant="outline">
              {t("reactionCount", { count: view.reactions.length })}
            </Badge>
          </CardHeader>
          <CardContent>
            {view.reactions.length === 0 ? (
              <p className="text-[11px] text-zinc-500">{t("noReactions")}</p>
            ) : (
              <ul className="space-y-1.5">
                {view.reactions.slice(0, 20).map((row) => (
                  <li
                    key={row.triggerRunId}
                    className="flex flex-wrap items-center gap-1.5 rounded border border-border px-2 py-1.5"
                  >
                    <Badge variant="violet">{row.reactionRuleId ?? "—"}</Badge>
                    <span className="font-mono text-[10px] text-zinc-400">
                      {row.status}
                    </span>
                    <span className="truncate font-mono text-[9px] text-zinc-500">
                      {row.jobId ?? "—"}
                    </span>
                    <span className="truncate font-mono text-[9px] text-zinc-600">
                      {row.payloadRef ?? row.dedupeKey}
                    </span>
                    <span className="ml-auto font-mono text-[9px] text-zinc-600">
                      {timeAgo(row.launchedAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xs">
              <ShieldCheck className="size-3.5 text-amber-400" />
              {t("auditTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-[10px] text-zinc-500">
            {view.audit.length === 0 ? (
              <p>{t("noHistory")}</p>
            ) : (
              view.audit.map((entry) => (
                <p key={entry.auditId}>
                  <span className="font-mono text-zinc-400">
                    {entry.ruleId} v{entry.version} {entry.action}
                  </span>{" "}
                  · {entry.actor} · {timeAgo(entry.occurredAt, locale)}
                  <span className="block text-zinc-500">{entry.rationale}</span>
                </p>
              ))
            )}
          </CardContent>
        </Card>

        <p className="flex items-center gap-1.5 px-1 text-[10px] text-zinc-600">
          <Radio className="size-3" />
          {t("dispatchHint")}
        </p>
      </div>
    </DrawerShell>
  );
}
