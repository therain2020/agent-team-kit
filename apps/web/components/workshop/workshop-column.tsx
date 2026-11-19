"use client";

import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function WorkshopColumn({
  title,
  hint,
  icon: Icon,
  badge,
  active,
  children,
}: {
  title: string;
  hint: string;
  icon: LucideIcon;
  badge?: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "min-h-0 flex-col overflow-hidden rounded-xl border bg-card/60",
        active ? "flex border-emerald-500/25" : "hidden border-border xl:flex",
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-zinc-500" />
          <h2 className="shrink-0 text-xs font-medium text-zinc-200">
            {title}
          </h2>
          <span className="truncate text-[10px] text-zinc-600">{hint}</span>
        </div>
        {badge ? (
          <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
            {badge}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}
