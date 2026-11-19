import { AtlasView } from "@/components/atlas/atlas-view";
import { PageHeader } from "@/components/kit/page-header";
import { Badge } from "@/components/ui/badge";
import { loadAtlasRun } from "@/lib/atlas";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * `/atlas` — one synthetic view of a run (99 §3.1–§3.5): living flow, trace
 * waterfall, cost river, run vitals and the artifact evidence chain. Every
 * region reads an existing server model (world snapshot, run detail, cost
 * time series, artifact edges); when no run is reachable the page renders the
 * labelled demo model instead of failing.
 */
export default async function AtlasPage({
  searchParams,
}: {
  searchParams: Promise<{
    runId?: string | string[];
    artifact?: string | string[];
  }>;
}) {
  const t = await getTranslations("atlas");
  const params = await searchParams;
  const runId = firstValue(params.runId);
  const artifactKey = firstValue(params.artifact);

  const data = await loadAtlasRun({
    ...(runId ? { runId } : {}),
    ...(artifactKey ? { artifactKey } : {}),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Badge variant="outline" className="font-mono text-[10px]">
            {t("eyebrow")}
          </Badge>
        }
      />
      <AtlasView data={data} />
    </div>
  );
}

function firstValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}
