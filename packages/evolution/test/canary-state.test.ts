import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CANARY_THRESHOLDS,
  type EvolutionDecisionRecord,
  evaluateCanary,
  markCanaryPromoted,
  rollbackCanary,
  setCanaryTraffic,
  startCanary,
} from "../src/canary";
import { initVariant, proposeVariant } from "../src/evolve";
import { createEvalSnapshot } from "../src/snapshot";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "kit-canary-state-"));
  roots.push(root);
  const baselineDir = path.join(root, "baseline");
  const canaryDir = path.join(root, "candidate");
  const instructions = path.join(root, "writer.md");
  const evidence = path.join(root, "evidence.json");
  const statePath = path.join(root, "state.json");
  const decisionsPath = path.join(root, "decisions.jsonl");
  const archive = path.join(root, "archive.jsonl");

  await writeFile(instructions, "Write with citations.", "utf8");
  await writeFile(
    evidence,
    JSON.stringify({ sources: [{ citationId: "S1" }], errors: [] }),
    "utf8",
  );
  await initVariant(
    path.join(process.cwd(), "packs", "tech-radar"),
    baselineDir,
    "baseline",
  );
  await proposeVariant(
    baselineDir,
    "writer",
    instructions,
    canaryDir,
    "candidate",
  );

  return {
    baselineDir,
    canaryDir,
    evidence,
    statePath,
    decisionsPath,
    archive,
  };
}

async function readDecisions(file: string): Promise<EvolutionDecisionRecord[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvolutionDecisionRecord);
}

describe("canary state machine", () => {
  it("starts in shadow and records the transition", async () => {
    const { baselineDir, canaryDir, statePath, decisionsPath } = await setup();

    const state = await startCanary(baselineDir, canaryDir, {
      statePath,
      decisionsPath,
    });
    expect(state.workspaceId).toBe("default");
    expect(state.canary?.status).toBe("shadow");
    expect(state.canary?.trafficPercent).toBe(0);

    const decisions = await readDecisions(decisionsPath);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: "canary_start",
      fromStatus: null,
      toStatus: "shadow",
      toTrafficPercent: 0,
      trigger: "manual",
      actor: "operator",
    });
  }, 30_000);

  it("ramps traffic and returns to shadow", async () => {
    const { baselineDir, canaryDir, statePath, decisionsPath } = await setup();
    await startCanary(baselineDir, canaryDir, { statePath, decisionsPath });

    const ramped = await setCanaryTraffic(25, { statePath, decisionsPath });
    expect(ramped.canary?.status).toBe("canary");
    expect(ramped.canary?.trafficPercent).toBe(25);

    const shadow = await setCanaryTraffic(0, { statePath, decisionsPath });
    expect(shadow.canary?.status).toBe("shadow");
    expect(shadow.canary?.trafficPercent).toBe(0);

    const kinds = (await readDecisions(decisionsPath)).map(
      (decision) => decision.kind,
    );
    expect(kinds).toEqual(["canary_start", "traffic_change", "traffic_change"]);
  }, 30_000);

  it("rolls back on an incident and records the trigger", async () => {
    const {
      baselineDir,
      canaryDir,
      evidence,
      statePath,
      decisionsPath,
      archive,
    } = await setup();
    await startCanary(baselineDir, canaryDir, {
      trafficPercent: 20,
      statePath,
      decisionsPath,
    });

    const result = await evaluateCanary([evidence], {
      stub: true,
      archive,
      statePath,
      decisionsPath,
      incident: "upstream outage",
    });

    expect(result.decision.trigger).toBe("incident");
    expect(result.state.canary?.status).toBe("rolled_back");
    expect(result.state.canary?.trafficPercent).toBe(0);
    expect(result.state.canary?.reason).toBe("incident: upstream outage");

    const decisions = await readDecisions(decisionsPath);
    const rollback = decisions.at(-1);
    expect(rollback).toMatchObject({
      kind: "rollback",
      fromStatus: "canary",
      toStatus: "rolled_back",
      fromTrafficPercent: 20,
      toTrafficPercent: 0,
      trigger: "incident",
      actor: "auto",
    });
  }, 30_000);

  it("records manual rollbacks with their trigger", async () => {
    const { baselineDir, canaryDir, statePath, decisionsPath } = await setup();
    await startCanary(baselineDir, canaryDir, {
      trafficPercent: 10,
      statePath,
      decisionsPath,
    });

    const state = await rollbackCanary("operator stopped the rollout", {
      statePath,
      decisionsPath,
      trigger: "incident",
    });
    expect(state.canary?.status).toBe("rolled_back");

    const rollback = (await readDecisions(decisionsPath)).at(-1);
    expect(rollback).toMatchObject({
      kind: "rollback",
      trigger: "incident",
      reason: "operator stopped the rollout",
      actor: "operator",
    });
  }, 30_000);

  it("records an evaluate decision with scores and thresholds", async () => {
    const {
      baselineDir,
      canaryDir,
      evidence,
      statePath,
      decisionsPath,
      archive,
    } = await setup();
    await startCanary(baselineDir, canaryDir, {
      trafficPercent: 10,
      statePath,
      decisionsPath,
    });

    const result = await evaluateCanary([evidence], {
      stub: true,
      archive,
      statePath,
      decisionsPath,
    });

    expect(result.decision.rollback).toBe(false);
    expect(result.summary.thresholds).toEqual(DEFAULT_CANARY_THRESHOLDS);
    expect(result.summary.champion.averageScore).toBe(1);
    expect(result.summary.candidate.averageScore).toBe(1);

    const evaluate = (await readDecisions(decisionsPath)).at(-1);
    expect(evaluate).toMatchObject({
      kind: "evaluate",
      trigger: "manual",
      fromStatus: "canary",
      toStatus: "canary",
      fromTrafficPercent: 10,
      toTrafficPercent: 10,
      actor: "operator",
    });
    expect(evaluate?.reason).toContain("thresholds");
  }, 30_000);

  it("rejects a tampered eval snapshot before scoring", async () => {
    const {
      baselineDir,
      canaryDir,
      evidence,
      statePath,
      decisionsPath,
      archive,
    } = await setup();
    const snapshot = await createEvalSnapshot({
      cycleId: "evl_tamper",
      packDir: baselineDir,
      cyclesRoot: path.join(path.dirname(baselineDir), "cycles"),
      freeze: false,
    });
    await writeFile(
      path.join(snapshot.dir, "evals", "visible", "rubrics.yaml"),
      "tampered: true\n",
      "utf8",
    );
    await startCanary(baselineDir, canaryDir, {
      trafficPercent: 10,
      statePath,
      decisionsPath,
    });

    await expect(
      evaluateCanary([evidence], {
        stub: true,
        archive,
        statePath,
        decisionsPath,
        evalDir: snapshot.dir,
      }),
    ).rejects.toThrow(/frozen eval snapshot failed verification/);
  }, 30_000);

  it("promotes the canary and moves the champion", async () => {
    const { baselineDir, canaryDir, statePath, decisionsPath } = await setup();
    await startCanary(baselineDir, canaryDir, {
      trafficPercent: 30,
      statePath,
      decisionsPath,
    });

    const state = await markCanaryPromoted("promoted by test", {
      statePath,
      decisionsPath,
    });
    expect(state.canary?.status).toBe("promoted");
    expect(state.canary?.trafficPercent).toBe(0);
    expect(state.champion.path).toBe(path.resolve(canaryDir));

    const promote = (await readDecisions(decisionsPath)).at(-1);
    expect(promote).toMatchObject({
      kind: "promote",
      fromStatus: "canary",
      toStatus: "promoted",
      fromTrafficPercent: 30,
      toTrafficPercent: 0,
      trigger: "manual",
    });
  }, 30_000);
});
