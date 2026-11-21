import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChangeGuardError } from "@kit/core";
import { initStore, loadStoreConfig } from "@kit/store";
import { afterEach, describe, expect, it } from "vitest";
import { adaptEvolutionChange, adaptIterationChange } from "../src/adapters";
import { ChangePipeline, requirePromotableProposal } from "../src/pipeline";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function localStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kit-change-pipeline-"));
  dirs.push(dir);
  const store = await initStore(
    loadStoreConfig({
      KIT_RUNTIME_MODE: "local",
      KIT_HOME: dir,
      KIT_BLOB_ROOT: path.join(dir, "blobs"),
    }),
  );
  closers.push(() => store.close());
  return store;
}

const AT = "2026-11-20T00:00:00.000Z";

function iterationPlan(risk: "low" | "high" = "low") {
  return adaptIterationChange({
    workspaceId: "ws",
    iterationId: "it_1",
    goal: "harden the verifier",
    task: {
      id: "task-a",
      domain: "cyber",
      goal: "make the sandbox check deterministic",
      acceptance: "typecheck, test and lint pass",
      risk,
    },
    result: {
      taskId: "task-a",
      verificationPass: true,
      applyStatus: "applied",
      commit: "abc123",
    },
    checks: ["typecheck", "test"],
    at: AT,
  });
}

function evolutionPlan() {
  return adaptEvolutionChange({
    workspaceId: "ws",
    cycle: {
      cycleId: "cyc_1",
      agentId: "analyst",
      hypothesis: "sharpen citation discipline",
      signalRefs: [
        { signalId: "sig_1", source: "archive", signal: "low pass" },
      ],
      baselineName: "baseline",
      candidateName: "candidate",
      baselinePass: true,
      candidatePass: true,
      baselineScore: 0.7,
      candidateScore: 0.8,
      decision: "canary",
      rationale: "candidate improved",
      autoApplied: false,
      createdAt: AT,
    },
    at: AT,
  });
}

describe("change pipeline", () => {
  it("records both loops on the same state machine", async () => {
    const store = await localStore();
    const pipeline = new ChangePipeline(store.changeProposals);

    const iterated = await pipeline.record(iterationPlan());
    const evolvePlan = evolutionPlan();
    if (!evolvePlan) {
      throw new Error("expected an evolution plan");
    }
    const evolved = await pipeline.record(evolvePlan);

    expect(iterated.producer).toBe("iterate");
    expect(iterated.state).toBe("promoted");
    expect(evolved.producer).toBe("evolve");
    expect(evolved.state).toBe("canary");

    const stored = await store.changeProposals.list({ workspaceId: "ws" });
    expect(stored).toHaveLength(2);
    const audit = await store.changeProposals.listTransitions(iterated.id);
    expect(audit.map((entry) => entry.to)).toEqual([
      "proposed",
      "evaluating",
      "evaluated",
      "promoted",
    ]);
    expect(audit.map((entry) => entry.actor)).toEqual([
      "shadow:iterate",
      "shadow:iterate",
      "shadow:iterate",
      "shadow:iterate",
    ]);
  });

  it("is idempotent per source record", async () => {
    const store = await localStore();
    const pipeline = new ChangePipeline(store.changeProposals);
    const first = await pipeline.record(iterationPlan());
    const replay = await pipeline.record(iterationPlan());
    expect(replay.id).toBe(first.id);
    const transitions = await store.changeProposals.listTransitions(first.id);
    expect(transitions).toHaveLength(4);
  });

  it("blocks promotion of a high-risk proposal without approval", async () => {
    const store = await localStore();
    const pipeline = new ChangePipeline(store.changeProposals);
    await expect(pipeline.record(iterationPlan("high"))).rejects.toBeInstanceOf(
      ChangeGuardError,
    );
    // The proposal and the evaluation audit exist; only the promotion was
    // refused, so an operator can still review and roll back.
    const stored = await store.changeProposals.get("chg_it_ws_it_1_task-a");
    expect(stored?.state).toBe("evaluated");
    expect(stored?.risk).toBe("high");
  });

  it("refuses promotion when the proposal has no evaluation audit", async () => {
    const store = await localStore();
    const pipeline = new ChangePipeline(store.changeProposals);
    const plan = iterationPlan();
    const created = await store.changeProposals.create(plan.proposal);
    await expect(
      requirePromotableProposal(store.changeProposals, created.id),
    ).rejects.toBeInstanceOf(ChangeGuardError);
  });
});
