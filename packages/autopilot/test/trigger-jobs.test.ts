import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAutopilotTick } from "../src/daemon";
import { getState, saveState } from "../src/state";

const config = `version: 1
enabled: true
timezone: UTC
schedules:
  - id: daily-radar
    workflow: daily-radar
    cron: "0 0 * * *"
    mode: DRY_RUN
    inputFile: evidence.json
`;

let root = "";
let store: Awaited<ReturnType<typeof initStore>>;
const previous = {
  home: process.env.KIT_HOME,
  mode: process.env.KIT_RUNTIME_MODE,
  blob: process.env.KIT_BLOB_ROOT,
  disabled: process.env.KIT_AUTOPILOT_DISABLED,
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kit-autopilot-jobs-"));
  const packDir = path.join(root, "packs", "tech-radar");
  await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
    recursive: true,
  });
  await writeFile(path.join(packDir, "autopilot.yaml"), config, "utf8");
  await writeFile(
    path.join(packDir, "evidence.json"),
    JSON.stringify({ summary: "scheduled evidence" }),
    "utf8",
  );
  setEnv("KIT_RUNTIME_MODE", "local");
  setEnv("KIT_HOME", path.join(root, ".kit"));
  setEnv("KIT_BLOB_ROOT", path.join(root, "blobs"));
  setEnv("KIT_AUTOPILOT_DISABLED", undefined);
  store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: path.join(root, ".kit"),
      KIT_BLOB_ROOT: path.join(root, "blobs"),
    }),
  );
});

afterAll(async () => {
  await store?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  setEnv("KIT_HOME", previous.home);
  setEnv("KIT_RUNTIME_MODE", previous.mode);
  setEnv("KIT_BLOB_ROOT", previous.blob);
  setEnv("KIT_AUTOPILOT_DISABLED", previous.disabled);
});

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

describe("autopilot trigger writes", () => {
  it("starts a scheduled pack run through @kit/job", async () => {
    await runAutopilotTick({
      repoRoot: root,
      now: new Date("2026-11-20T12:00:00.000Z"),
    });

    const state = await getState(store.autopilotState, "default", "tech-radar");
    expect(state).not.toBeNull();
    if (!state) {
      return;
    }
    state.nextRuns["daily-radar"] = "2026-11-19T00:00:00.000Z";
    expect(await saveState(store.autopilotState, state)).toBe(true);

    const result = await runAutopilotTick({
      repoRoot: root,
      now: new Date("2026-11-20T13:00:00.000Z"),
    });

    expect(result.errors).toEqual([]);
    expect(result.launched).toHaveLength(1);
    const launched = result.launched[0];
    expect(launched?.workflow).toBe("daily-radar");

    const request = await store.runRequests.find(launched?.runId ?? "");
    expect(request?.kind).toBe("pack_run");
    expect(request?.status).toBe("queued");

    const payload = JSON.parse(request?.payload ?? "{}") as {
      workflowId: string;
      runMode: string;
      initialInput: string;
      origin: unknown;
    };
    expect(payload.workflowId).toBe("daily-radar");
    expect(payload.runMode).toBe("DRY_RUN");
    expect(payload.initialInput).toContain("scheduled evidence");
    expect(payload.origin).toEqual({
      kind: "schedule",
      triggerId: "daily-radar",
    });
  }, 60_000);
});
