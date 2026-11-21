import { WorkshopDiscovery } from "@/components/workshop/workshop-discovery";
import {
  loadInstalledSourceViews,
  loadWorkshopDiscovery,
} from "@/lib/workshop-discovery";
import { parseAssetKind } from "@/lib/workshop-library";

export const dynamic = "force-dynamic";

/**
 * Workshop discovery center (88 §3.4, §6.1 M2). Discovery is partitioned by
 * asset type and never owns an install: every result previews and installs
 * into its local library, and the installed panel links back there.
 */
export default async function WorkshopPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; q?: string }>;
}) {
  const { kind, q } = await searchParams;
  const [data, sources] = await Promise.all([
    loadWorkshopDiscovery(),
    loadInstalledSourceViews(),
  ]);

  return (
    <WorkshopDiscovery
      initialKind={parseAssetKind(kind)}
      initialQuery={q ?? ""}
      installed={data.installed}
      counts={data.counts}
      sources={sources}
    />
  );
}
