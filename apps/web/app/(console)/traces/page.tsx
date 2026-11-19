import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type TraceTarget,
  type TraceTargetId,
  observabilityConfigFromEnv,
  traceTargets,
} from "@/lib/traces";
import { Activity, ArrowRight, ExternalLink, Workflow } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

const ICONS: Record<TraceTargetId, typeof Activity> = {
  jaegerWorker: Activity,
  jaegerCli: Activity,
  temporal: Workflow,
};

const LABEL_KEYS: Record<
  TraceTargetId,
  { title: string; description: string; badge: string }
> = {
  jaegerWorker: {
    title: "jaegerWorker",
    description: "jaegerWorkerDesc",
    badge: "otel",
  },
  jaegerCli: {
    title: "jaegerCli",
    description: "jaegerCliDesc",
    badge: "otel",
  },
  temporal: {
    title: "temporal",
    description: "temporalDesc",
    badge: "durable",
  },
};

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string }>;
}) {
  const t = await getTranslations("traces");
  const { runId: rawRunId } = await searchParams;
  const runId = rawRunId?.trim();

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} description={t("description")} />

      {runId ? (
        <>
          <p className="text-[11px] text-zinc-500">
            {t("showingFor", { runId })}
          </p>
          <div className="grid gap-3 lg:grid-cols-3">
            {traceTargets(runId, observabilityConfigFromEnv()).map((target) => (
              <TraceLink key={target.id} target={target} />
            ))}
          </div>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("noRunTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-zinc-400">{t("noRunHint")}</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/world">
                {t("openWorld")}
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

async function TraceLink({ target }: { target: TraceTarget }) {
  const t = await getTranslations("traces");
  const Icon = ICONS[target.id];
  const labels = LABEL_KEYS[target.id];

  if (!target.href) {
    return (
      <div
        aria-disabled="true"
        className="rounded-lg border border-dashed border-border bg-card/40 px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-zinc-600" />
          <span className="text-sm font-medium text-zinc-400">
            {t(labels.title)}
          </span>
          <Badge variant="outline" className="ml-auto text-[10px]">
            {t("notConfigured")}
          </Badge>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          {t(labels.description)}
        </p>
        <p className="mt-2 font-mono text-[10px] text-zinc-400">
          {target.envVar}
        </p>
        <p className="mt-0.5 text-[10px] text-zinc-500">{t("configureHint")}</p>
      </div>
    );
  }

  return (
    <a
      href={target.href}
      target="_blank"
      rel="noreferrer noopener"
      className="group rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/60"
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-emerald-400" />
        <span className="text-sm font-medium text-zinc-200">
          {t(labels.title)}
        </span>
        <Badge variant="outline" className="ml-auto text-[10px]">
          {t(labels.badge)}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">{t(labels.description)}</p>
      <p className="mt-2 flex items-center gap-1 text-[10px] text-emerald-400/80 group-hover:text-emerald-300">
        {t("open")}
        <ExternalLink className="size-3" />
      </p>
    </a>
  );
}
