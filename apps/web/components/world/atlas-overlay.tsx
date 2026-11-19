import { AtlasView } from "@/components/atlas/atlas-view";
import type { AtlasRun } from "@/lib/atlas";
import { X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { DrawerShell } from "./drawer-shell";

/**
 * Atlas overlay on `/world?tab=atlas` (issue #145, 99 §3). Atlas is not a
 * first-class route (issue #160): it opens full-width over the world list and
 * the URL owns state, so Escape, the backdrop and the close button all return
 * to `/world` — the same contract the run and activity drawers follow.
 */
export async function AtlasOverlay({
  data,
  closeHref,
}: {
  data: AtlasRun;
  closeHref: string;
}) {
  const t = await getTranslations("atlas");
  const common = await getTranslations("common");
  return (
    <DrawerShell
      closeHref={closeHref}
      label={t("title")}
      closeLabel={common("close")}
      size="full"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("eyebrow")}
          </p>
          <h2 className="text-sm font-semibold text-zinc-100">{t("title")}</h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">{t("description")}</p>
        </div>
        <Link
          href={closeHref}
          aria-label={common("close")}
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-accent hover:text-zinc-200"
        >
          <X className="size-4" />
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AtlasView data={data} />
      </div>
    </DrawerShell>
  );
}
