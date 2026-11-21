import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTriggerPlane, mapAutopilotConfig } from "../src/config";

const roots: string[] = [];
const envKeys = [
  "KIT_RUNTIME_MODE",
  "KIT_HOME",
  "KIT_BLOB_ROOT",
  "KIT_AUTOPILOT_DISABLED",
] as const;
const previous = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of envKeys) {
    previous.set(key, process.env[key]);
  }
});

afterEach(async () => {
  for (const key of envKeys) {
    const value = previous.get(key);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function setup(config: string) {
  const root = await mkdtemp(path.join(tmpdir(), "kit-trigger-config-"));
  roots.push(root);
  const packDir = path.join(root, "packs", "tech-radar");
  await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
    recursive: true,
  });
  await writeFile(path.join(packDir, "autopilot.yaml"), config, "utf8");
  process.env.KIT_RUNTIME_MODE = "local";
  process.env.KIT_HOME = path.join(root, ".kit");
  process.env.KIT_BLOB_ROOT = path.join(root, "blobs");
  Reflect.deleteProperty(process.env, "KIT_AUTOPILOT_DISABLED");
  return root;
}

const VALID = `version: 1
enabled: true
timezone: UTC
schedules:
  - id: daily-radar
    workflow: daily-radar
    cron: "0 0 * * *"
    mode: DRY_RUN
iterations:
  - id: self-improve
    cron: "0 1 * * *"
    goal: improve the radar
evolution:
  enabled: true
  cadence: daily
  evidenceFile: ../../.tmp/evidence.json
`;

describe("autopilot.yaml → Trigger/EventRoute mapping", () => {
  it("maps schedules, iterations and evolution into one semantic layer", async () => {
    const root = await setup(VALID);
    const plane = await loadTriggerPlane(root);

    expect(plane.errors).toEqual([]);
    expect(plane.packs).toHaveLength(1);
    expect(
      plane.triggers.map((item) => `${item.kind}:${item.triggerId}`).sort(),
    ).toEqual([
      "schedule:daily-radar",
      "schedule:self-improve",
      "schedule:tech-radar:evolution",
    ]);
    expect(plane.routes.map((item) => item.jobKind).sort()).toEqual([
      "evolution",
      "iteration",
      "packRun",
    ]);
    expect(
      plane.routes.find((item) => item.jobKind === "packRun"),
    ).toMatchObject({
      triggerRef: "daily-radar",
      workflow: "daily-radar",
      runMode: "DRY_RUN",
    });
  }, 30_000);

  it("keeps the mapping pure and readable for a single config", () => {
    const mapped = mapAutopilotConfig({
      packName: "tech-radar",
      dirName: "tech-radar",
      config: {
        version: 1,
        enabled: true,
        timezone: "UTC",
        schedules: [
          {
            id: "daily-radar",
            workflow: "daily-radar",
            cron: "0 0 * * *",
            mode: "DRY_RUN",
          },
        ],
        iterations: [],
      },
    });

    expect(mapped.errors).toEqual([]);
    expect(mapped.triggers[0]?.routeRef).toBe("tech-radar:daily-radar");
    expect(mapped.routes[0]?.routeId).toBe("tech-radar:daily-radar");
  });

  it("rejects an unknown legacy key with a migration hint", async () => {
    const root = await setup(`version: 1
enabled: true
schedule:
  - id: daily-radar
    workflow: daily-radar
    cron: "0 0 * * *"
`);
    const plane = await loadTriggerPlane(root);

    expect(plane.packs).toEqual([]);
    expect(plane.errors[0]).toContain("unknown key(s): schedule");
    expect(plane.errors[0]).toContain("docs/triggers.md");
  }, 30_000);

  it("rejects an invalid cron instead of silently dropping the trigger", async () => {
    const root = await setup(`version: 1
enabled: true
schedules:
  - id: broken
    workflow: daily-radar
    cron: "not a cron"
`);
    const plane = await loadTriggerPlane(root);

    expect(plane.packs).toEqual([]);
    expect(plane.errors.join("\n")).toContain("invalid 5-field cron");
  }, 30_000);
});
