import { EvolutionCycleDialog } from "@/components/evolution/cycle-dialog";
import { EvolutionActions } from "@/components/evolution/evolution-actions";
import { EmptyState } from "@/components/kit/empty-state";
import { PageHeader } from "@/components/kit/page-header";
import { StatCard } from "@/components/kit/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadEvolutionData } from "@/lib/evolution";
import { listPacks } from "@/lib/packs";
import { formatCny, timeAgo } from "@/lib/utils";
import { DEFAULT_CANARY_THRESHOLDS } from "@kit/evolution";
import {
  Activity,
  ClipboardCheck,
  FlaskConical,
  Gauge,
  GitCompare,
  GitPullRequestArrow,
  History,
  Microscope,
  Scale,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Trophy,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function EvolutionPage() {
  const t = await getTranslations("evolution");
  const common = await getTranslations("common");
  const locale = await getLocale();
  const [
    {
      state,
      freeze,
      variants,
      cycles,
      decisions,
      outcomes,
      outcomeSummary,
      agreement,
      divergence,
      drift,
      governanceEvents,
      attributions,
    },
    packs,
  ] = await Promise.all([loadEvolutionData(), listPacks()]);
  const outcomeByCycle = new Map<string, (typeof outcomes)[number]>();
  for (const outcome of outcomes) {
    if (outcome.cycleId) {
      outcomeByCycle.set(outcome.cycleId, outcome);
    }
  }

  const canary = state?.canary;
  const canaryActive =
    canary?.status === "shadow" || canary?.status === "canary";
  const canaryStatusLabel = canary
    ? canary.status === "shadow"
      ? t("statusShadow")
      : canary.status === "canary"
        ? t("statusCanary")
        : canary.status === "promoted"
          ? t("statusPromoted")
          : canary.status === "rolled_back"
            ? t("statusRolledBack")
            : canary.status
    : "";
  const champion = variants.find((variant) => variant.isChampion);
  const championScore = champion?.averageScore ?? 0;
  const canaryDirName = canary?.path.split(/[\\/]/).pop();
  const canaryVariant = canaryDirName
    ? variants.find((variant) => variant.dirName === canaryDirName)
    : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <EvolutionCycleDialog
              packs={packs.map((pack) => ({
                dirName: pack.dirName,
                name: pack.name,
              }))}
            />
            {variants.length > 0 ? (
              <EvolutionActions
                variants={variants.map((variant) => ({
                  dirName: variant.dirName,
                  name: variant.meta.name,
                  isChampion: variant.isChampion,
                  isCanary: variant.isCanary,
                }))}
                packs={packs.map((pack) => ({
                  dirName: pack.dirName,
                  name: pack.name,
                }))}
                canaryActive={canaryActive}
                canaryPercent={canary?.trafficPercent ?? 0}
              />
            ) : null}
          </div>
        }
      />

      {freeze.status === "frozen" ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-amber-200">
              <Snowflake className="size-4" />
              {t("frozenTitle")}
            </CardTitle>
            <Badge variant="warning">{freeze.kind ?? "manual"}</Badge>
          </CardHeader>
          <CardContent className="space-y-1 text-[11px] text-amber-100/80">
            <p>{freeze.reason}</p>
            <p className="font-mono text-[10px] text-amber-200/70">
              {t("frozenBy", {
                actor: freeze.actor ?? "operator",
                since: freeze.since ? timeAgo(freeze.since, locale) : "—",
              })}
            </p>
            {freeze.liftCondition ? (
              <p>{t("frozenLift", { condition: freeze.liftCondition })}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-violet-400" />
            {t("goodhartTitle")}
          </CardTitle>
          <Badge variant={divergence.divergent ? "danger" : "success"}>
            {divergence.divergent
              ? t("divergenceAlert")
              : t("divergenceSteady")}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3 text-[11px] text-zinc-400">
          <p className="max-w-3xl leading-relaxed">{t("goodhartBody")}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-zinc-950/40 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("outcomesLabel")}
              </p>
              <p className="font-mono text-zinc-200">{outcomeSummary.total}</p>
            </div>
            <div className="rounded-lg border border-border bg-zinc-950/40 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("outcomePassRate")}
              </p>
              <p className="font-mono text-zinc-200">
                {(outcomeSummary.passRate * 100).toFixed(0)}%
              </p>
            </div>
            <div className="rounded-lg border border-border bg-zinc-950/40 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("outcomeAvgScore")}
              </p>
              <p className="font-mono text-zinc-200">
                {outcomeSummary.avgScore.toFixed(2)}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-zinc-950/40 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                {t("agreementLabel")}
              </p>
              <p className="font-mono text-zinc-200">
                {agreement.rate === null
                  ? "—"
                  : `${(agreement.rate * 100).toFixed(0)}% (${agreement.sample})`}
              </p>
            </div>
          </div>
          <p>
            {t("divergenceStreak", {
              streak: divergence.streak,
              window: divergence.window,
            })}
          </p>
          {divergence.reasons.length > 0 ? (
            <ul className="space-y-1">
              {divergence.reasons.map((reason) => (
                <li
                  key={reason}
                  className="rounded border border-border bg-zinc-950/50 px-2 py-1 text-[10px] text-amber-300/80"
                >
                  {reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[10px] text-zinc-600">{t("divergenceNone")}</p>
          )}
          <div className="space-y-1 rounded-lg border border-border bg-zinc-950/40 px-3 py-2">
            <p className="flex items-center gap-1.5 text-zinc-300">
              <Gauge className="size-3.5 text-sky-300" />
              {t("driftTitle")}
              {drift?.reevaluateChampion ? (
                <Badge variant="warning">{t("driftReevaluate")}</Badge>
              ) : null}
            </p>
            {drift && drift.findings.length > 0 ? (
              <ul className="space-y-1">
                {drift.findings.map((finding) => (
                  <li
                    key={`${finding.kind}:${finding.detail}`}
                    className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400"
                  >
                    <Badge variant="outline">
                      {t(`driftKind.${finding.kind}`)}
                    </Badge>
                    <span>{finding.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10px] text-zinc-600">{t("driftNone")}</p>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-zinc-300">{t("governanceTitle")}</p>
            {governanceEvents.length === 0 ? (
              <p className="text-[10px] text-zinc-600">{t("governanceNone")}</p>
            ) : (
              <ul className="space-y-1">
                {governanceEvents.map((event) => (
                  <li
                    key={event.eventId}
                    className="flex flex-wrap items-center gap-1.5 rounded border border-border px-2 py-1 text-[10px]"
                  >
                    <Badge
                      variant={
                        event.kind === "divergence" ? "danger" : "warning"
                      }
                    >
                      {t(`governanceKind.${event.kind}`)}
                    </Badge>
                    <Badge variant="outline">
                      {t(`governanceAction.${event.action}`)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-zinc-400">
                      {event.reason}
                    </span>
                    <span className="font-mono text-zinc-600">
                      {timeAgo(event.createdAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-[10px] text-zinc-600">{t("goodhartNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Scale className="size-4 text-emerald-400" />
            {t("attributionTitle")}
          </CardTitle>
          <Badge variant="outline">
            {t("attributionCount", { count: attributions.length })}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3 text-[11px] text-zinc-400">
          <p className="max-w-3xl leading-relaxed">{t("attributionBody")}</p>
          {attributions.length === 0 ? (
            <p className="text-[10px] text-zinc-600">{t("attributionEmpty")}</p>
          ) : (
            <ul className="space-y-2">
              {attributions.map((attribution) => {
                const rollback = attribution.actions.rollback;
                const costRatio = attribution.delta.avgTokensRatio;
                return (
                  <li
                    key={attribution.attributionId}
                    className="rounded-lg border border-border px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] text-zinc-500">
                        {attribution.changeId}
                        {attribution.stage
                          ? ` · ${t(`attributionStage.${attribution.stage}`)}`
                          : ""}
                      </span>
                      <Badge
                        variant={
                          attribution.divergent
                            ? "danger"
                            : attribution.verdict === "regressed"
                              ? "warning"
                              : attribution.verdict === "improved"
                                ? "success"
                                : "outline"
                        }
                      >
                        {t(`attributionVerdict.${attribution.verdict}`)}
                      </Badge>
                      {rollback ? (
                        <Badge
                          variant={
                            rollback.status === "failed"
                              ? "danger"
                              : rollback.status === "rolled_back"
                                ? "warning"
                                : "outline"
                          }
                        >
                          {t(`attributionRollback.${rollback.status}`)}
                        </Badge>
                      ) : null}
                      <span className="ml-auto font-mono text-[10px] text-zinc-600">
                        {timeAgo(attribution.createdAt, locale)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-zinc-500">
                      {t("attributionWindow", {
                        baselineTasks: attribution.baseline.tasks,
                        baselinePass: (
                          attribution.baseline.passRate * 100
                        ).toFixed(0),
                        changedTasks: attribution.changed.tasks,
                        changedPass: (
                          attribution.changed.passRate * 100
                        ).toFixed(0),
                        cost:
                          costRatio === null ? "—" : `${costRatio.toFixed(2)}x`,
                      })}
                    </p>
                    {attribution.reasons.length > 0 ? (
                      <ul className="mt-1 space-y-1">
                        {attribution.reasons.map((reason) => (
                          <li
                            key={reason}
                            className="rounded border border-border bg-zinc-950/50 px-2 py-1 text-[10px] text-amber-300/80"
                          >
                            {reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {rollback ? (
                      <p className="mt-1 text-[10px] text-zinc-500">
                        {rollback.reason}
                        {rollback.auditId
                          ? ` · ${t("attributionAudit", {
                              auditId: rollback.auditId,
                            })}`
                          : ""}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[10px] text-zinc-600">{t("attributionNote")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-violet-400" />
            {t("explainerTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-[11px] text-zinc-400">
          <p className="max-w-3xl leading-relaxed">{t("explainerBody")}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Microscope,
                title: t("stepSignals"),
                body: t("stepSignalsBody"),
              },
              {
                icon: GitPullRequestArrow,
                title: t("stepPropose"),
                body: t("stepProposeBody"),
              },
              {
                icon: ClipboardCheck,
                title: t("stepEvaluate"),
                body: t("stepEvaluateBody"),
              },
              {
                icon: ShieldCheck,
                title: t("stepPromote"),
                body: t("stepPromoteBody"),
              },
            ].map((step) => {
              const Icon = step.icon;
              return (
                <div
                  key={step.title}
                  className="rounded-lg border border-border bg-zinc-950/40 px-3 py-2"
                >
                  <p className="flex items-center gap-1.5 text-[11px] text-zinc-200">
                    <Icon className="size-3.5 text-violet-300" />
                    {step.title}
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
                    {step.body}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-zinc-600">{t("explainerSafety")}</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          label={t("champion")}
          value={champion?.meta.name ?? t("notSet")}
          hint={
            champion
              ? t("avgScoreHint", {
                  score: champion.averageScore.toFixed(2),
                })
              : t("initHint")
          }
        />
        <StatCard
          label={t("canary")}
          value={
            canary
              ? t("canaryValue", {
                  percent: canary.trafficPercent,
                  status: canaryStatusLabel,
                })
              : common("none")
          }
          hint={
            canary?.since
              ? t("since", { time: timeAgo(canary.since, locale) })
              : t("noTraffic")
          }
        />
        <StatCard
          label={t("variants")}
          value={String(variants.length)}
          hint={t("scoredHint", {
            count: variants.filter((variant) => variant.latest).length,
          })}
        />
        <StatCard
          label={t("scoredRuns")}
          value={String(variants.filter((variant) => variant.latest).length)}
          hint={t("latestRecord")}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-violet-400" />
            {t("canaryState")}
          </CardTitle>
          {canary ? (
            <Badge
              variant={
                canary.status === "canary"
                  ? "success"
                  : canary.status === "promoted"
                    ? "info"
                    : canary.status === "shadow"
                      ? "violet"
                      : "danger"
              }
            >
              {canaryStatusLabel}
            </Badge>
          ) : (
            <Badge variant="outline">{t("notConfigured")}</Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-2 text-xs text-zinc-400">
          {canary ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <p>
                  {t("championLabel")}{" "}
                  <span className="font-mono text-zinc-200">
                    {state?.champion.path.split(/[\\/]/).pop()}
                  </span>
                </p>
                <p>
                  {t("candidate")}{" "}
                  <span className="font-mono text-zinc-200">
                    {canary.path.split(/[\\/]/).pop()}
                  </span>
                </p>
                <p>
                  {t("agent")}{" "}
                  <span className="font-mono text-zinc-200">
                    {canary.agentId}
                  </span>
                </p>
                <p>
                  {t("percent")}{" "}
                  <span className="font-mono text-zinc-200">
                    {canary.trafficPercent}%
                  </span>{" "}
                  <span className="text-zinc-600">{t("liveTraffic")}</span>
                </p>
                <p>
                  {t("championScore")}{" "}
                  <span className="font-mono text-zinc-200">
                    {champion?.latest ? champion.averageScore.toFixed(2) : "—"}
                  </span>
                </p>
                <p>
                  {t("candidateScore")}{" "}
                  <span className="font-mono text-zinc-200">
                    {canaryVariant?.latest
                      ? canaryVariant.averageScore.toFixed(2)
                      : "—"}
                  </span>
                </p>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-900">
                <div
                  className="h-full bg-violet-400"
                  style={{ width: `${canary.trafficPercent}%` }}
                />
              </div>
              <p className="text-[10px] text-zinc-600">
                {t("thresholds")}:{" "}
                {t("thresholdScore", {
                  value: `-${DEFAULT_CANARY_THRESHOLDS.score.toFixed(2)}`,
                })}{" "}
                ·{" "}
                {t("thresholdPassRate", {
                  value: `-${DEFAULT_CANARY_THRESHOLDS.passRate.toFixed(2)}`,
                })}{" "}
                ·{" "}
                {t("thresholdCost", {
                  value: DEFAULT_CANARY_THRESHOLDS.costMultiplier.toFixed(1),
                })}
              </p>
              {canary.reason ? (
                <p className="rounded border border-border bg-zinc-950/50 px-2 py-1.5 text-[11px] text-amber-300/80">
                  {canary.reason}
                </p>
              ) : null}
              <p className="text-[10px] text-zinc-600">{t("noCanaryNote")}</p>
            </>
          ) : (
            <p>{t("noCanary")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-violet-400" />
            {t("decisions")}
          </CardTitle>
          <Badge variant="outline">
            {t("decisionCount", { count: decisions.length })}
          </Badge>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-[11px] text-zinc-500">{t("noDecisions")}</p>
          ) : (
            <ul className="space-y-2">
              {decisions.map((decision) => (
                <li
                  key={decision.decisionId}
                  className="rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        decision.kind === "rollback"
                          ? "danger"
                          : decision.kind === "promote"
                            ? "success"
                            : decision.kind === "traffic_change"
                              ? "violet"
                              : "outline"
                      }
                    >
                      {t(`kind.${decision.kind}`)}
                    </Badge>
                    <span className="font-mono text-[10px] text-zinc-500">
                      {decision.agentId || "—"} · {decision.fromTrafficPercent}%
                      → {decision.toTrafficPercent}%
                    </span>
                    <Badge variant="outline">
                      {t(`trigger.${decision.trigger}`)}
                    </Badge>
                    <span className="ml-auto font-mono text-[10px] text-zinc-600">
                      {timeAgo(decision.createdAt, locale)}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-300">
                    {decision.reason}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                    {decision.actor} · {decision.variantId}
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
            <GitPullRequestArrow className="size-4 text-sky-400" />
            {t("cycleTimeline")}
          </CardTitle>
          <Badge variant="outline">
            {t("cycleCount", { count: cycles.length })}
          </Badge>
        </CardHeader>
        <CardContent>
          {cycles.length === 0 ? (
            <p className="text-[11px] text-zinc-500">{t("noCycles")}</p>
          ) : (
            <ul className="space-y-2">
              {cycles.slice(0, 12).map((cycle) => {
                const outcome = outcomeByCycle.get(cycle.cycleId);
                return (
                  <li
                    key={cycle.cycleId}
                    className="rounded-lg border border-border px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] text-zinc-500">
                        {cycle.cycleId}
                      </span>
                      <Badge
                        variant={
                          cycle.decision === "promoted"
                            ? "success"
                            : cycle.decision === "canary"
                              ? "violet"
                              : cycle.decision === "rejected"
                                ? "warning"
                                : cycle.decision === "failed"
                                  ? "danger"
                                  : "outline"
                        }
                      >
                        {t(`decision.${cycle.decision}`)}
                      </Badge>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {cycle.agentId || "—"} ·{" "}
                        {cycle.baselineScore?.toFixed(2) ?? "—"} →{" "}
                        {cycle.candidateScore?.toFixed(2) ?? "—"}
                      </span>
                      {outcome ? (
                        <Badge variant={outcome.pass ? "success" : "danger"}>
                          {t("outcomeBadge", {
                            score: outcome.score.toFixed(2),
                          })}
                        </Badge>
                      ) : null}
                      {cycle.drift?.drifted ? (
                        <Badge variant="warning">
                          {cycle.drift.reevaluateChampion
                            ? t("driftReevaluate")
                            : t("driftBadge")}
                        </Badge>
                      ) : null}
                      <span className="ml-auto font-mono text-[10px] text-zinc-600">
                        {formatCny(cycle.costCny)}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-300">
                      {cycle.hypothesis || cycle.rationale}
                    </p>
                    {cycle.signals.length > 0 ? (
                      <p className="mt-1 line-clamp-2 text-[10px] text-zinc-500">
                        {t("signals")}: {cycle.signals.join(" · ")}
                      </p>
                    ) : null}
                    {cycle.error ? (
                      <p className="mt-1 text-[10px] text-red-300">
                        {cycle.error}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {variants.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title={t("noVariantsTitle")}
          description={t("noVariantsDesc")}
          className="items-start text-left"
          action={
            <pre className="w-full max-w-2xl overflow-x-auto rounded border border-border bg-zinc-950 p-3 text-left font-mono text-[10px] text-zinc-400">
              {`bun run kit evolve init packs/tech-radar --out variants/baseline --name baseline
bun run kit evolve propose variants/baseline --agent writer --file writer.md --out variants/writer-v2 --name writer-v2
bun run kit evolve score variants/writer-v2 --baseline packs/tech-radar --input-file .tmp/evidence.json --agent writer`}
            </pre>
          }
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_5rem_5rem] gap-3 border-b border-border px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500 lg:grid-cols-[minmax(0,1fr)_8rem_5rem_5rem_5rem_5rem]">
            <span>{t("variant")}</span>
            <span className="hidden lg:block">{t("agent")}</span>
            <span>{t("latest")}</span>
            <span className="text-right">{t("averageScore")}</span>
            <span className="text-right">{t("deltaChampion")}</span>
            <span className="text-right">{t("cost")}</span>
          </div>
          <ul className="divide-y divide-border">
            {variants.map((variant) => {
              const delta = variant.averageScore - championScore;
              return (
                <li
                  key={variant.dirName}
                  className="grid grid-cols-[minmax(0,1fr)_5rem_5rem_5rem_5rem] items-center gap-3 px-4 py-3 text-xs lg:grid-cols-[minmax(0,1fr)_8rem_5rem_5rem_5rem_5rem]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-medium text-zinc-200">
                        {variant.meta.name}
                      </span>
                      {variant.isChampion ? (
                        <Badge variant="success">
                          <Trophy className="size-3" />
                          {common("champion")}
                        </Badge>
                      ) : null}
                      {variant.isCanary ? (
                        <Badge variant="violet">{common("canary")}</Badge>
                      ) : null}
                      {variant.canaryStatus === "rolled_back" ? (
                        <Badge variant="danger">{common("rolledBack")}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
                      {t("changedFiles", {
                        dir: variant.dirName,
                        files:
                          variant.meta.changedFiles.join(", ") ||
                          t("unchanged"),
                      })}
                    </p>
                  </div>
                  <div className="hidden text-[11px] lg:block">
                    <p className="font-mono text-zinc-300">
                      {variant.meta.agentId || "—"}
                    </p>
                    <p className="text-[10px] text-zinc-500">
                      {variant.meta.model || "—"}
                    </p>
                  </div>
                  <div>
                    {variant.latest ? (
                      <Badge
                        variant={variant.latest.pass ? "success" : "danger"}
                      >
                        {variant.latest.pass ? common("pass") : common("fail")}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{common("notScored")}</Badge>
                    )}
                  </div>
                  <div className="text-right font-mono text-[11px] text-zinc-300">
                    {variant.latest ? variant.averageScore.toFixed(2) : "—"}
                  </div>
                  <div
                    className={`text-right font-mono text-[11px] ${
                      variant.isChampion
                        ? "text-zinc-600"
                        : delta >= 0
                          ? "text-emerald-400"
                          : "text-red-400"
                    }`}
                  >
                    {variant.isChampion
                      ? "—"
                      : variant.latest
                        ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`
                        : "—"}
                  </div>
                  <div className="text-right font-mono text-[11px] text-zinc-400">
                    {variant.latest ? formatCny(variant.latest.costCny) : "—"}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-4 py-3 text-[11px] text-zinc-500">
        <GitCompare className="mt-0.5 size-3.5" />
        <p>{t("note")}</p>
      </div>
    </div>
  );
}
