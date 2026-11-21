import {
  type ChangeProposal,
  type ChangeState,
  applyChangeTransition,
} from "@kit/core";
import { describe, expect, it } from "vitest";
import {
  type ChangePlan,
  type EvolutionCycleLike,
  adaptEvolutionChange,
  adaptIterationChange,
} from "../src/adapters";

const AT = "2026-11-20T00:00:00.000Z";

function replay(plan: ChangePlan): ChangeProposal {
  let proposal = plan.proposal;
  for (const transition of plan.transitions) {
    proposal = applyChangeTransition(proposal, {
      trigger: transition.trigger,
      actor: transition.actor,
      reason: transition.reason,
      at: AT,
    });
  }
  return proposal;
}

function iteration(
  overrides: Partial<Parameters<typeof adaptIterationChange>[0]["result"]> = {},
  taskOverrides: Partial<
    Parameters<typeof adaptIterationChange>[0]["task"]
  > = {},
) {
  return {
    workspaceId: "ws",
    iterationId: "it_1",
    goal: "harden the verifier",
    task: {
      id: "task-a",
      domain: "cyber",
      goal: "make the sandbox check deterministic",
      acceptance: "typecheck, test and lint pass",
      risk: "low" as const,
      ...taskOverrides,
    },
    result: {
      taskId: "task-a",
      verificationPass: true,
      applyStatus: "applied",
      commit: "abc123",
      ...overrides,
    },
    checks: ["typecheck", "test"],
    at: AT,
  };
}

function evolution(
  decision: EvolutionCycleLike["decision"],
  overrides: Partial<EvolutionCycleLike> = {},
) {
  return {
    workspaceId: "ws",
    cycle: {
      cycleId: "cyc_1",
      agentId: "analyst",
      hypothesis: "sharpen citation discipline",
      signalRefs: [
        { signalId: "sig_1", source: "archive" as const, signal: "low pass" },
      ],
      baselineName: "cycle-1-baseline",
      candidateName: "cycle-1-candidate",
      baselinePass: true,
      candidatePass: true,
      baselineScore: 0.71,
      candidateScore: 0.83,
      decision,
      rationale: "candidate improved",
      autoApplied: decision === "promoted",
      createdAt: AT,
      evalSnapshotPath: "/tmp/cycles/cyc_1/eval",
      ...overrides,
    },
    at: AT,
  };
}

describe("iterate → ChangeProposal adapter", () => {
  it("maps an applied task to a promoted code proposal", () => {
    const plan = adaptIterationChange(iteration());
    const final = replay(plan);
    expect(plan.proposal.substrate).toBe("code");
    expect(plan.proposal.producer).toBe("iterate");
    expect(plan.proposal.id).toBe("chg_it_ws_it_1_task-a");
    expect(plan.proposal.signalRefs).toEqual(["iterations:it_1/task-a"]);
    expect(plan.proposal.revertRef).toBe("commit:abc123");
    expect(final.state).toBe("promoted");
    expect(final.history.map((entry) => entry.trigger)).toEqual([
      "submit",
      "evaluate",
      "evaluation_passed",
      "promote",
    ]);
    expect(final.outcome?.state).toBe("promoted");
  });

  it("maps a failed verification to the explicit failed state", () => {
    const final = replay(
      adaptIterationChange(
        iteration({ verificationPass: false, applyStatus: undefined }),
      ),
    );
    expect(final.state).toBe("failed");
    expect(final.outcome?.summary).toBe("verification did not pass");
  });

  it("maps a blocked apply to blocked and keeps the commit reference", () => {
    const plan = adaptIterationChange(
      iteration({ applyStatus: "blocked", commit: undefined }),
    );
    const final = replay(plan);
    expect(final.state).toBe("blocked");
    expect(plan.proposal.revertRef).toBeNull();
  });

  it("leaves a dry-run task resting in evaluated", () => {
    const final = replay(
      adaptIterationChange(
        iteration({ applyStatus: "skipped", commit: undefined }),
      ),
    );
    expect(final.state).toBe("evaluated");
  });
});

describe("evolve → ChangeProposal adapter", () => {
  it("maps an auto-promoted cycle to a promoted prompt proposal", () => {
    const plan = adaptEvolutionChange(evolution("promoted"));
    expect(plan).not.toBeNull();
    if (!plan) {
      throw new Error("expected a plan");
    }
    const final = replay(plan);
    expect(plan.proposal.substrate).toBe("prompt");
    expect(plan.proposal.producer).toBe("evolve");
    expect(plan.proposal.id).toBe("chg_cy_ws_cyc_1");
    expect(plan.proposal.signalRefs).toEqual(["evolve:archive:sig_1"]);
    expect(plan.proposal.evalPlan.snapshotRef).toBe("/tmp/cycles/cyc_1/eval");
    expect(plan.proposal.revertRef).toBe("variant:cycle-1-baseline");
    expect(final.state).toBe("promoted");
    expect(final.history.map((entry) => entry.trigger)).toEqual([
      "submit",
      "evaluate",
      "evaluation_passed",
      "canary",
      "promote",
    ]);
  });

  it("maps a canary cycle to the canary state", () => {
    const plan = adaptEvolutionChange(evolution("canary"));
    expect(plan).not.toBeNull();
    if (!plan) {
      throw new Error("expected a plan");
    }
    expect(replay(plan).state).toBe("canary");
  });

  it("maps a rejected cycle to failed", () => {
    const plan = adaptEvolutionChange(
      evolution("rejected", { rationale: "did not beat baseline" }),
    );
    expect(plan).not.toBeNull();
    if (!plan) {
      throw new Error("expected a plan");
    }
    const final = replay(plan);
    expect(final.state).toBe("failed");
    expect(final.outcome?.summary).toBe("did not beat baseline");
  });

  it("does not emit a proposal for a skipped cycle", () => {
    expect(adaptEvolutionChange(evolution("skipped"))).toBeNull();
  });

  it("maps an auto-promoted cycle's backup onto a structured instruction revert", () => {
    const plan = adaptEvolutionChange(
      evolution("promoted", {
        variantKind: "context",
        promote: {
          targetDir: "/packs/demo",
          backupDir: "/packs/demo/.backup/evolution/one",
          hash: "abc123",
          approvalRef: null,
        },
      }),
    );
    if (!plan) {
      throw new Error("expected a plan");
    }
    expect(plan.proposal.revert).toEqual({
      kind: "instruction",
      targetDir: "/packs/demo",
      backupDir: "/packs/demo/.backup/evolution/one",
      hash: "abc123",
    });
    expect(plan.proposal.approvalRef).toBeNull();
  });

  it("maps evolution surfaces to the unified substrate", () => {
    const skill = adaptEvolutionChange(
      evolution("canary", { variantKind: "tool" }),
    );
    const workflow = adaptEvolutionChange(
      evolution("canary", { variantKind: "architecture" }),
    );
    expect(skill?.proposal.substrate).toBe("skill");
    expect(workflow?.proposal.substrate).toBe("workflow");
  });

  it("records the promotion approval reference when supplied", () => {
    const plan = adaptEvolutionChange({
      ...evolution("promoted"),
      approvalRef: "apr_1",
    });
    expect(plan?.proposal.approvalRef).toBe("apr_1");
  });
});

describe("both loops share one contract and state machine", () => {
  it("produces the same required fields and legal states", () => {
    const iteratePlan = adaptIterationChange(iteration());
    const evolvePlan = adaptEvolutionChange(evolution("canary"));
    expect(evolvePlan).not.toBeNull();
    if (!evolvePlan) {
      throw new Error("expected a plan");
    }
    const required: Array<keyof ChangeProposal> = [
      "id",
      "substrate",
      "producer",
      "signalRefs",
      "hypothesis",
      "acceptance",
      "risk",
      "evalPlan",
      "revertRef",
      "budgetRef",
      "approvalRef",
      "outcome",
    ];
    for (const key of required) {
      expect(iteratePlan.proposal).toHaveProperty(key);
      expect(evolvePlan.proposal).toHaveProperty(key);
    }
    const iterateFinal = replay(iteratePlan);
    const evolveFinal = replay(evolvePlan);
    const states: ChangeState[] = [iterateFinal.state, evolveFinal.state];
    expect(states).toEqual(["promoted", "canary"]);
    // Both final states came from the same table, not a per-loop machine.
    expect(iterateFinal.history[0]?.trigger).toBe("submit");
    expect(evolveFinal.history[0]?.trigger).toBe("submit");
  });
});
