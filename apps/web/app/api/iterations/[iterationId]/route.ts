import {
  type EventRow,
  type RunRow,
  type TaskRow,
  type TurnRow,
  mapEvent,
  mapRun,
  mapTask,
  mapTurn,
} from "@/lib/iteration-mapping";
import type { IterationDetail } from "@/lib/iteration-types";
import { ensureStoreSchema, getStore } from "@/lib/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ iterationId: string }> },
) {
  await ensureStoreSchema();
  const { iterationId } = await context.params;
  const url = new URL(request.url);
  const eventLimit = clampInt(url.searchParams.get("events"), 1, 500, 200);
  const store = getStore();

  const runs = await store.sql<RunRow[]>`
    SELECT * FROM iteration_runs
    WHERE iteration_id = ${iterationId} AND workspace_id = 'default'
    LIMIT 1
  `;
  const runRow = runs[0];
  if (!runRow) {
    return NextResponse.json({ error: "iteration not found" }, { status: 404 });
  }

  const [tasks, turns, eventRows] = await Promise.all([
    store.sql<TaskRow[]>`
      SELECT * FROM iteration_tasks
      WHERE iteration_id = ${iterationId}
      ORDER BY started_at ASC
    `,
    store.sql<TurnRow[]>`
      SELECT * FROM iteration_turns
      WHERE iteration_id = ${iterationId}
      ORDER BY task_id ASC, turn ASC
    `,
    store.sql<EventRow[]>`
      SELECT * FROM iteration_events
      WHERE iteration_id = ${iterationId}
      ORDER BY event_id DESC
      LIMIT ${eventLimit + 1}
    `,
  ]);

  const hasMoreBefore = eventRows.length > eventLimit;
  const events = eventRows.slice(0, eventLimit).reverse().map(mapEvent);
  const runTasks = tasks.map(mapTask);
  const detail: IterationDetail = {
    run: mapRun(
      runRow,
      runTasks.reduce((sum, task) => sum + task.tokens, 0),
    ),
    tasks: runTasks,
    turns: turns.map(mapTurn),
    events,
    hasMoreBefore,
    lastEventId: events.at(-1)?.eventId ?? Number(runRow.last_event_id ?? 0),
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(detail);
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
