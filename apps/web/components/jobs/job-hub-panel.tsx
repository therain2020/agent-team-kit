import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { JobHubSummary } from "@/lib/job-hub";
import {
  type JobArtifactKind,
  type JobArtifactRef,
  iterationArtifactHref,
} from "@/lib/job-hub-view";
import { formatNumber, timeAgo } from "@/lib/utils";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  FlaskConical,
  GitBranch,
  Inbox,
  ScrollText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ReactNode } from "react";

const KNOWN_STATUSES = new Set([
  "pending",
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "applied",
  "passed",
  "done",
  "completed",
  "blocked",
  "reverted",
  "applying",
  "stalled",
]);

/**
 * Aggregate tab of the job drawer (#107): one job, every related plane in one
 * scroll. Each row is an id link into the owning surface — approvals, pending
 * apply tickets, the report, related artifacts, evolution cycles and the
 * manager decisions — so nothing is copied, only pointed at.
 */
export async function JobHubPanel({ hub }: { hub: JobHubSummary }) {
  const t = await getTranslations("world");
  const statusT = await getTranslations("status");
  const locale = await getLocale();
  const now = Date.now();

  const statusLabel = (status: string) =>
    KNOWN_STATUSES.has(status) ? statusT(status as StatusKey) : status;
  const artifactKind: Record<JobArtifactKind, string> = {
    report: t("drawer.hubKindReport"),
    diff: t("drawer.hubKindDiff"),
    transcript: t("drawer.hubKindTranscript"),
    verification: t("drawer.hubKindVerification"),
    apply: t("drawer.hubKindApply"),
    lineage: t("drawer.hubKindLineage"),
  };

  return (
    <div className="space-y-2.5">
      <Section icon={GitBranch} title={t("drawer.hubUpstream")}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{hub.upstream.originKind}</Badge>
          {hub.upstream.pack ? (
            <Badge variant="outline" className="max-w-[16rem] truncate">
              {hub.upstream.pack}
            </Badge>
          ) : null}
          {hub.upstream.project ? (
            <span
              className="max-w-full truncate font-mono text-[10px] text-zinc-500"
              title={hub.upstream.project}
            >
              {hub.upstream.project}
            </span>
          ) : null}
          {hub.upstream.sourceHref ? (
            <Link
              href={hub.upstream.sourceHref}
              className="inline-flex items-center gap-1 text-[11px] text-sky-300/90 hover:text-sky-200"
            >
              {t("drawer.hubSourceJob")}
              <ArrowRight className="size-3" />
            </Link>
          ) : (
            <span className="text-[10px] text-zinc-500">
              {t("drawer.hubNoSource")}
            </span>
          )}
        </div>
      </Section>

      <Section icon={Inbox} title={t("drawer.hubApprovals")}>
        {hub.approvals.length === 0 ? (
          <Empty>{t("drawer.hubNoApprovals")}</Empty>
        ) : (
          <ul className="space-y-1">
            {hub.approvals.map((approval) => (
              <li key={approval.requestId}>
                <Link
                  href={`/approvals?request=${encodeURIComponent(approval.requestId)}`}
                  className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-accent hover:text-zinc-100"
                >
                  <Badge variant={approvalVariant(approval.status)}>
                    {statusLabel(approval.status)}
                  </Badge>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {approval.requestId}
                  </span>
                  {approval.stageName ? (
                    <span className="truncate text-[10px] text-zinc-500">
                      {approval.stageName}
                    </span>
                  ) : null}
                  <ArrowRight className="ml-auto size-3 shrink-0 text-zinc-600" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        icon={CheckCircle2}
        title={t("drawer.hubPending")}
        aside={
          hub.pendingChanges.length > 0
            ? t("drawer.hubFiles", { count: hub.pendingSummary.files })
            : null
        }
      >
        {hub.pendingChanges.length === 0 ? (
          <Empty>{t("drawer.hubNoPending")}</Empty>
        ) : (
          <ul className="space-y-1">
            {hub.pendingChanges.map((change) => (
              <li
                key={change.ticketId}
                className="rounded border border-border bg-background/40 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-zinc-200">
                    {change.taskId}
                  </span>
                  <Badge variant={statusVariant(change.status)}>
                    {statusLabel(change.status)}
                  </Badge>
                  <Badge variant={riskVariant(change.risk)}>
                    {change.risk}
                  </Badge>
                  <span className="font-mono text-[10px] text-zinc-500">
                    {t("drawer.hubFiles", { count: change.changedFiles })}
                  </span>
                  {change.diffArtifactId ? (
                    <Link
                      href={iterationArtifactHref(
                        hub.jobId,
                        change.diffArtifactId,
                      )}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-auto inline-flex items-center gap-1 text-[10px] text-sky-300/90 hover:text-sky-200"
                    >
                      {t("drawer.hubKindDiff")}
                      <ExternalLink className="size-3" />
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={ScrollText} title={t("drawer.hubReport")}>
        {hub.report ? (
          <ArtifactLink
            artifact={hub.report}
            label={artifactKind.report}
            external={hub.kind === "iteration"}
          />
        ) : (
          <Empty>{t("drawer.hubNoReport")}</Empty>
        )}
        {hub.decisions > 0 ? (
          <p className="mt-1.5 text-[10px] text-zinc-500">
            {t("drawer.hubDecisions", { count: formatNumber(hub.decisions) })}
          </p>
        ) : null}
      </Section>

      <Section
        icon={FileText}
        title={t("drawer.hubArtifacts")}
        aside={formatNumber(hub.artifactCount)}
      >
        {hub.artifacts.length === 0 ? (
          <Empty>{t("drawer.hubNoArtifacts")}</Empty>
        ) : (
          <div className="flex flex-wrap gap-1">
            {hub.artifacts.map((artifact) => (
              <ArtifactChip
                key={`${artifact.artifactId}:${artifact.version ?? "latest"}:${artifact.kind}`}
                artifact={artifact}
                label={artifactKind[artifact.kind]}
                external={hub.kind === "iteration"}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        icon={FlaskConical}
        title={t("drawer.hubEvolution")}
        aside={
          <Link
            href={hub.links.evolution}
            className="inline-flex items-center gap-1 text-[10px] text-sky-300/90 hover:text-sky-200"
          >
            {t("drawer.hubOpenEvolution")}
            <ArrowRight className="size-3" />
          </Link>
        }
      >
        {hub.evolutionCycles.length === 0 ? (
          <Empty>{t("drawer.hubNoEvolution")}</Empty>
        ) : (
          <ul className="space-y-1">
            {hub.evolutionCycles.map((cycle) => (
              <li key={cycle.cycleId}>
                <Link
                  href={hub.links.evolution}
                  className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-accent hover:text-zinc-100"
                >
                  <Badge variant={cycleVariant(cycle.decision)}>
                    {cycle.decision}
                  </Badge>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {cycle.agentId || cycle.cycleId}
                  </span>
                  {cycle.taskId ? (
                    <span className="truncate font-mono text-[10px] text-zinc-500">
                      {cycle.taskId}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[10px] text-zinc-500">
                    {timeAgo(cycle.createdAt, locale, now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-[10px] text-zinc-600">{t("drawer.hubHint")}</p>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  aside,
  children,
}: {
  icon: LucideIcon;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-background/40 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Icon className="size-3 text-zinc-500" />
        <h3 className="text-[11px] font-medium text-zinc-200">{title}</h3>
        {aside ? (
          <span className="ml-auto text-[10px] text-zinc-500">{aside}</span>
        ) : null}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[10px] text-zinc-600">{children}</p>;
}

function ArtifactChip({
  artifact,
  label,
  external,
}: {
  artifact: JobArtifactRef;
  label: string;
  external: boolean;
}) {
  const content = (
    <>
      <span className="text-zinc-500">{label}</span> {artifact.artifactId}
      {artifact.version !== null ? (
        <span className="text-zinc-600"> v{artifact.version}</span>
      ) : null}
    </>
  );
  const className =
    "inline-flex max-w-full items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 transition-colors hover:bg-accent hover:text-zinc-200";
  return external ? (
    <a
      href={artifact.href}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
    >
      {content}
    </a>
  ) : (
    <Link href={artifact.href} className={className}>
      {content}
    </Link>
  );
}

function ArtifactLink({
  artifact,
  label,
  external,
}: {
  artifact: JobArtifactRef;
  label: string;
  external: boolean;
}) {
  return (
    <Button asChild size="sm" variant="outline">
      {external ? (
        <a href={artifact.href} target="_blank" rel="noreferrer noopener">
          <ScrollText className="size-3.5" />
          {label}
          <ExternalLink className="size-3" />
        </a>
      ) : (
        <Link href={artifact.href}>
          <ScrollText className="size-3.5" />
          {label}
          <ArrowRight className="size-3" />
        </Link>
      )}
    </Button>
  );
}

type StatusKey =
  | "pending"
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "applied"
  | "passed"
  | "done"
  | "completed"
  | "blocked"
  | "reverted"
  | "applying"
  | "stalled";

function statusVariant(status: string) {
  if (status === "succeeded" || status === "passed" || status === "applied") {
    return "success" as const;
  }
  if (status === "failed" || status === "blocked" || status === "reverted") {
    return "danger" as const;
  }
  if (status === "running" || status === "applying") {
    return "info" as const;
  }
  if (status === "paused" || status === "stalled") {
    return "warning" as const;
  }
  return "outline" as const;
}

function approvalVariant(status: string) {
  if (status === "queued") {
    return "warning" as const;
  }
  if (status === "approved") {
    return "success" as const;
  }
  if (status === "rejected" || status === "expired") {
    return "danger" as const;
  }
  return "outline" as const;
}

function riskVariant(risk: "low" | "medium" | "high") {
  if (risk === "high") {
    return "danger" as const;
  }
  if (risk === "medium") {
    return "warning" as const;
  }
  return "outline" as const;
}

function cycleVariant(decision: string) {
  if (decision === "promoted") {
    return "success" as const;
  }
  if (decision === "rejected" || decision === "failed") {
    return "danger" as const;
  }
  if (decision === "canary") {
    return "info" as const;
  }
  return "outline" as const;
}
