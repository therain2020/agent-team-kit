import { ActivityFeed } from "@/components/activity/activity-feed";
import { X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { DrawerShell } from "./drawer-shell";

/**
 * Global activity stream drawer. Activity no longer owns a page (issue #161);
 * it opens beside the world list and keeps streaming from
 * `/api/activity/stream`.
 */
export async function ActivityDrawer({ closeHref }: { closeHref: string }) {
  const t = await getTranslations("world");
  const common = await getTranslations("common");
  return (
    <DrawerShell
      closeHref={closeHref}
      label={t("activityDrawerTitle")}
      closeLabel={common("close")}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">
            {t("title")}
          </p>
          <h2 className="text-sm font-semibold text-zinc-100">
            {t("activityDrawerTitle")}
          </h2>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {t("activityDrawerHint")}
          </p>
        </div>
        <Link
          href={closeHref}
          aria-label={common("close")}
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-accent hover:text-zinc-200"
        >
          <X className="size-4" />
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <ActivityFeed maxHeight="calc(100vh - 14rem)" />
      </div>
    </DrawerShell>
  );
}
