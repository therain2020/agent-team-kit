import { type AgentState, type RunProjection, getRunProjection } from "@kit/store";
import {
  type RunRow,
  type TaskRow,
  mapRun,
  mapTask,
} from "./iteration-mapping";
import type { IterationRunView, IterationTaskView } from "./iteration-types";
import {
  type ArtifactView,
  type DiffPart,
  type RunDetail,
  buildArtifactDiff,
  loadArtifactContent,
  loadRunDetail,
  pickRunArtifact,
} from "./runs";
import { getStore } from "./store";
import {
  ensureWorldProjectionBackfill,
  loadWorldRunMetas,
  loadWorldSnapshot,
} from "./world";
import type { WorldRunMetaMap, WorldRunView } from "./world-view";

export interface WorldPageData {
  runs: WorldRunView[];
  agents: AgentState[];
  seq: number;
  computedAt: string;
  metas: WorldRunMetaMap;
}

/**
 * First-screen load for `/world`: the constant-cost snapshot (agent cursor +
 * run projections) plus one UNION for kind/start metadata. Three statements in
 * total, independent of run count (87 §4.4, issue #161 acceptance).
 */
export async function loadWorldPageData(
  workspaceId = "default",
): Promise<WorldPageData> {
  await ensureWorldProjectionBackfill();
  const store = getStore();
  const [snapshot, metas] = await Promise.all([
    loadWorldSnapshot(store, { workspaceId }),
    loadWorldRunMetas(store, workspaceId),
  ]);

  const metaMap: WorldRunMetaMap = {};
  for (const meta of metas) {
    metaMap[meta.runId] = {
      kind: meta.kind,
      startedAt: meta.startedAt,
    };
  }

  return {
    runs: snapshot.snapshot.runs,
    agents: snapshot.snapshot.agents,
    seq: snapshot.seq,
    computedAt: snapshot.snapshot.computedAt,
    metas: metaMap,
  };
}

export interface ArtifactContent {
  text: string;
  truncated: boolean;
  unavailable: boolean;
}

export interface WorldRunDrawer {
  kind: "run";
  runId: string;
  projection: RunProjection | null;
  detail: RunDetail;
  selected: {
    view: ArtifactView;
    content: ArtifactContent;
    diff: DiffPart[] | null;
  } | null;
}

export interface WorldIterationDrawer {
  kind: "iteration";
  runId: string;
  projection: RunProjection | null;
  run: IterationRunView;
  tasks: IterationTaskView[];
}

export interface WorldMissingDrawer {
  kind: "missing";
  runId: string;
}

export type WorldDrawerData =
  | WorldRunDrawer
  | WorldIterationDrawer
  | WorldMissingDrawer;

/**
 * Drill-down payload for the right drawer. Only called when `?run=` is set, so
 * the heavier per-run reads never touch the first paint.
 */
export async function loadWorldDrawerData(
  runId: string,
  artifactQuery?: string,
): Promise<WorldDrawerData> {
  const store = getStore();
  const iterationRows = await store.sql<RunRow[]>`
    SELECT * FROM iteration_runs
    WHERE iteration_id = ${runId} AND workspace_id = 'default'
    LIMIT 1
  `;
  const iterationRow = iterationRows[0];
  if (iterationRow) {
    const [tasks, projection] = await Promise.all([
      store.sql<TaskRow[]>`
        SELECT * FROM iteration_tasks
        WHERE iteration_id = ${runId}
        ORDER BY started_at ASC
      `,
      getRunProjection(store.sql, runId),
    ]);
    const run = mapRun(
      iterationRow,
      tasks.reduce((sum, task) => sum + Number(task.tokens ?? 0), 0),
    );
    return {
      kind: "iteration",
      runId,
      projection,
      run,
      tasks: tasks.map(mapTask),
    };
  }

  const [detail, projection] = await Promise.all([
    loadRunDetail(runId, store),
    getRunProjection(store.sql, runId),
  ]);
  if (!detail) {
    return { kind: "missing", runId };
  }

  const selectedView = pickRunArtifact(detail, artifactQuery);
  if (!selectedView) {
    return { kind: "run", runId, projection, detail, selected: null };
  }
  const [content, diff] = await Promise.all([
    loadArtifactContent(selectedView.artifact, store),
    buildArtifactDiff(selectedView, detail.artifacts, store),
  ]);
  return {
    kind: "run",
    runId,
    projection,
    detail,
    selected: { view: selectedView, content, diff },
  };
}
