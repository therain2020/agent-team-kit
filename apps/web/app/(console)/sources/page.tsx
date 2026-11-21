import { PageHeader } from "@/components/kit/page-header";
import { SourceProposals } from "@/components/sources/source-proposals";
import { Button } from "@/components/ui/button";
import { WorkshopLibraryNav } from "@/components/workshop/library-nav";
import { SourceShelf } from "@/components/workshop/source-shelf";
import { loadSourceProposalSurface } from "@/lib/sources";
import { DISCOVERY_HREF } from "@/lib/workshop-library";
import {
  type WorkshopSourceHealthView,
  linkedSourceView,
} from "@/lib/workshop-link";
import { loadWorkshopSurface } from "@/lib/workshop-surface";
import { Store } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Local source library (88 §3.4 M2, D-69). Sources installed from the workshop
 * land in `sources/` and are shown here pinned to `repo@commit`; discovery is
 * one link away in the workshop.
 */
export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ pack?: string }>;
}) {
  const { pack } = await searchParams;
  const t = await getTranslations("sourcesLibrary");
  const [data, manufacture] = await Promise.all([
    loadWorkshopSurface(),
    loadSourceProposalSurface(),
  ]);
  const scope =
    data.packs.find((entry) => entry.dirName === pack || entry.name === pack) ??
    null;
  const { visible, scoped } = linkedSourceView(scope, data.sources, "pack");
  const health: WorkshopSourceHealthView[] = manufacture.health.map((row) => ({
    sourceId: row.sourceId,
    runs: row.runs,
    itemsCollected: row.itemsCollected,
    eventsCreated: row.eventsCreated,
    eventRatio:
      row.itemsCollected > 0 ? row.eventsCreated / row.itemsCollected : 0,
    consecutiveFailures: row.consecutiveFailures,
    degraded: row.degraded,
  }));

  return (
    <div className="space-y-3">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={DISCOVERY_HREF.source}>
              <Store className="size-3.5" />
              {t("discover")}
            </Link>
          </Button>
        }
      />

      <WorkshopLibraryNav />

      <SourceProposals
        initialProposals={manufacture.proposals}
        initialRetirements={manufacture.retirements}
      />

      {scope && scoped ? (
        <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200/90">
          {t("scopedTo", { pack: scope.name })}{" "}
          <Link href="/sources" className="text-emerald-300 hover:underline">
            {t("clearScope")}
          </Link>
        </p>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-card/60">
        <SourceShelf sources={visible} health={health} />
      </section>
    </div>
  );
}
