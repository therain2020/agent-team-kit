"use client";

import { cn } from "@/lib/utils";
import {
  type WorkshopLibraryTab,
  activeLibraryTab,
} from "@/lib/workshop-library";
import { Compass, Package, Rss } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Switcher shared by the workshop discovery center and the two local
 * libraries (88 §3.4 M2, D-69). Every library links to discovery and every
 * discovery page links back, so an install can be found where it landed.
 */
const TABS: Array<{
  id: WorkshopLibraryTab;
  href: string;
  labelKey: string;
  icon: typeof Package;
}> = [
  { id: "discover", href: "/workshop", labelKey: "discover", icon: Compass },
  { id: "packs", href: "/packs", labelKey: "packs", icon: Package },
  { id: "sources", href: "/sources", labelKey: "sources", icon: Rss },
];

export function WorkshopLibraryNav() {
  const pathname = usePathname();
  const t = useTranslations("workshopLibrary");
  const active = activeLibraryTab(pathname);

  return (
    <nav
      aria-label={t("navLabel")}
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-zinc-900/60 p-0.5"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={active === tab.id ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[11px] text-zinc-400 transition-colors hover:text-zinc-100",
              active === tab.id && "bg-zinc-800 text-zinc-100",
            )}
          >
            <Icon className="size-3.5" />
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
