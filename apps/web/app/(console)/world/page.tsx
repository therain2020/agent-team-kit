import { ActivityDrawer } from "@/components/world/activity-drawer";
import { WorldConsole } from "@/components/world/world-console";
import {
  WorldDrawer,
  type WorldDrawerTab,
} from "@/components/world/world-drawer";
import { loadWorldDrawerData, loadWorldPageData } from "@/lib/world-page";
import type { WorldKindFilter } from "@/lib/world-view";

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
 */
export default async function WorldPage({
  searchParams,
}: {
  searchParams: Promise<WorldSearchParams>;
}) {
  const params = await searchParams;
  const runParam = firstValue(params.run)?.trim() ?? "";
  const tabParam = firstValue(params.tab) ?? "";
  const artifactParam = firstValue(params.artifact);

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

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
