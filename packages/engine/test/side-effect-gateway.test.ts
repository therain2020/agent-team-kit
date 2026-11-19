import { describe, expect, it } from "vitest";
import { createSideEffectGateway } from "../src/side-effect-gateway";

function gateway() {
  const audits: Array<Record<string, unknown>> = [];
  return {
    audits,
    gateway: createSideEffectGateway({
      store: {} as never,
      appendAudit: async (entry) => {
        audits.push(entry as unknown as Record<string, unknown>);
      },
    }),
  };
}

describe("side-effect gateway (20 §2.4)", () => {
  it("executes the real side effect for LIVE runs", async () => {
    const { gateway: effects, audits } = gateway();
    let calls = 0;

    const outcome = await effects.run(
      {
        workspaceId: "default",
        runId: "run_live",
        runMode: "LIVE",
        action: "delivery.webhook",
      },
      {
        execute: async () => {
          calls += 1;
          return "sent";
        },
        stub: () => "stub",
      },
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.value).toBe("sent");
    expect(calls).toBe(1);
    expect(audits).toEqual([]);
  });

  it.each(["REPLAY", "FORK", "BACKFILL", "DRY_RUN", "SHADOW"] as const)(
    "refuses real side effects in %s runs",
    async (runMode) => {
      const { gateway: effects, audits } = gateway();
      let calls = 0;

      const outcome = await effects.run(
        {
          workspaceId: "default",
          runId: `run_${runMode}`,
          runMode,
          action: "delivery.webhook",
          target: "webhook",
        },
        {
          execute: async () => {
            calls += 1;
            return "sent";
          },
          stub: () => "stubbed",
        },
      );

      expect(outcome.executed).toBe(false);
      expect(outcome.value).toBe("stubbed");
      expect(calls).toBe(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        runId: `run_${runMode}`,
        runMode,
        action: "delivery.webhook",
      });
    },
  );

  it("executes a non-LIVE side effect only with an explicit effect approval", async () => {
    const { gateway: effects } = gateway();
    const effectKey = "default:run_1:stage_1:delivery:webhook";

    const outcome = await effects.run(
      {
        workspaceId: "default",
        runId: "run_1",
        stageId: "stage_1",
        runMode: "BACKFILL",
        action: "delivery.webhook",
        effectKey,
        approval: {
          effectKey,
          approvalId: "apr_1",
          approvedBy: "ops",
        },
      },
      {
        execute: async () => "sent",
        stub: () => "stubbed",
      },
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.value).toBe("sent");
  });
});
