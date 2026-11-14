import { ActivityFeed } from "@/components/activity/activity-feed";
import { ArtifactViewer } from "@/components/kit/artifact-viewer";
import { AutoRefresh } from "@/components/kit/auto-refresh";
import { GateCard } from "@/components/kit/gate-card";
import { PageHeader } from "@/components/kit/page-header";
import { StageTimeline } from "@/components/kit/stage-timeline";
import { RunModeBadge, RunStatusBadge } from "@/components/kit/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ArtifactView,
  loadArtifactContent,
  loadRunDetail,
} from "@/lib/runs";
import {
  formatCny,
  formatDuration,
  formatNumber,
  timeUntil,
} from "@/lib/utils";
import { diffLines } from "diff";
import {
  ArrowLeft,
  Clock,
  Coins,
  ExternalLink,
  FileStack,
  MessageSquare,
  ScrollText,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ artifact?: string }>;
}) {
  const { runId } = await params;
  const { artifact: artifactQuery } = await searchParams;
  const t = await getTranslations("runDetail");
  const common = await getTranslations("common");
  const artifactT = await getTranslations("artifact");
  const activityT = await getTranslations("activity");
  const locale = await getLocale();
  const id = decodeURIComponent(runId);
  const detail = await loadRunDetail(id);
  if (!detail) {
    notFound();
  }

  const { run, artifacts, gates, approval } = detail;
  const selected = pickSelected(artifacts, artifactQuery, detail.report);
  const content = selected
    ? await loadArtifactContent(selected.artifact)
    : { text: "", truncated: false, unavailable: false };

  const lineage = selected?.manifest?.inputs ?? [];
  const lineageItems = lineage.map((input) => {
    const target = artifacts.find(
      (view) => view.artifact.artifactId === input.artifactId,
    );
    return {
      artifactId: input.artifactId,
      version: input.version,
      label: artifactT(`kind.${target?.kind ?? "artifact"}`),
      href: `/runs/${encodeURIComponent(run.runId)}?artifact=${encodeURIComponent(
        `${input.artifactId}:${input.version}`,
      )}`,
    };
  });

  const diff = selected ? await buildDiff(selected, artifacts) : null;
  const temporalUi =
    process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ?? "http://localhost:8080";

  return (
    <div className="space-y-5">
      <AutoRefresh active={run.status === "running"} />

      <div>
        <Link
          href="/runs"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-zinc-200"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
      </div>

      <PageHeader
        title={run.runId}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <RunModeBadge mode={run.runMode} />
            <span className="font-mono text-xs">{run.workflowId}</span>
            <span className="text-zinc-600">·</span>
            <span className="font-mono text-xs">{run.workspaceId}</span>
          </span>
        }
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/manager?runId=${encodeURIComponent(run.runId)}`}>
                <MessageSquare className="size-3.5" />
                {t("askManager")}
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`${temporalUi}/namespaces/default/workflows/pack-${encodeURIComponent(run.runId)}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink className="size-3.5" />
                {t("temporal")}
              </a>
            </Button>
          </>
        }
      />

      {run.runMode !== "LIVE" ? (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
          {t("notLive", { mode: run.runMode })}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric
          icon={Coins}
          label={common("cost")}
          value={formatCny(detail.costCny)}
        />
        <Metric
          icon={FileStack}
          label={common("artifacts")}
          value={formatNumber(artifacts.length)}
        />
        <Metric
          icon={ScrollText}
          label={common("tokens")}
          value={formatNumber(detail.tokens)}
        />
        <Metric
          icon={Clock}
          label={common("duration")}
          value={formatDuration(run.createdAt, run.updatedAt, locale)}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>{t("stages")}</CardTitle>
            </CardHeader>
            <CardContent>
              <StageTimeline
                detail={detail}
                selectedKey={
                  selected
                    ? `${selected.artifact.artifactId}:${selected.artifact.version}`
                    : undefined
                }
              />
            </CardContent>
          </Card>

          {approval && run.status === "paused" ? (
            <Card className="border-amber-500/30">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {t("waitingForYou")}
                  <Badge variant="warning">{t("approval")}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-zinc-400">
                <p>{approval.summary || t("summaryFallback")}</p>
                <p className="text-[11px] text-zinc-500">
                  {t("expiresAt", {
                    time: approval.expiresAt
                      ? timeUntil(approval.expiresAt, locale)
                      : "—",
                  })}
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={`/inbox/${encodeURIComponent(approval.requestId)}`}
                  >
                    {t("openInbox")}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {gates.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("gateAttempts")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {gates.map((gate) => (
                  <GateCard
                    key={`${gate.stageId}:${gate.attempt}`}
                    gate={gate}
                  />
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Provenance detail={detail} />
        </div>

        <Card className="min-h-[32rem] overflow-hidden">
          {selected ? (
            <ArtifactViewer
              artifact={selected.artifact}
              manifest={selected.manifest}
              kind={selected.kind}
              content={content.text}
              truncated={content.truncated}
              unavailable={content.unavailable}
              diff={diff}
              diffLabel={
                selected.kind === "revision" ? t("diffAgainstDraft") : undefined
              }
              lineage={lineageItems}
            />
          ) : (
            <div className="p-6 text-sm text-muted-foreground">
              {t("noArtifacts")}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{activityT("title")}</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            {activityT("description")}
          </p>
        </CardHeader>
        <CardContent>
          <ActivityFeed runId={run.runId} maxHeight="28rem" />
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Coins;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <Icon className="size-3" />
        {label}
      </p>
      <p className="mt-0.5 font-mono text-sm text-zinc-200">{value}</p>
    </div>
  );
}

async function Provenance({
  detail,
}: { detail: Awaited<ReturnType<typeof loadRunDetail>> }) {
  if (!detail) {
    return null;
  }
  const t = await getTranslations("runDetail");
  const common = await getTranslations("common");
  const artifactT = await getTranslations("artifact");
  const { run, artifacts } = detail;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("provenance")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="rounded border border-border px-2 py-1.5 text-[11px] text-zinc-400">
          <span className="text-zinc-500">{t("event")}</span>{" "}
          <span className="font-mono">{run.eventId}</span>
        </div>
        {artifacts.map((view) => (
          <div
            key={`${view.artifact.artifactId}:${view.artifact.version}`}
            className="rounded border border-border px-2 py-1.5 text-[11px]"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-zinc-300">
                {view.artifact.artifactId}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {artifactT(`kind.${view.kind}`)}
              </Badge>
              <span className="ml-auto text-zinc-600">
                {view.manifest?.producer.agentId ?? common("unknown")}
              </span>
            </div>
            {view.manifest?.inputs.length ? (
              <p className="mt-1 text-zinc-600">
                {t("from")}{" "}
                {view.manifest.inputs
                  .map((input) => `${input.artifactId}:v${input.version}`)
                  .join(", ")}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function pickSelected(
  artifacts: ArtifactView[],
  query: string | undefined,
  report: ArtifactView | null,
): ArtifactView | null {
  if (query) {
    const [artifactId, versionRaw] = query.split(":");
    const version = Number(versionRaw ?? 1);
    const match = artifacts.find(
      (view) =>
        view.artifact.artifactId === artifactId &&
        view.artifact.version === version,
    );
    if (match) {
      return match;
    }
  }
  if (report) {
    return report;
  }
  return artifacts.at(-1) ?? null;
}

async function buildDiff(selected: ArtifactView, artifacts: ArtifactView[]) {
  const input = selected.manifest?.inputs[0];
  if (!input) {
    return null;
  }
  const previous = artifacts.find(
    (view) => view.artifact.artifactId === input.artifactId,
  );
  if (!previous) {
    return null;
  }
  const [before, after] = await Promise.all([
    loadArtifactContent(previous.artifact),
    loadArtifactContent(selected.artifact),
  ]);
  return diffLines(before.text, after.text).map((part) => ({
    value: part.value,
    added: part.added,
    removed: part.removed,
  }));
}
