import { describe, expect, it } from "vitest";
import {
  CHANGE_PROMOTION_STATES,
  CHANGE_TRANSITIONS,
  ChangeGuardError,
  ChangeTransitionError,
  type NewChangeProposalInput,
  applyChangeTransition,
  assertPromotionAllowed,
  assertRollbackAllowed,
  isFailureState,
  isRevertible,
  newChangeProposal,
  nextChangeState,
} from "../src/change";

const AT = "2026-11-20T00:00:00.000Z";

function proposal(overrides: Partial<NewChangeProposalInput> = {}) {
  return newChangeProposal({
    workspaceId: "ws",
    substrate: "code",
    producer: "iterate",
    signalRefs: ["iterations:it_1/task-a"],
    hypothesis: "fix the flaky verification step",
    acceptance: ["typecheck, test and lint pass"],
    risk: "low",
    revertRef: "commit:abc123",
    now: AT,
    ...overrides,
  });
}

function advance(
  current: ReturnType<typeof proposal>,
  trigger: Parameters<typeof applyChangeTransition>[1]["trigger"],
) {
  return applyChangeTransition(current, {
    trigger,
    actor: "test",
    reason: `${trigger} in test`,
    at: AT,
  });
}

describe("change proposal contract", () => {
  it("creates a proposed proposal with a submission audit row", () => {
    const created = proposal();
    expect(created.state).toBe("proposed");
    expect(created.version).toBe(0);
    expect(created.history).toHaveLength(1);
    expect(created.history[0]).toMatchObject({
      from: null,
      to: "proposed",
      trigger: "submit",
    });
    expect(created.outcome).toBeNull();
    expect(created.evalPlan).toEqual({
      checks: [],
      evalRefs: [],
      snapshotRef: null,
    });
  });

  it("walks the full happy path with one audit row per transition", () => {
    let current = proposal();
    for (const trigger of [
      "evaluate",
      "evaluation_passed",
      "canary",
      "promote",
      "observe",
    ] as const) {
      current = advance(current, trigger);
    }
    expect(current.state).toBe("observed");
    expect(current.version).toBe(5);
    expect(current.history).toHaveLength(6);
    expect(current.history.at(-1)).toMatchObject({
      from: "promoted",
      to: "observed",
      trigger: "observe",
    });
    const auditIds = new Set(current.history.map((entry) => entry.auditId));
    expect(auditIds.size).toBe(current.history.length);
    expect(current.outcome).toMatchObject({
      state: "observed",
      decidedBy: "test",
    });
  });

  it("rejects illegal transitions instead of silently ignoring them", () => {
    const created = proposal();
    expect(() => advance(created, "promote")).toThrow(ChangeTransitionError);
    expect(() => advance(created, "observe")).toThrow(ChangeTransitionError);
    expect(() => advance(advance(created, "evaluate"), "canary")).toThrow(
      ChangeTransitionError,
    );
  });

  it("keeps failure states explicit and revertible", () => {
    const failed = advance(advance(proposal(), "evaluate"), "fail");
    expect(failed.state).toBe("failed");
    expect(isFailureState(failed.state)).toBe(true);
    expect(isRevertible(failed.state)).toBe(true);

    const rolled = advance(failed, "rollback");
    expect(rolled.state).toBe("rolled_back");
    expect(isRevertible(rolled.state)).toBe(false);
    expect(() => advance(rolled, "rollback")).toThrow(ChangeTransitionError);

    const blocked = advance(proposal(), "block");
    expect(blocked.state).toBe("blocked");
    // A blocked proposal may retry evaluation or roll back.
    expect(advance(blocked, "evaluate").state).toBe("evaluating");
    expect(advance(blocked, "rollback").state).toBe("rolled_back");
  });

  it("declares promotable states and rejects terminal transitions", () => {
    expect(CHANGE_PROMOTION_STATES).toEqual(["evaluated", "canary"]);
    expect(nextChangeState("rolled_back", "promote")).toBeNull();
    expect(nextChangeState("evaluated", "promote")).toBe("promoted");
    expect(Object.keys(CHANGE_TRANSITIONS.rolled_back)).toEqual([]);
  });

  it("rejects unknown substrate and risk values", () => {
    expect(() => proposal({ substrate: "model" as never })).toThrow();
    expect(() => proposal({ risk: "critical" as never })).toThrow();
    expect(() => proposal({ acceptance: [] })).toThrow();
  });
});

describe("change promotion and rollback guards", () => {
  it("allows promotion only after evaluation with a revert reference", () => {
    const evaluated = advance(
      advance(proposal(), "evaluate"),
      "evaluation_passed",
    );
    expect(() => assertPromotionAllowed(evaluated)).not.toThrow();
    expect(() => assertRollbackAllowed(evaluated)).not.toThrow();
  });

  it("rejects promotion without an evaluation audit row", () => {
    const created = proposal();
    expect(() => assertPromotionAllowed(created)).toThrow(ChangeGuardError);
    try {
      assertPromotionAllowed(created);
    } catch (error) {
      expect((error as ChangeGuardError).code).toBe("illegal_state");
    }
  });

  it("rejects promotion without a revertRef", () => {
    const evaluated = advance(
      advance(proposal({ revertRef: null }), "evaluate"),
      "evaluation_passed",
    );
    try {
      assertPromotionAllowed(evaluated);
      throw new Error("expected a guard error");
    } catch (error) {
      expect(error).toBeInstanceOf(ChangeGuardError);
      expect((error as ChangeGuardError).code).toBe("missing_revert_ref");
    }
  });

  it("rejects high-risk promotion without an approvalRef", () => {
    const evaluated = advance(
      advance(proposal({ risk: "high" }), "evaluate"),
      "evaluation_passed",
    );
    try {
      assertPromotionAllowed(evaluated);
      throw new Error("expected a guard error");
    } catch (error) {
      expect(error).toBeInstanceOf(ChangeGuardError);
      expect((error as ChangeGuardError).code).toBe("missing_approval");
    }

    const approved = advance(
      advance(
        proposal({ risk: "high", approvalRef: "approval:apr_1" }),
        "evaluate",
      ),
      "evaluation_passed",
    );
    expect(() => assertPromotionAllowed(approved)).not.toThrow();
  });
});
