import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { getStore } from "@/lib/store";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}) {
  const store = await getStore();
  const paused = await store.runs.list({ status: "paused", limit: 100 });

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar pausedCount={paused.length} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-5 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
