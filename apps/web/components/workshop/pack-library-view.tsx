"use client";

import { PageHeader } from "@/components/kit/page-header";
import { NewPackWizard } from "@/components/packs/new-pack-wizard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssemblyColumn } from "@/components/workshop/assembly-column";
import { LegacyImportBanner } from "@/components/workshop/legacy-import-banner";
import { WorkshopLibraryNav } from "@/components/workshop/library-nav";
import { PackLibrary } from "@/components/workshop/pack-library";
import { DISCOVERY_HREF } from "@/lib/workshop-library";
import { type WorkshopPackView, pickSelectedPack } from "@/lib/workshop-link";
import type { WorkshopInstallRecord } from "@kit/workshop";
import { Plus, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

/**
 * Local pack library surface (`/packs`, 88 §3.4 M2). The card list shows the
 * workshop origin recorded in `.workshop.json`; assembly and Studio live one
 * click away. Publishing stays in Studio (the only publish entry).
 */
export function PackLibraryView({
  packs,
  initialPack,
  initialNewOpen,
  legacyPacks,
}: {
  packs: WorkshopPackView[];
  initialPack?: string;
  initialNewOpen: boolean;
  legacyPacks: WorkshopInstallRecord[];
}) {
  const t = useTranslations("packsLibrary");
  const [packDir, setPackDir] = useState<string | undefined>(initialPack);
  const [newPackOpen, setNewPackOpen] = useState(initialNewOpen);
  const selected = pickSelectedPack(packs, packDir);

  function selectPack(dirName: string) {
    setPackDir(dirName);
    if (typeof window === "undefined") {
      return;
    }
    window.history.replaceState(
      null,
      "",
      `/packs?pack=${encodeURIComponent(dirName)}`,
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
              <Link href={DISCOVERY_HREF.pack}>
                <Store className="size-3.5" />
                {t("discover")}
              </Link>
            </Button>
            <Button size="sm" onClick={() => setNewPackOpen(true)}>
              <Plus className="size-3.5" />
              {t("newPack")}
            </Button>
          </div>
        }
      />

      <WorkshopLibraryNav />

      <LegacyImportBanner records={legacyPacks} />

      <div className="grid gap-3 xl:h-[calc(100vh-15rem)] xl:min-h-[28rem] xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/60">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Store className="size-3.5 shrink-0 text-zinc-500" />
              <h2 className="shrink-0 text-xs font-medium text-zinc-200">
                {t("libraryLabel")}
              </h2>
              <span className="truncate text-[10px] text-zinc-600">
                {t("libraryHint")}
              </span>
            </div>
            <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
              {packs.length}
            </span>
          </header>
          <PackLibrary
            packs={packs}
            selectedDir={selected?.dirName}
            onSelect={selectPack}
            onNewPack={() => setNewPackOpen(true)}
          />
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/60">
          <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="shrink-0 text-xs font-medium text-zinc-200">
                {t("assemblyLabel")}
              </h2>
              <span className="truncate text-[10px] text-zinc-600">
                {t("assemblyHint")}
              </span>
            </div>
          </header>
          <AssemblyColumn pack={selected} />
        </section>
      </div>

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
