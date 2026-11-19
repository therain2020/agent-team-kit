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
      <div className="flex h-14 items-center border-b border-sidebar-border px-3">
        <Link
          href="/"
          className="flex items-center gap-2.5 border border-transparent px-1 py-1 hover:border-px-line hover:bg-px-panel2"
        >
          <span className="flex size-7 items-center justify-center border border-px-accent-hi bg-px-accent text-px-accent-ink shadow-px-sm">
            <Boxes className="size-4" />
          </span>
          <span className="font-mono text-[11px] leading-tight font-bold tracking-[0.14em] text-px-text uppercase">
            agent-team-kit
          </span>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-none border border-transparent px-2.5 py-1.5 font-mono text-[12px] text-px-muted transition-colors hover:border-px-line hover:bg-px-panel2 hover:text-px-text",
                active &&
                  "border-px-line2 bg-px-panel3 text-px-strong shadow-[inset_2px_0_0_var(--px-accent)]",
              )}
            >
              <Icon className={cn("size-4", active ? "text-px-accent" : "")} />
              <span className="flex-1">{t(item.labelKey)}</span>
              {item.badge && pausedCount > 0 ? (
                <span className="border border-amber-700 bg-amber-900/40 px-1 py-0.5 font-mono text-[10px] leading-none font-bold text-amber-300">
                  {pausedCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border px-3 py-2">
        <p className="font-mono text-[10px] tracking-[0.14em] text-px-muted uppercase">
          {t("localWorkspace")}
        </p>
        <p className="mt-1 font-mono text-[10.5px] text-px-faint">
          {t("defaultLine")}
        </p>
      </div>
    </aside>
  );
}
