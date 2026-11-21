import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coldStartTthwPath,
  markColdStartStarted,
  readColdStartTthwSync,
  recordColdStartMilestone,
} from "../src/tthw";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function home(): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-tthw-"));
  dirs.push(dir);
  return { KIT_HOME: dir };
}

describe("zero-config TTHW ledger", () => {
  it("keeps the first start and measures from it", async () => {
    const env = await home();
    const start = new Date("2026-11-20T10:00:00.000Z");
    await markColdStartStarted({ env, now: start, mode: "local" });
    await markColdStartStarted({
      env,
      now: new Date("2026-11-20T10:00:30.000Z"),
      mode: "local",
    });

    const profile = await recordColdStartMilestone("profile", {
      env,
      now: new Date("2026-11-20T10:02:00.000Z"),
      flow: "kit-bootstrap",
      modelLatencyMs: 30_000,
    });

    expect(profile.startedAt).toBe(start.toISOString());
    expect(profile.measure).toBe("profile");
    // 2 minutes elapsed minus 30s of model probe latency.
    expect(profile.tthwMinutes).toBe(1.5);
    expect(readColdStartTthwSync(env)?.tthwMinutes).toBe(1.5);
  });

  it("extends the measurement to the demo milestone", async () => {
    const env = await home();
    await markColdStartStarted({
      env,
      now: new Date("2026-11-20T10:00:00.000Z"),
    });
    await recordColdStartMilestone("profile", {
      env,
      now: new Date("2026-11-20T10:01:00.000Z"),
      flow: "kit-bootstrap",
      modelLatencyMs: 0,
    });
    const demo = await recordColdStartMilestone("demo", {
      env,
      now: new Date("2026-11-20T10:03:00.000Z"),
      flow: "kit-demo",
    });

    expect(demo.measure).toBe("demo");
    expect(demo.tthwMinutes).toBe(3);
    expect(demo.milestones.profile?.flow).toBe("kit-bootstrap");
  });

  it("keeps the first milestone when the command is retried", async () => {
    const env = await home();
    await markColdStartStarted({
      env,
      now: new Date("2026-11-20T10:00:00.000Z"),
    });
    await recordColdStartMilestone("profile", {
      env,
      now: new Date("2026-11-20T10:02:00.000Z"),
      flow: "kit-bootstrap",
      modelLatencyMs: 0,
    });
    const retried = await recordColdStartMilestone("profile", {
      env,
      now: new Date("2026-11-20T10:10:00.000Z"),
      flow: "kit-bootstrap",
      modelLatencyMs: 0,
    });

    expect(retried.milestones.profile?.at).toBe("2026-11-20T10:02:00.000Z");
    expect(retried.tthwMinutes).toBe(2);
  });

  it("never invents a duration without a start marker", async () => {
    const env = await home();
    const record = await recordColdStartMilestone("profile", {
      env,
      now: new Date("2026-11-20T10:00:00.000Z"),
      flow: "web-welcome",
    });

    expect(record.startedAt).toBeNull();
    expect(record.tthwMinutes).toBeNull();
    expect(record.measure).toBeNull();
  });

  it("reads malformed ledgers as absent", async () => {
    const env = await home();
    await writeFile(coldStartTthwPath(env), "{not json", "utf8");
    expect(readColdStartTthwSync(env)).toBeNull();
  });
});
