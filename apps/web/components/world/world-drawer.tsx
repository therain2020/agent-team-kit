import { ActivityFeed } from "@/components/activity/activity-feed";
import {
  ArtifactViewer,
  type LineageItem,
} from "@/components/kit/artifact-viewer";
import { StageTimeline } from "@/components/kit/stage-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  cn,
  formatCny,
  formatDuration,
  formatNumber,
  timeUntil,
} from "@/lib/utils";
import type { WorldDrawerData } from "@/lib/world-page";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  Inbox,
  MessageSquare,
  Play,
  ScrollText,
  X,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import type { ReactNode } from "react";
import { DrawerShell } from "./drawer-shell";

export type WorldDrawerTab = "timeline" | "activity" | "artifacts";

export async function WorldDrawer({
  data,
  tab,
  closeHref,
}: {
  data: WorldDrawerData;
  tab: WorldDrawerTab;
  closeHref: string;
}) {
  const t = await getTranslations("world");
  const common = await getTranslations("common");
  const statusT = await getTranslations("status");
  const locale = await getLocale();
  const statusLabel = (status: string) =>
    KNOWN_STATUSES.has(status) ? statusT(status as StatusKey) : status;

  const tabHref = (next: WorldDrawerTab) =>
    `/world?run=${encodeURIComponent(data.runId)}&tab=${next}`;
  const waitReason =
    data.kind === "missing" ? null : (data.projection?.waitReason ?? null);

  if (data.kind === "missing") {
    return (
      <DrawerShell
        closeHref={closeHref}
        label={data.runId}
        closeLabel={common("close")}
      >
        <Header
          title={data.runId}
          closeHref={closeHref}
          closeLabel={common("close")}
          kicker={t("drawer.job")}
        />
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <FileText className="mb-3 size-6 text-zinc-600" />
          <p className="text-sm text-zinc-300">{t("drawer.missingTitle")}</p>
          <p className="mt-1 max-w-sm text-xs text-zinc-500">
            {t("drawer.missingHint")}
          </p>
          <Button asChild size="sm" variant="outline" className="mt-4">
            <Link href="/packs">
              <Play className="size-3.5" />
              {common("startRun")}
            </Link>
          </Button>
        </div>
      </DrawerShell>
    );
  }

  const tabs: Array<{
    id: WorldDrawerTab;
    label: string;
    icon: typeof Activity;
  }> = [
    { id: "timeline", label: t("drawer.timeline"), icon: ScrollText },
    { id: "activity", label: t("drawer.activity"), icon: Activity },
    { id: "artifacts", label: t("drawer.artifacts"), icon: FileText },
  ];

  return (
    <DrawerShell
      closeHref={closeHref}
      label={data.runId}
      closeLabel={common("close")}
    >
      <Header
        title={data.runId}
        closeHref={closeHref}
        closeLabel={common("close")}
        kicker={t("drawer.job")}
        badges={
          <>
            <Badge variant="outline">
              {t(data.kind === "iteration" ? "kindIteration" : "kindRun")}
            </Badge>
            <Badge
              variant={statusVariant(
                data.kind === "iteration"
                  ? data.run.status
                  : data.detail.run.status,
              )}
            >
              {statusLabel(
                data.kind === "iteration"
                  ? data.run.status
                  : data.detail.run.status,
              )}
            </Badge>
            {waitReason ? <Badge variant="warning">{waitReason}</Badge> : null}
          </>
        }
      />

      <div className="border-b border-border px-4 py-3">
        {data.kind === "run" ? (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <Metric
              label={common("duration")}
              value={formatDuration(
                data.detail.run.createdAt,
                data.detail.run.updatedAt,
                locale,
              )}
            />
            <Metric
              label={common("cost")}
              value={formatCny(data.detail.costCny)}
            />
            <Metric
              label={common("tokens")}
              value={formatNumber(data.detail.tokens)}
            />
            <Metric
              label={common("artifacts")}
              value={formatNumber(data.detail.artifacts.length)}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="line-clamp-2 text-xs text-zinc-300">
              {data.run.goal}
            </p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              <Metric
                label={common("duration")}
                value={formatDuration(
                  data.run.startedAt,
                  data.run.finishedAt ?? undefined,
                  locale,
                )}
              />
              <Metric
                label={common("tokens")}
                value={formatNumber(data.run.tokens)}
              />
              <Metric
                label={t("drawer.tasks")}
                value={formatNumber(data.tasks.length)}
              />
              <Metric
                label={t("drawer.turns")}
                value={formatNumber(data.run.turnCount)}
              />
            </div>
          </div>
        )}

        {waitReason ? (
          <p className="mt-2 rounded border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-200/90">
            {t("drawer.blockedWhy", { reason: waitReason })}
          </p>
        ) : null}

        <nav
          className="mt-3 flex items-center gap-1"
          aria-label={t("drawer.timeline")}
        >
          {tabs.map((item) => {
            const Icon = item.icon;
            const active = item.id === tab;
            return (
              <Link
                key={item.id}
                href={tabHref(item.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-zinc-200",
                  active && "bg-accent text-zinc-100",
                )}
              >
                <Icon className="size-3" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === "timeline" ? (
          data.kind === "run" ? (
            <div className="space-y-3">
              {data.detail.approval && data.detail.run.status === "paused" ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Inbox className="size-3.5 text-amber-400" />
                    <span className="text-xs font-medium text-amber-200">
                      {t("drawer.approvalWaiting")}
                    </span>
                    <span className="ml-auto text-[10px] text-zinc-500">
                      {data.detail.approval.expiresAt
                        ? timeUntil(data.detail.approval.expiresAt, locale)
                        : common("noExpiry")}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] text-zinc-400">
                    {data.detail.approval.summary ||
                      t("drawer.approvalFallback")}
                  </p>
                  <Button asChild size="sm" variant="outline" className="mt-2">
                    <Link
                      href={`/inbox/${encodeURIComponent(
                        data.detail.approval.requestId,
                      )}`}
                    >
                      {t("drawer.openInbox")}
                      <ArrowRight className="size-3" />
                    </Link>
                  </Button>
                </div>
              ) : null}
              <StageTimeline
                detail={data.detail}
                artifactHref={(key) =>
                  `${tabHref("artifacts")}&artifact=${encodeURIComponent(key)}`
                }
              />
            </div>
          ) : (
            <IterationTasks data={data} />
          )
        ) : null}

        {tab === "activity" ? (
          <ActivityFeed runId={data.runId} maxHeight="calc(100vh - 21rem)" />
        ) : null}

        {tab === "artifacts" ? (
          data.kind === "run" ? (
            <RunArtifacts data={data} tabHref={tabHref} />
          ) : (
            <IterationArtifacts data={data} />
          )
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2.5">
        <Button asChild size="sm" variant="outline">
          <Link href={`/manager?runId=${encodeURIComponent(data.runId)}`}>
            <MessageSquare className="size-3.5" />
            {t("drawer.askManager")}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`/traces?runId=${encodeURIComponent(data.runId)}`}>
            <ExternalLink className="size-3.5" />
            {t("drawer.traces")}
          </Link>
        </Button>
        {data.kind === "iteration" ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/iterations/${encodeURIComponent(data.runId)}`}>
              {t("drawer.openIteration")}
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        ) : null}
        {data.kind === "run" && data.detail.approval ? (
          <Button asChild size="sm" variant="ghost">
            <Link
              href={`/inbox/${encodeURIComponent(data.detail.approval.requestId)}`}
            >
              {t("drawer.openInbox")}
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        ) : null}
      </footer>
    </DrawerShell>
  );
}

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

async function Header({
  title,
  kicker,
  badges,
  closeHref,
  closeLabel,
}: {
  title: string;
  kicker: string;
  badges?: ReactNode;
  closeHref: string;
  closeLabel: string;
}) {
  return (
    <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-zinc-500">
          {kicker}
        </p>
        <h2 className="truncate font-mono text-sm text-zinc-100">{title}</h2>
        {badges ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {badges}
          </div>
        ) : null}
      </div>
      <Link
        href={closeHref}
        aria-label={closeLabel}
        className="rounded p-1 text-zinc-500 transition-colors hover:bg-accent hover:text-zinc-200"
      >
        <X className="size-4" />
      </Link>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-xs text-zinc-200">{value}</p>
    </div>
  );
}

async function IterationTasks({
  data,
}: {
  data: Extract<WorldDrawerData, { kind: "iteration" }>;
}) {
  const t = await getTranslations("world");
  const statusT = await getTranslations("status");
  if (data.tasks.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-500">
        {t("drawer.noTasks")}
      </p>
    );
  }
  return (
    <ol className="space-y-1.5">
      {data.tasks.map((task) => (
        <li key={task.taskId}>
          <Link
            href={`/iterations/${encodeURIComponent(data.runId)}?task=${encodeURIComponent(task.taskId)}`}
            className="block rounded-md border border-border bg-background/40 px-2.5 py-2 transition-colors hover:border-zinc-600 hover:bg-accent/40"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[11px] text-zinc-200">
                {task.taskId}
              </span>
              <Badge variant={statusVariant(task.status)}>
                {KNOWN_STATUSES.has(task.status)
                  ? statusT(task.status as StatusKey)
                  : task.status}
              </Badge>
              <Badge variant="outline">{task.domain}</Badge>
              {task.stalled ? (
                <Badge variant="warning">{statusT("stalled")}</Badge>
              ) : null}
              <span className="ml-auto font-mono text-[10px] text-zinc-500">
                {formatNumber(task.tokens)} tok
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">
              {task.goal}
            </p>
            {task.changedFiles.length > 0 ? (
              <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
                {task.changedFiles.slice(0, 4).join(" · ")}
                {task.changedFiles.length > 4
                  ? ` +${task.changedFiles.length - 4}`
                  : ""}
              </p>
            ) : null}
          </Link>
        </li>
      ))}
    </ol>
  );
}

async function RunArtifacts({
  data,
  tabHref,
}: {
  data: Extract<WorldDrawerData, { kind: "run" }>;
  tabHref: (tab: WorldDrawerTab) => string;
}) {
  const t = await getTranslations("world");
  const artifactT = await getTranslations("artifact");
  if (data.detail.artifacts.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-500">
        {t("drawer.noArtifacts")}
      </p>
    );
  }

  const selected = data.selected;
  const lineage: LineageItem[] = selected
    ? (selected.view.manifest?.inputs ?? []).map((input) => ({
        artifactId: input.artifactId,
        version: input.version,
        label: artifactT(
          `kind.${data.detail.artifacts.find((view) => view.artifact.artifactId === input.artifactId)?.kind ?? "artifact"}`,
        ),
        href: `${tabHref("artifacts")}&artifact=${encodeURIComponent(
          `${input.artifactId}:${input.version}`,
        )}`,
      }))
    : [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {data.detail.artifacts.map((view) => {
          const key = `${view.artifact.artifactId}:${view.artifact.version}`;
          const active =
            selected?.view.artifact.artifactId === view.artifact.artifactId &&
            selected.view.artifact.version === view.artifact.version;
          return (
            <Link
              key={key}
              href={`${tabHref("artifacts")}&artifact=${encodeURIComponent(key)}`}
              className={cn(
                "rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 transition-colors hover:bg-accent hover:text-zinc-200",
                active && "bg-accent text-zinc-100",
              )}
            >
              {view.artifact.artifactId}
              <span className="text-zinc-600"> v{view.artifact.version}</span>
            </Link>
          );
        })}
      </div>
      {selected ? (
        <div className="h-[min(60vh,34rem)] overflow-hidden rounded-md border border-border">
          <ArtifactViewer
            artifact={selected.view.artifact}
            manifest={selected.view.manifest}
            kind={selected.view.kind}
            content={selected.content.text}
            truncated={selected.content.truncated}
            unavailable={selected.content.unavailable}
            diff={selected.diff}
            diffLabel={
              selected.view.kind === "revision"
                ? t("drawer.diffAgainstDraft")
                : undefined
            }
            lineage={lineage}
          />
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-500">
          {t("drawer.selectArtifact")}
        </p>
      )}
    </div>
  );
}

async function IterationArtifacts({
  data,
}: {
  data: Extract<WorldDrawerData, { kind: "iteration" }>;
}) {
  const t = await getTranslations("world");
  const tasksWithArtifacts = data.tasks.filter(
    (task) =>
      task.diffArtifactId ||
      task.transcriptArtifactId ||
      task.verificationArtifactId ||
      task.applyArtifactId,
  );
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-zinc-500">
        {t("drawer.iterationArtifactsHint")}
      </p>
      {tasksWithArtifacts.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-800 px-4 py-8 text-center text-xs text-zinc-500">
          {t("drawer.noArtifacts")}
        </p>
      ) : (
        <ul className="space-y-1">
          {tasksWithArtifacts.map((task) => (
            <li
              key={task.taskId}
              className="rounded-md border border-border bg-background/40 px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-3 text-zinc-500" />
                <span className="font-mono text-[11px] text-zinc-300">
                  {task.taskId}
                </span>
                <Link
                  href={`/iterations/${encodeURIComponent(data.runId)}?task=${encodeURIComponent(task.taskId)}`}
                  className="ml-auto text-[10px] text-emerald-400 hover:text-emerald-300"
                >
                  {t("drawer.openIteration")} →
                </Link>
              </div>
              <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">
                {[
                  task.diffArtifactId,
                  task.transcriptArtifactId,
                  task.verificationArtifactId,
                  task.applyArtifactId,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
