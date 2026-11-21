import { PageHeader } from "@/components/kit/page-header";
import { Button } from "@/components/ui/button";
import { WorkshopLibraryNav } from "@/components/workshop/library-nav";
import { SourceShelf } from "@/components/workshop/source-shelf";
import { DISCOVERY_HREF } from "@/lib/workshop-library";
import { linkedSourceView } from "@/lib/workshop-link";
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
  const data = await loadWorkshopSurface();
  const scope =
    data.packs.find((entry) => entry.dirName === pack || entry.name === pack) ??
    null;
  const { visible, scoped } = linkedSourceView(scope, data.sources, "pack");

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

      {scope && scoped ? (
        <p className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200/90">
          {t("scopedTo", { pack: scope.name })}{" "}
          <Link href="/sources" className="text-emerald-300 hover:underline">
            {t("clearScope")}
          </Link>
        </p>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border bg-card/60">
        <SourceShelf sources={visible} />
      </section>
    </div>
  );
}
