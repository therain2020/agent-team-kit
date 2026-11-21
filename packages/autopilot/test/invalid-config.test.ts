import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAutopilotTick } from "../src/daemon";

let root = "";
const previous = {
  home: process.env.KIT_HOME,
  mode: process.env.KIT_RUNTIME_MODE,
  blob: process.env.KIT_BLOB_ROOT,
  disabled: process.env.KIT_AUTOPILOT_DISABLED,
};

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kit-autopilot-invalid-"));
  const packDir = path.join(root, "packs", "tech-radar");
  await cp(path.join(process.cwd(), "packs", "tech-radar"), packDir, {
    recursive: true,
  });
  await writeFile(
    path.join(packDir, "autopilot.yaml"),
    `version: 1
enabled: true
schedule:
  - id: daily-radar
    workflow: daily-radar
    cron: "0 0 * * *"
`,
    "utf8",
  );
  process.env.KIT_RUNTIME_MODE = "local";
  process.env.KIT_HOME = path.join(root, ".kit");
  process.env.KIT_BLOB_ROOT = path.join(root, "blobs");
  Reflect.deleteProperty(process.env, "KIT_AUTOPILOT_DISABLED");
});

afterAll(async () => {
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

describe("autopilot config refusal", () => {
  it("refuses to schedule a pack whose autopilot.yaml is invalid", async () => {
    const result = await runAutopilotTick({
      repoRoot: root,
      now: new Date("2026-11-20T12:00:00.000Z"),
    });

    expect(result.packs).toBe(0);
    expect(result.launched).toEqual([]);
    expect(result.errors.join("\n")).toContain("unknown key(s): schedule");
    expect(result.errors.join("\n")).toContain("docs/triggers.md");
  }, 60_000);
});
