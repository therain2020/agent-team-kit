import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { loadPausedCount } from "@/lib/runs";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}) {
  const pausedCount = await loadPausedCount();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar pausedCount={pausedCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-5 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
