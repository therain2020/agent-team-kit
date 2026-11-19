import path from "node:path";
import { newId } from "@kit/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initStore, pruneEventRetention } from "../src/index";

process.env.KIT_BLOB_BACKEND ??= "fs";
process.env.KIT_BLOB_ROOT = path.resolve(".tmp/blobs-test", String(Date.now()));

const enabled = process.env.KIT_INTEGRATION === "1";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-19T00:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - 90 * DAY_MS).toISOString();
const OLD = new Date(NOW.getTime() - 91 * DAY_MS).toISOString();
const FRESH = new Date(NOW.getTime() - 89 * DAY_MS).toISOString();

describe.skipIf(!enabled)("event retention (postgres)", () => {
  let store: Awaited<ReturnType<typeof initStore>>;

  beforeAll(async () => {
    store = await initStore();
  });

  afterAll(async () => {
    await store?.close();
  });

  async function insertActivity(kind: string, at: string): Promise<void> {
    await store.sql`
      INSERT INTO activity_events (workspace_id, kind, payload, created_at)
      VALUES (${"default"}, ${kind}, ${store.sql.json({})}, ${at})
    `;
  }

  async function countActivity(kind: string): Promise<number> {
    const [row] = await store.sql<Array<{ total: number | string }>>`
      SELECT COUNT(*) AS total FROM activity_events WHERE kind = ${kind}
    `;
    return Number(row?.total ?? 0);
  }

  async function countIteration(
    iterationId: string,
    kind: string,
  ): Promise<number> {
    const [row] = await store.sql<Array<{ total: number | string }>>`
      SELECT COUNT(*) AS total FROM iteration_events
      WHERE iteration_id = ${iterationId} AND kind = ${kind}
    `;
    return Number(row?.total ?? 0);
  }

  it("dry-run reports, prune deletes only expired rows", async () => {
    const marker = `retention.${newId("evt")}`;
    const iterationId = newId("it");

    await insertActivity(`${marker}.old`, OLD);
    await insertActivity(`${marker}.fresh`, FRESH);
    await store.sql`
      INSERT INTO iteration_runs (
        iteration_id, workflow_id, workspace_id, goal, run_mode, apply_mode,
        status, phase, started_at, updated_at
      ) VALUES (
        ${iterationId}, ${"retention"}, ${"default"}, ${"prune old events"},
        ${"DRY_RUN"}, ${"none"}, ${"running"}, ${"planned"}, ${OLD}, ${OLD}
      )
    `;
    await store.sql`
      INSERT INTO iteration_events (iteration_id, kind, payload, created_at)
      VALUES (${iterationId}, ${`${marker}.old`}, ${store.sql.json({})}, ${OLD})
    `;
    await store.sql`
      INSERT INTO iteration_events (iteration_id, kind, payload, created_at)
      VALUES (${iterationId}, ${`${marker}.fresh`}, ${store.sql.json({})}, ${FRESH})
    `;

    const dry = await pruneEventRetention(store, { now: NOW, dryRun: true });
    expect(dry.cutoff).toBe(CUTOFF);
    expect(dry.deleted).toBe(0);
    expect(dry.eligible).toBeGreaterThanOrEqual(2);
    expect(await countActivity(`${marker}.old`)).toBe(1);
    expect(await countIteration(iterationId, `${marker}.old`)).toBe(1);

    const pruned = await pruneEventRetention(store, { now: NOW });
    expect(pruned.deleted).toBeGreaterThanOrEqual(2);
    expect(await countActivity(`${marker}.old`)).toBe(0);
    expect(await countActivity(`${marker}.fresh`)).toBe(1);
    expect(await countIteration(iterationId, `${marker}.old`)).toBe(0);
    expect(await countIteration(iterationId, `${marker}.fresh`)).toBe(1);

    const again = await pruneEventRetention(store, { now: NOW });
    expect(again.deleted).toBe(0);
    expect(again.eligible).toBe(0);
  });
});
