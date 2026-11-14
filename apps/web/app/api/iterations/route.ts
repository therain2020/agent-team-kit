import {
  type RunRow,
  type TaskRow,
  type TurnRow,
  mapRun,
  mapTask,
  mapTurn,
} from "@/lib/iteration-mapping";
import type { IterationData } from "@/lib/iteration-types";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureStoreSchema();
  const store = getStore();
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);
  const offset = clampInt(url.searchParams.get("offset"), 0, 100_000, 0);
  const status = url.searchParams.get("status") || null;
  const domain = url.searchParams.get("domain") || null;
  const query = url.searchParams.get("q")?.trim() || null;
  const pattern = query ? `%${query}%` : null;

  const runs = await store.sql<RunRow[]>`
    SELECT r.* FROM iteration_runs r
    WHERE r.workspace_id = 'default'
      AND (${status}::text IS NULL OR r.status = ${status})
      AND (
        ${domain}::text IS NULL OR EXISTS (
          SELECT 1 FROM iteration_tasks t
          WHERE t.iteration_id = r.iteration_id AND t.domain = ${domain}
        )
      )
      AND (
        ${pattern}::text IS NULL
        OR r.goal ILIKE ${pattern}
        OR r.iteration_id ILIKE ${pattern}
      )
    ORDER BY r.updated_at DESC
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `;
  const hasMore = runs.length > limit;
  const pageRuns = runs.slice(0, limit);
  const ids = pageRuns.map((row) => row.iteration_id);

  const tasks = ids.length
    ? await store.sql<TaskRow[]>`
        SELECT * FROM iteration_tasks
        WHERE iteration_id = ANY(${store.sql.array(ids)})
        ORDER BY started_at ASC
      `
    : [];
  const turns = ids.length
    ? await store.sql<TurnRow[]>`
        SELECT * FROM iteration_turns
        WHERE iteration_id = ANY(${store.sql.array(ids)})
        ORDER BY iteration_id ASC, task_id ASC, turn ASC
      `
    : [];

  const tasksByRun = new Map<string, TaskRow[]>();
  for (const row of tasks) {
    const list = tasksByRun.get(row.iteration_id) ?? [];
    list.push(row);
    tasksByRun.set(row.iteration_id, list);
  }
  const turnsByRun = new Map<string, TurnRow[]>();
  for (const row of turns) {
    const list = turnsByRun.get(row.iteration_id) ?? [];
    list.push(row);
    turnsByRun.set(row.iteration_id, list);
  }

  const data: IterationData = {
    runs: pageRuns.map((row) => {
      const runTasks = tasksByRun.get(row.iteration_id) ?? [];
      return {
        run: mapRun(
          row,
          runTasks.reduce((sum, task) => sum + Number(task.tokens ?? 0), 0),
        ),
        tasks: runTasks.map(mapTask),
        turns: (turnsByRun.get(row.iteration_id) ?? []).map(mapTurn),
      };
    }),
    generatedAt: new Date().toISOString(),
    hasMore,
  };
  return NextResponse.json(data);
}

function clampInt(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
