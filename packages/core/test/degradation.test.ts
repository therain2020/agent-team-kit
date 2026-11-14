import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPENDENCIES,
  DegradationContractError,
  activeModeFor,
  enterDegradedMode,
  evaluateQualityFloor,
  exitDegradedMode,
  findDependency,
  isExecutionBlocked,
  stageFailureMode,
} from "../src/index";

const at = "2026-11-15T00:00:00.000Z";

function workspaceMode(overrides: Record<string, unknown> = {}) {
  return enterDegradedMode({
    scope: "workspace",
    workspaceId: "ws-1",
    kind: "degraded",
    triggers: [{ dependencyId: "model.provider", reason: "provider down" }],
    behavior: "pause affected stages and serve LKG",
    actor: "tester",
    now: at,
    ...overrides,
  });
}

describe("degradation contract", () => {
  it("declares the fail-open / fail-closed posture for every dependency", () => {
    expect(findDependency("event_bus")?.failureMode).toBe("fail_open");
    expect(findDependency("source_api")?.failureMode).toBe("fail_open");
    expect(findDependency("artifact_store")?.failureMode).toBe("fail_closed");
    expect(findDependency("delivery")?.failureMode).toBe("fail_closed");
    expect(DEFAULT_DEPENDENCIES.length).toBeGreaterThanOrEqual(5);
  });

  it("defaults stages to fail-open but accepts an explicit override", () => {
    expect(stageFailureMode({})).toBe("fail_open");
    expect(stageFailureMode({ failureMode: "fail_closed" })).toBe(
      "fail_closed",
    );
  });

  it("rejects unknown dependencies instead of silently degrading", () => {
    expect(() =>
      workspaceMode({
        triggers: [{ dependencyId: "nope", reason: "unknown" }],
      }),
    ).toThrow(DegradationContractError);
  });

  it("requires a workspace id for workspace scope", () => {
    expect(() => workspaceMode({ workspaceId: undefined })).toThrow(
      /workspaceId/,
    );
  });

  it("only allows global scope for a security event", () => {
    expect(() =>
      workspaceMode({ scope: "global", workspaceId: undefined }),
    ).toThrow(/security event/);

    const global = workspaceMode({
      scope: "global",
      workspaceId: undefined,
      securityEvent: true,
      triggers: [{ dependencyId: "artifact_store", reason: "compromised" }],
    });
    expect(global.scope).toBe("global");
    expect(global.workspaceId).toBe("*");
  });

  it("isolates a workspace failure from other workspaces", () => {
    const mode = workspaceMode();
    expect(activeModeFor([mode], "ws-1")?.modeId).toBe(mode.modeId);
    expect(activeModeFor([mode], "ws-2")).toBeNull();

    const global = workspaceMode({
      scope: "global",
      workspaceId: undefined,
      securityEvent: true,
    });
    expect(activeModeFor([mode, global], "ws-2")?.scope).toBe("global");
  });

  it("blocks new execution only in read-only mode", () => {
    const degraded = workspaceMode();
    expect(isExecutionBlocked(degraded)).toBe(false);
    const readOnly = workspaceMode({ kind: "read_only" });
    expect(isExecutionBlocked(readOnly)).toBe(true);
    expect(isExecutionBlocked(null)).toBe(false);
  });

  it("enforces the stable window and quality recheck before exiting", () => {
    const mode = workspaceMode({
      exitCriteria: { minStableMinutes: 10, requireQualityRecheck: true },
    });

    expect(
      exitDegradedMode(mode, {
        actor: "tester",
        reason: "recovered",
        now: "2026-11-15T00:05:00.000Z",
        qualityRecheck: { pass: true },
      }).ok,
    ).toBe(false);

    expect(
      exitDegradedMode(mode, {
        actor: "tester",
        reason: "recovered",
        now: "2026-11-15T00:10:00.000Z",
      }).ok,
    ).toBe(false);

    const exited = exitDegradedMode(mode, {
      actor: "tester",
      reason: "recovered",
      now: "2026-11-15T00:10:00.000Z",
      qualityRecheck: { pass: true },
    });
    expect(exited.ok).toBe(true);
    expect(exited.mode.status).toBe("exited");
    expect(exited.mode.exitReason).toBe("recovered");
  });

  it("fails outputs that miss the quality floor", () => {
    const short = evaluateQualityFloor("TODO", {
      minChars: 20,
      forbiddenPatterns: ["TODO"],
    });
    expect(short.pass).toBe(false);
    expect(short.reasons).toHaveLength(2);

    expect(
      evaluateQualityFloor("A complete and cited answer with sources.", {
        minChars: 20,
        forbiddenPatterns: ["TODO", "{{"],
      }).pass,
    ).toBe(true);
  });
});
