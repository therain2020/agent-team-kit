import { describe, expect, it } from "vitest";
import { runModeSchema } from "../src/event";
import {
  RUN_MODE_POLICIES,
  RunModeGuardError,
  assertRunModeOutboundAllowed,
  assertRunModeSideEffectAllowed,
  buildEffectKey,
  credentialsForRunMode,
  isLiveRunMode,
  runModeAllowsOutbound,
  runModeAllowsRealSideEffect,
  runModeArtifactLabel,
  runModePolicy,
} from "../src/run-mode";

describe("run mode policy (20 §2.4)", () => {
  it("has a row for every run mode", () => {
    for (const mode of runModeSchema.options) {
      expect(RUN_MODE_POLICIES[mode].mode).toBe(mode);
    }
    expect(Object.keys(RUN_MODE_POLICIES)).toHaveLength(
      runModeSchema.options.length,
    );
  });

  it("only LIVE executes real side effects with production credentials", () => {
    for (const mode of runModeSchema.options) {
      const policy = runModePolicy(mode);
      if (mode === "LIVE") {
        expect(policy.credentialScope).toBe("production");
        expect(policy.sideEffects).toBe("execute");
        expect(policy.artifactVisibility).toBe("official");
        expect(policy.outbound).toBe("allowlist");
        expect(isLiveRunMode(mode)).toBe(true);
        expect(runModeAllowsRealSideEffect(mode)).toBe(true);
        expect(runModeAllowsOutbound(mode)).toBe(true);
      } else {
        expect(isLiveRunMode(mode)).toBe(false);
        expect(runModeAllowsRealSideEffect(mode)).toBe(false);
        expect(runModeAllowsOutbound(mode)).toBe(false);
        expect(policy.credentialScope).toBe("sandbox");
        expect(policy.outbound).toBe("deny");
        expect(policy.artifactVisibility).toBe("internal");
      }
    }
    expect(runModeAllowsOutbound("DRY_RUN")).toBe(false);
  });

  it("labels replay artifacts by mode", () => {
    expect(runModeArtifactLabel("REPLAY")).toBe("replay");
    expect(runModeArtifactLabel("FORK")).toBe("fork");
    expect(runModeArtifactLabel("BACKFILL")).toBe("backfill");
    expect(runModeArtifactLabel("SHADOW")).toBe("shadow");
    expect(runModeArtifactLabel("LIVE")).toBe("official");
  });

  it("refuses real side effects outside LIVE without an effect approval", () => {
    for (const mode of [
      "REPLAY",
      "FORK",
      "BACKFILL",
      "DRY_RUN",
      "SHADOW",
    ] as const) {
      expect(() =>
        assertRunModeSideEffectAllowed({
          runMode: mode,
          action: "delivery.webhook",
        }),
      ).toThrowError(RunModeGuardError);
      try {
        assertRunModeSideEffectAllowed({
          runMode: mode,
          action: "delivery.webhook",
        });
      } catch (error) {
        expect((error as RunModeGuardError).code).toBe("side_effect_refused");
        expect((error as RunModeGuardError).mode).toBe(mode);
      }
    }
  });

  it("allows LIVE and an explicitly approved effect key", () => {
    expect(
      assertRunModeSideEffectAllowed({
        runMode: "LIVE",
        action: "delivery.webhook",
      }).sideEffects,
    ).toBe("execute");

    const effectKey = buildEffectKey({
      tenantId: "default",
      runId: "run_1",
      stageId: "stage_1",
      action: "delivery",
      target: "webhook",
    });
    expect(effectKey).toBe("default:run_1:stage_1:delivery:webhook");

    expect(() =>
      assertRunModeSideEffectAllowed({
        runMode: "BACKFILL",
        action: "delivery.webhook",
        effectKey,
        approval: {
          effectKey,
          approvalId: "apr_1",
          approvedBy: "therain2020",
        },
      }),
    ).not.toThrow();
  });

  it("does not accept an approval for a different effect key", () => {
    expect(() =>
      assertRunModeSideEffectAllowed({
        runMode: "FORK",
        action: "delivery.webhook",
        effectKey: "default:run_1:stage_1:delivery:webhook",
        approval: {
          effectKey: "default:run_1:stage_1:delivery:email",
          approvalId: "apr_1",
          approvedBy: "therain2020",
        },
      }),
    ).toThrowError(RunModeGuardError);
  });

  it("denies outbound for non-LIVE runs", () => {
    expect(() =>
      assertRunModeOutboundAllowed("REPLAY", "https://example.com/hook"),
    ).toThrowError(RunModeGuardError);
    expect(() =>
      assertRunModeOutboundAllowed("LIVE", "https://example.com/hook"),
    ).not.toThrow();
  });

  it("only exposes sandbox credentials to non-LIVE runs", () => {
    const env = {
      KIT_SANDBOX_GH_TOKEN: "sandbox-token",
      KIT_SMTP_PASS: "production-secret",
      GITHUB_TOKEN: "production-token",
      KIT_HOME: "/tmp/home",
    };
    expect(credentialsForRunMode("LIVE", env)).toEqual(env);
    expect(credentialsForRunMode("REPLAY", env)).toEqual({
      KIT_SANDBOX_GH_TOKEN: "sandbox-token",
    });
    expect(credentialsForRunMode("DRY_RUN", env)).toEqual({
      KIT_SANDBOX_GH_TOKEN: "sandbox-token",
    });
  });
});
