import { PageHeader } from "@/components/kit/page-header";
import { RunStatusBadge } from "@/components/kit/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getStore } from "@/lib/store";
import { timeAgo } from "@/lib/utils";
import {
  Activity,
  ArrowUpRight,
  ExternalLink,
  Search,
  Workflow,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string }>;
}) {
  const t = await getTranslations("traces");
  const locale = await getLocale();
  const { runId } = await searchParams;
  const store = await getStore();
  const runs = await store.runs.listRecent(10);

  const jaegerUi =
    process.env.NEXT_PUBLIC_JAEGER_UI_URL ?? "http://localhost:16686";
  const temporalUi =
    process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ?? "http://localhost:8080";

  const tags = runId
    ? encodeURIComponent(JSON.stringify({ "run.id": runId }))
    : "";
  const jaegerWorker = runId
    ? `${jaegerUi}/search?service=kit-worker&tags=${tags}`
    : `${jaegerUi}/search?service=kit-worker`;
  const jaegerCli = runId
    ? `${jaegerUi}/search?service=kit-cli&tags=${tags}`
    : `${jaegerUi}/search?service=kit-cli`;
  const temporal = runId
    ? `${temporalUi}/namespaces/default/workflows/pack-${encodeURIComponent(runId)}`
    : `${temporalUi}/namespaces/default/workflows`;

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="size-4 text-zinc-400" />
            {t("findRun")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="flex flex-col gap-2 sm:flex-row">
            <Input
              name="runId"
              defaultValue={runId ?? ""}
              placeholder={t("runIdPlaceholder")}
              className="font-mono"
              aria-label={t("findRun")}
            />
            <Button type="submit" variant="outline">
              {t("search")}
            </Button>
          </form>
          {runId ? (
            <p className="mt-2 text-[11px] text-zinc-500">
              {t("showingFor", { runId })}
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-zinc-500">{t("enterHint")}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <TraceLink
          icon={Activity}
          title={t("jaegerWorker")}
          description={t("jaegerWorkerDesc")}
          href={jaegerWorker}
          badge={t("otel")}
          openLabel={t("open")}
        />
        <TraceLink
          icon={Activity}
          title={t("jaegerCli")}
          description={t("jaegerCliDesc")}
          href={jaegerCli}
          badge={t("otel")}
          openLabel={t("open")}
        />
        <TraceLink
          icon={Workflow}
          title={t("temporal")}
          description={t("temporalDesc")}
          href={temporal}
          badge={t("durable")}
          openLabel={t("open")}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("recentRuns")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {runs.map((run) => (
            <Link
              key={run.runId}
              href={`/traces?runId=${encodeURIComponent(run.runId)}`}
              className="flex items-center gap-2 rounded border border-border px-3 py-2 text-xs transition-colors hover:bg-accent/60"
            >
              <span className="truncate font-mono text-zinc-200">
                {run.runId}
              </span>
              <RunStatusBadge status={run.status} />
              <span className="ml-auto text-[10px] text-zinc-500">
                {timeAgo(run.createdAt, locale)}
              </span>
              <ArrowUpRight className="size-3 text-zinc-600" />
            </Link>
          ))}
          {runs.length === 0 ? (
            <p className="py-4 text-center text-xs text-zinc-500">
              {t("noRuns")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-[11px] text-zinc-600">{t("footer")}</p>
    </div>
  );
}

function TraceLink({
  icon: Icon,
  title,
  description,
  href,
  badge,
  openLabel,
}: {
  icon: typeof Activity;
  title: string;
  description: string;
  href: string;
  badge: string;
  openLabel: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="group rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/60"
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-emerald-400" />
        <span className="text-sm font-medium text-zinc-200">{title}</span>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {badge}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">{description}</p>
      <p className="mt-2 flex items-center gap-1 text-[10px] text-emerald-400/80 group-hover:text-emerald-300">
        {openLabel}
        <ExternalLink className="size-3" />
      </p>
    </a>
  );
}
