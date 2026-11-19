import { Badge } from "@/components/ui/badge";
import type { ArtifactView, RunDetail } from "@/lib/runs";
import { cn, formatDuration, timeAgo } from "@/lib/utils";
import {
  CheckCircle2,
  Circle,
  Clock3,
  FileText,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { StageStatusBadge } from "./status-badge";

const ICONS = {
  pending: Circle,
  running: Loader2,
  succeeded: CheckCircle2,
  failed: XCircle,
  skipped: Clock3,
};

export async function StageTimeline({
  detail,
  selectedKey,
  artifactHref,
}: {
  detail: RunDetail;
  selectedKey?: string;
  /**
   * Destination for artifact chips. The world drawer routes them through the
   * `/world` deep link; legacy callers keep the `/runs/[id]` alias.
   */
  artifactHref?: (artifactKey: string) => string;
}) {
  const { run, stages, artifacts } = detail;
  const t = await getTranslations("runDetail");
  const artifactT = await getTranslations("artifact");
  const locale = await getLocale();

  if (stages.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("noStages")}</p>;
  }

  return (
    <ol className="relative space-y-1">
      {stages.map((stage, index) => {
        const Icon = ICONS[stage.status] ?? Circle;
        const prefix = `${run.runId}:${stage.name}`;
        const stageArtifacts = artifacts.filter((view) => {
          const stageId = view.manifest?.stageId ?? "";
          return stageId === prefix || stageId.startsWith(`${prefix}:`);
        });
        const stageGates = detail.gates.filter((gate) =>
          gate.stageId.startsWith(`${prefix}:gate`),
        );

        return (
          <li key={stage.stageId} className="relative pl-7">
            {index < stages.length - 1 ? (
              <span className="absolute left-[9px] top-7 h-[calc(100%-12px)] w-px bg-zinc-800" />
            ) : null}
            <Icon
              className={cn(
                "absolute left-0 top-1.5 size-[18px]",
                stage.status === "succeeded" && "text-emerald-400",
                stage.status === "running" && "animate-spin text-sky-400",
                stage.status === "failed" && "text-red-400",
                stage.status === "pending" && "text-zinc-600",
                stage.status === "skipped" && "text-zinc-600",
              )}
            />
            <div className="rounded-md border border-transparent px-2 py-2 transition-colors hover:border-border hover:bg-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-zinc-200">
                  {stage.name}
                </span>
                <StageStatusBadge status={stage.status} />
                <span className="text-[11px] text-zinc-500">
                  {formatDuration(stage.startedAt, stage.finishedAt, locale)}
                </span>
                {stage.startedAt ? (
                  <span className="text-[11px] text-zinc-600">
                    {timeAgo(stage.startedAt, locale)}
                  </span>
                ) : null}
                {stage.checkpointId ? (
                  <Badge variant="outline">
                    {t("checkpoint", { id: stage.checkpointId })}
                  </Badge>
                ) : null}
              </div>
              {stage.error ? (
                <p className="mt-1 text-[11px] text-red-400">{stage.error}</p>
              ) : null}

              {stageGates.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {stageGates.map((gate) => (
                    <Badge
                      key={`${gate.stageId}:${gate.attempt}`}
                      variant={gate.pass ? "success" : "danger"}
                    >
                      <ShieldCheck className="size-3" />
                      {gate.pass
                        ? t("gatePass", { attempt: gate.attempt })
                        : t("gateFail", { attempt: gate.attempt })}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {stageArtifacts.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {stageArtifacts.map((view) => (
                    <ArtifactLink
                      key={`${view.artifact.artifactId}:${view.artifact.version}`}
                      view={view}
                      runId={run.runId}
                      artifactHref={artifactHref}
                      kindLabel={artifactT(`kind.${view.kind}`)}
                      selected={
                        selectedKey ===
                        `${view.artifact.artifactId}:${view.artifact.version}`
                      }
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ArtifactLink({
  view,
  runId,
  artifactHref,
  kindLabel,
  selected,
}: {
  view: ArtifactView;
  runId: string;
  artifactHref?: (artifactKey: string) => string;
  kindLabel: string;
  selected: boolean;
}) {
  const key = `${view.artifact.artifactId}:${view.artifact.version}`;
  return (
    <li>
      <Link
        href={
          artifactHref
            ? artifactHref(key)
            : `/runs/${encodeURIComponent(runId)}?artifact=${encodeURIComponent(key)}`
        }
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200",
          selected && "bg-zinc-800 text-zinc-100",
        )}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="font-mono">{view.artifact.artifactId}</span>
        <span className="text-zinc-600">v{view.artifact.version}</span>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {kindLabel}
        </Badge>
      </Link>
    </li>
  );
}
