import { DegradationBanner } from "@/components/layout/degradation-banner";
import { KillSwitchBanner } from "@/components/layout/kill-switch-banner";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { loadActiveModes } from "@/lib/degradation";
import { loadPausedCount } from "@/lib/runs";
import { hasApiKey } from "@kit/bootstrap";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}) {
  let pausedCount = 0;
  let backendDown = false;

  try {
    pausedCount = await loadPausedCount();
  } catch (error) {
    console.error("console backend unreachable", error);
    backendDown = true;
  }

  let activeModes: Awaited<ReturnType<typeof loadActiveModes>> = [];
  try {
    activeModes = await loadActiveModes();
  } catch {
    // A degradation lookup failure is surfaced by the health pill instead.
  }

  let keyConfigured = true;
  try {
    keyConfigured = hasApiKey();
  } catch {
    // A keychain failure should not take the console down.
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar pausedCount={pausedCount} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <KillSwitchBanner />
        <DegradationBanner
          initialModes={activeModes.map((mode) => ({
            modeId: mode.modeId,
            scope: mode.scope,
            workspaceId: mode.workspaceId,
            kind: mode.kind,
            enteredAt: mode.enteredAt,
          }))}
        />
        {backendDown ? (
          <div
            role="alert"
            className="border-b border-amber-700/40 bg-amber-950/30 px-5 py-2 text-xs text-amber-200"
          >
            Backend unreachable — run{" "}
            <code className="rounded bg-amber-900/40 px-1">bun run kit up</code>
            . Packs and Studio still work. 后端不可达——请运行{" "}
            <code className="rounded bg-amber-900/40 px-1">bun run kit up</code>
            ，团队与 Studio 仍可使用。
          </div>
        ) : null}
        {!keyConfigured ? (
          <output className="block border-b border-sky-800/40 bg-sky-950/30 px-5 py-2 text-xs text-sky-200">
            No model key configured —{" "}
            <a className="underline" href="/welcome">
              open /welcome
            </a>{" "}
            to add one. 未配置模型密钥——前往{" "}
            <a className="underline" href="/welcome">
              /welcome
            </a>{" "}
            添加。
          </output>
        ) : null}
        <main className="flex-1 overflow-y-auto px-5 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
