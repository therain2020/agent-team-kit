import path from "node:path";
import { newId } from "@kit/core";
import { initStore } from "@kit/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureState, getState, saveState } from "../src/state";

process.env.KIT_BLOB_BACKEND ??= "fs";
process.env.KIT_BLOB_ROOT = path.resolve(
  ".tmp/blobs-autopilot-test",
  String(Date.now()),
);

const enabled = process.env.KIT_INTEGRATION === "1";

describe.skipIf(!enabled)("autopilot state CAS", () => {
  let store: Awaited<ReturnType<typeof initStore>>;
  const packDir = `pack-${newId("test")}`;

  beforeAll(async () => {
    store = await initStore();
  });

  afterAll(async () => {
    if (store) {
      await store.sql`DELETE FROM autopilot_state WHERE pack_dir = ${packDir}`;
      await store.sql.end();
    }
  });

  it("rejects a stale version and accepts the current one", async () => {
    const state = await ensureState(store.sql, "default", packDir, true);
    const stale = { ...state };
    state.lastTickAt = new Date().toISOString();
    expect(await saveState(store.sql, state)).toBe(true);
    expect(await saveState(store.sql, stale)).toBe(false);

    const fresh = await getState(store.sql, "default", packDir);
    expect(fresh).not.toBeNull();
    if (!fresh) {
      return;
    }
    fresh.lastError = "updated";
    expect(await saveState(store.sql, fresh)).toBe(true);
  });
});
