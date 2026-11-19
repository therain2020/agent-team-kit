import { ActivityDrawer } from "@/components/world/activity-drawer";
import { AtlasOverlay } from "@/components/world/atlas-overlay";
import { WorldConsole } from "@/components/world/world-console";
import {
  WorldDrawer,
  type WorldDrawerTab,
} from "@/components/world/world-drawer";
import { loadAtlasRun } from "@/lib/atlas";
import { loadWorldDrawerData, loadWorldPageData } from "@/lib/world-page";
import { type WorldKindFilter, parseWorldSearchParams } from "@/lib/world-view";

export const dynamic = "force-dynamic";

interface WorldSearchParams {
  run?: string | string[];
  tab?: string | string[];
  artifact?: string | string[];
}

/**
 * `/world` — one surface for Command Center + Runs + Iterations + Activity
 * (issue #161). The server renders the snapshot and, when `?run=` is present,
 * the drill-down drawer; the client console then keeps the list live from
 * `/api/world/stream`.
 *
 * `?tab=atlas` opens the Atlas overlay (issue #145) on top of the same list —
 * Atlas is a `/world` drill-down, not a first-class entry (issue #160).
 */
export default async function WorldPage({
  searchParams,
}: {
  searchParams: Promise<WorldSearchParams>;
}) {
  const {
    tab: tabParam,
    runId: runParam,
    artifactKey: artifactParam,
  } = parseWorldSearchParams(await searchParams);

  const initialKind: WorldKindFilter =
    tabParam === "runs"
      ? "run"
      : tabParam === "iterations"
        ? "iteration"
        : "all";
  const closeHref =
    tabParam === "runs"
      ? "/world?tab=runs"
      : tabParam === "iterations"
        ? "/world?tab=iterations"
        : "/world";

  const data = await loadWorldPageData();

  const consolePanel = (
    <WorldConsole
      initialRuns={data.runs}
      initialAgents={data.agents}
      computedAt={data.computedAt}
      metas={data.metas}
      initialKind={initialKind}
      activeRunId={runParam || null}
    />
  );

  if (tabParam === "atlas") {
    const atlas = await loadAtlasRun({
      ...(runParam ? { runId: runParam } : {}),
      ...(artifactParam ? { artifactKey: artifactParam } : {}),
    });
    return (
      <>
        {consolePanel}
        <AtlasOverlay data={atlas} closeHref={closeHref} />
      </>
    );
  }

  if (!runParam) {
    return (
      <>
        {consolePanel}
        {tabParam === "activity" ? (
          <ActivityDrawer closeHref={closeHref} />
        ) : null}
      </>
    );
  }

  const drawer = await loadWorldDrawerData(runParam, artifactParam);
  const drawerTab: WorldDrawerTab =
    tabParam === "activity" || tabParam === "artifacts" ? tabParam : "timeline";

  return (
    <>
      {consolePanel}
      <WorldDrawer data={drawer} tab={drawerTab} closeHref={closeHref} />
    </>
  );
}
