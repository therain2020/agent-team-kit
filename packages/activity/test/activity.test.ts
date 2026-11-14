import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { appendActivity, listActivity } from "../src/index";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function sqliteStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-activity-"));
  dirs.push(dir);
  const config = loadStoreConfig({
    KIT_RUNTIME_MODE: "local",
    KIT_HOME: dir,
    KIT_BLOB_ROOT: path.join(dir, "blobs"),
  });
  const store = await initStore(config);
  closers.push(() => store.close());
  return store;
}

describe("activity events", () => {
  it("appends, filters and paginates events", async () => {
    const store = await sqliteStore();
    const first = await appendActivity(store, {
      runId: "run_1",
      stageId: "run_1:collect",
      agentId: "researcher",
      kind: "stage.started",
      status: "running",
      summary: "collect",
    });
    await appendActivity(store, {
      runId: "run_1",
      stageId: "run_1:collect",
      agentId: "researcher",
      kind: "tool.call",
      status: "running",
      tool: "repo_read",
      summary: "repo_read",
      payload: { path: "README.md" },
    });
    await appendActivity(store, {
      runId: "run_2",
      agentId: "writer",
      kind: "manager.exchange",
      status: "completed",
      summary: "how did it go?",
    });

    const byRun = await listActivity(store, { runId: "run_1" });
    expect(byRun).toHaveLength(2);
    expect(byRun[0]?.eventId).toBe(first);

    const byAgent = await listActivity(store, { agentId: "writer" });
    expect(byAgent).toHaveLength(1);
    expect(byAgent[0]?.kind).toBe("manager.exchange");

    const byKind = await listActivity(store, { kind: "tool.call" });
    expect(byKind).toHaveLength(1);
    expect(byKind[0]?.tool).toBe("repo_read");

    const after = await listActivity(store, {
      runId: "run_1",
      after: first,
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.kind).toBe("tool.call");
  });

  it("redacts secret-like payload keys", async () => {
    const store = await sqliteStore();
    await appendActivity(store, {
      runId: "run_3",
      kind: "tool.call",
      payload: {
        apiKey: "sk-secret-value",
        tokens: 12,
        nested: { authorization: "Bearer abc", safe: "ok" },
      },
    });
    const events = await listActivity(store, { runId: "run_3" });
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload.apiKey).toBe("[redacted]");
    expect(payload.tokens).toBe(12);
    expect((payload.nested as Record<string, unknown>).authorization).toBe(
      "[redacted]",
    );
    expect((payload.nested as Record<string, unknown>).safe).toBe("ok");
  });
});
