"use client";

import { PageHeader } from "@/components/kit/page-header";
import { SourcesMarket } from "@/components/sources/sources-market";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkshopLibraryNav } from "@/components/workshop/library-nav";
import { WorkshopMarket } from "@/components/workshop/workshop-market";
import { cn } from "@/lib/utils";
import {
  WORKSHOP_ASSET_KINDS,
  type WorkshopAssetKind,
  type WorkshopInstalledItem,
  type WorkshopLibraryCounts,
} from "@/lib/workshop-library";
import type { InstalledSourceView } from "@/lib/workshop-link";
import {
  Boxes,
  LayoutTemplate,
  Package,
  Rss,
  Store,
  Workflow,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const KIND_LABEL: Record<WorkshopAssetKind, string> = {
  pack: "kindPack",
  pipeline: "kindPipeline",
  source: "kindSource",
  component: "kindComponent",
  template: "kindTemplate",
};

const KIND_ICON: Record<WorkshopAssetKind, typeof Package> = {
  pack: Package,
  pipeline: Workflow,
  source: Rss,
  component: Boxes,
  template: LayoutTemplate,
};

const LIBRARY_LABEL: Record<WorkshopInstalledItem["library"], string> = {
  packs: "libraryPacks",
  sources: "librarySources",
  components: "libraryComponents",
  templates: "libraryTemplates",
  workshop: "libraryStaging",
};

/**
 * Workshop discovery center (88 §3.4, §6.1 M2): one search-and-preview surface
 * partitioned by asset type. Every partition is a view over the same market
 * kernel; the installed panel links each item back into the library that owns
 * it so an install is never stranded in the discovery center.
 */
export function WorkshopDiscovery({
  initialKind,
  initialQuery,
  installed,
  counts,
  sources,
}: {
  initialKind: WorkshopAssetKind;
  initialQuery: string;
  installed: WorkshopInstalledItem[];
  counts: WorkshopLibraryCounts;
  sources: InstalledSourceView[];
}) {
  const t = useTranslations("workshopDiscovery");
  const router = useRouter();
  const [kind, setKind] = useState<WorkshopAssetKind>(initialKind);
  const [query, setQuery] = useState(initialQuery);
  const installedRepos = installed.map((item) => item.repo);
  const kindLabel = t(KIND_LABEL[kind]);

  function selectKind(next: WorkshopAssetKind) {
    setKind(next);
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams();
    if (next !== "pack") {
      params.set("kind", next);
    }
    const suffix = params.toString();
    window.history.replaceState(
      null,
      "",
      suffix ? `/workshop?${suffix}` : "/workshop",
    );
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href="/packs">
                <Package className="size-3.5" />
                {t("discoverPacks")}
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/sources">
                <Rss className="size-3.5" />
                {t("discoverSources")}
              </Link>
            </Button>
          </div>
        }
      />

      <WorkshopLibraryNav />

      <div
        role="tablist"
        aria-label={t("kindLabel")}
        className="flex flex-wrap items-center gap-1.5"
      >
        {WORKSHOP_ASSET_KINDS.map((id) => {
          const Icon = KIND_ICON[id];
          const active = id === kind;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectKind(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors",
                active
                  ? "border-emerald-500/40 bg-emerald-500/[0.06] text-zinc-100"
                  : "bg-zinc-900/60 hover:text-zinc-100",
              )}
            >
              <Icon className="size-3.5" />
              {t(KIND_LABEL[id])}
              <span className="font-mono text-[10px] text-zinc-600">
                {counts[id]}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-zinc-600">
        {t("filterHint", { kind: kindLabel })}
      </p>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="min-w-0">
          {kind === "source" ? (
            <div className="space-y-3">
              <p className="rounded-lg border border-border bg-card px-4 py-3 text-[11px] text-zinc-400">
                {t("sourceHint")}
              </p>
              <SourcesMarket
                installed={sources}
                onInstalled={() => router.push("/sources")}
              />
            </div>
          ) : (
            <WorkshopMarket
              key={kind}
              kind={kind}
              kindLabel={kindLabel}
              installedRepos={installedRepos}
              query={query}
              onQueryChange={setQuery}
            />
          )}
        </section>

        <section className="space-y-2 self-start rounded-xl border border-border bg-card p-3">
          <header className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
              <Store className="size-3.5 text-emerald-400" />
              {t("installedTitle")}
            </h2>
            <Badge variant="outline">{installed.length}</Badge>
          </header>
          {installed.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-[11px] text-zinc-500">
              {t("installedEmpty")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {installed.map((item) => (
                <li
                  key={item.key}
                  className="rounded-lg border border-border px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-200">
                      {item.name}
                    </span>
                    {item.version ? (
                      <Badge variant="outline">v{item.version}</Badge>
                    ) : null}
                    <Badge variant="outline">{t(KIND_LABEL[item.kind])}</Badge>
                  </div>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-zinc-600"
                    title={`${item.repo}@${item.commit}`}
                  >
                    {t("repoAtCommit", {
                      repo: item.repo,
                      commit: item.commit.slice(0, 8),
                    })}
                  </p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-zinc-600">
                      {t(LIBRARY_LABEL[item.library])}
                    </span>
                    <Link
                      href={item.href}
                      className="text-[10px] text-emerald-300 hover:underline"
                    >
                      {t("openLibrary")}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
