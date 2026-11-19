"use client";

import { PageHeader } from "@/components/kit/page-header";
import { NewPackWizard } from "@/components/packs/new-pack-wizard";
import { SourcesMarket } from "@/components/sources/sources-market";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssemblyColumn } from "@/components/workshop/assembly-column";
import { PackLibrary } from "@/components/workshop/pack-library";
import { SourceShelf } from "@/components/workshop/source-shelf";
import { WorkshopColumn } from "@/components/workshop/workshop-column";
import { WorkshopMarket } from "@/components/workshop/workshop-market";
import { cn } from "@/lib/utils";
import {
  type WorkshopSurfaceData,
  type WorkshopTab,
  linkedSourceView,
} from "@/lib/workshop-link";
import type { WorkshopInstallRecord } from "@kit/workshop";
import { GitBranch, Globe2, Package, Plus, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

const TABS: Array<{ id: WorkshopTab; icon: typeof Package; labelKey: string }> =
  [
    { id: "packs", icon: Package, labelKey: "tabPacks" },
    { id: "sources", icon: Globe2, labelKey: "tabSources" },
    { id: "assembly", icon: GitBranch, labelKey: "tabAssembly" },
  ];

export function WorkshopSurface({
  data,
  initialTab,
  initialPack,
  initialNewOpen = false,
  workshopInstalled,
}: {
  data: WorkshopSurfaceData;
  initialTab: WorkshopTab;
  initialPack?: string;
  initialNewOpen?: boolean;
  workshopInstalled: WorkshopInstallRecord[];
}) {
  const t = useTranslations("workshopSurface");
  const [tab, setTab] = useState<WorkshopTab>(initialTab);
  const [packDir, setPackDir] = useState<string | undefined>(initialPack);
  const [scope, setScope] = useState<"pack" | "all">("pack");
  const [marketOpen, setMarketOpen] = useState(false);
  const [sourceMarketOpen, setSourceMarketOpen] = useState(false);
  const [newPackOpen, setNewPackOpen] = useState(initialNewOpen);

  const selected = data.packs.find((pack) => pack.dirName === packDir) ?? null;
  const { visible, scoped } = linkedSourceView(selected, data.sources, scope);
  const installedSources = data.sources.filter((source) => !source.builtin);

  function syncUrl(nextTab: WorkshopTab, nextPack?: string) {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams();
    params.set("tab", nextTab);
    if (nextPack) {
      params.set("pack", nextPack);
    }
    window.history.replaceState(null, "", `/workshop?${params.toString()}`);
  }

  function selectTab(next: WorkshopTab) {
    setTab(next);
    syncUrl(next, packDir);
  }

  function selectPack(dirName: string) {
    setPackDir(dirName);
    setScope("pack");
    const narrow =
      typeof window !== "undefined" &&
      !window.matchMedia("(min-width: 1280px)").matches;
    const nextTab: WorkshopTab = tab === "packs" && narrow ? "sources" : tab;
    setTab(nextTab);
    syncUrl(nextTab, dirName);
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMarketOpen(true)}
            >
              <Store className="size-3.5" />
              {t("marketButton")}
            </Button>
            <Button size="sm" onClick={() => setNewPackOpen(true)}>
              <Plus className="size-3.5" />
              {t("newPack")}
            </Button>
          </div>
        }
      />

      <div className="flex items-center justify-between gap-2 xl:hidden">
        <div
          role="tablist"
          aria-label={t("title")}
          className="inline-flex items-center gap-0.5 rounded-md border border-border bg-zinc-900/60 p-0.5"
        >
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => selectTab(item.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors",
                  tab === item.id && "bg-zinc-800 text-zinc-100",
                )}
              >
                <Icon className="size-3.5" />
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
        <span className="truncate text-[10px] text-zinc-600">
          {t("selectionHint")}
        </span>
      </div>

      <div className="grid gap-3 xl:h-[calc(100vh-13rem)] xl:min-h-[28rem] xl:grid-cols-[minmax(0,0.95fr)_minmax(0,0.95fr)_minmax(0,1.15fr)]">
        <WorkshopColumn
          title={t("packColumn")}
          hint={t("packColumnHint")}
          icon={Package}
          badge={String(data.packs.length)}
          active={tab === "packs"}
        >
          <PackLibrary
            packs={data.packs}
            selectedDir={selected?.dirName}
            onSelect={selectPack}
            onNewPack={() => setNewPackOpen(true)}
          />
        </WorkshopColumn>

        <WorkshopColumn
          title={t("sourceColumn")}
          hint={t("sourceColumnHint")}
          icon={Globe2}
          badge={String(visible.length)}
          active={tab === "sources"}
        >
          <SourceShelf
            sources={visible}
            pack={selected}
            scope={scope}
            scoped={scoped}
            onScopeChange={setScope}
            onManage={() => setSourceMarketOpen(true)}
          />
        </WorkshopColumn>

        <WorkshopColumn
          title={t("assemblyColumn")}
          hint={t("assemblyColumnHint")}
          icon={GitBranch}
          badge={selected?.dirName}
          active={tab === "assembly"}
        >
          <AssemblyColumn pack={selected} />
        </WorkshopColumn>
      </div>

      <Dialog open={marketOpen} onOpenChange={setMarketOpen}>
        <DialogContent className="max-h-[86vh] w-[min(72rem,94vw)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("marketTitle")}</DialogTitle>
            <DialogDescription>{t("marketDesc")}</DialogDescription>
          </DialogHeader>
          <WorkshopMarket installed={workshopInstalled} />
        </DialogContent>
      </Dialog>

      <Dialog open={sourceMarketOpen} onOpenChange={setSourceMarketOpen}>
        <DialogContent className="max-h-[86vh] w-[min(72rem,94vw)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("sourceColumn")}</DialogTitle>
            <DialogDescription>{t("sourceColumnHint")}</DialogDescription>
          </DialogHeader>
          <SourcesMarket installed={installedSources} />
        </DialogContent>
      </Dialog>

      <Dialog open={newPackOpen} onOpenChange={setNewPackOpen}>
        <DialogContent className="max-h-[88vh] w-[min(60rem,94vw)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("newPack")}</DialogTitle>
            <DialogDescription>{t("newPackDescription")}</DialogDescription>
          </DialogHeader>
          <NewPackWizard />
        </DialogContent>
      </Dialog>
    </div>
  );
}
