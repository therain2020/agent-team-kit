"use client";

import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Boxes } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function Sidebar({ pausedCount = 0 }: { pausedCount?: number }) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  return (
    <aside className="hidden h-full min-h-0 w-56 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar md:flex">
      <div className="flex h-14 items-center border-b border-sidebar-border px-4">
        <Link href="/" className="flex items-center gap-2">
          <Boxes className="size-4 text-emerald-400" />
          <span className="font-mono text-xs font-medium tracking-tight text-zinc-200">
            agent-team-kit
          </span>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] text-zinc-400 transition-colors hover:bg-sidebar-accent hover:text-zinc-100",
                active && "bg-sidebar-accent text-zinc-100",
              )}
            >
              <Icon className="size-4" />
              <span className="flex-1">{t(item.labelKey)}</span>
              {item.badge && pausedCount > 0 ? (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                  {pausedCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border px-3 py-2">
        <p className="text-[10px] uppercase tracking-widest text-zinc-600">
          {t("localWorkspace")}
        </p>
        <p className="mt-1 font-mono text-[11px] text-zinc-500">
          {t("defaultLine")}
        </p>
      </div>
    </aside>
  );
}
