import { describe, expect, it } from "vitest";
import {
  type KillSwitch,
  KillSwitchTrippedError,
  assertKillSwitchPermission,
  isKillSwitchTrippedError,
  killSwitchSchema,
  normalizeKillSwitchIdentity,
  resolveKillSwitch,
} from "../src/index";

const at = "2026-11-15T00:00:00.000Z";

function killSwitch(overrides: Partial<KillSwitch> = {}): KillSwitch {
  return {
    switchId: "kill_1",
    scope: "global",
    target: "",
    workspaceId: null,
    state: "active",
    activatedBy: "operator",
    reason: "drill",
    activatedAt: at,
    releasedBy: null,
    releasedAt: null,
    releaseReason: null,
    version: 1,
    updatedAt: at,
    ...overrides,
  };
}

describe("kill switch contract", () => {
  it("rejects identities that do not match their scope", () => {
    expect(() =>
      killSwitchSchema.parse(
        killSwitch({ scope: "global", target: "default" }),
      ),
    ).toThrow();
    expect(() =>
      killSwitchSchema.parse(
        killSwitch({
          scope: "workspace",
          target: "other",
          workspaceId: "default",
        }),
      ),
    ).toThrow();
    expect(() =>
      killSwitchSchema.parse(
        killSwitch({ scope: "stage", target: "", workspaceId: "default" }),
      ),
    ).toThrow();
    expect(() =>
      killSwitchSchema.parse(
        killSwitch({ scope: "global", state: "released" }),
      ),
    ).toThrow();
  });

  it("normalizes scope identities", () => {
    expect(
      normalizeKillSwitchIdentity({
        scope: "global",
        target: "x",
        workspaceId: "default",
      }),
    ).toEqual({ target: "", workspaceId: null });
    expect(
      normalizeKillSwitchIdentity({
        scope: "workspace",
        workspaceId: " default ",
      }),
    ).toEqual({ target: "default", workspaceId: "default" });
    expect(
      normalizeKillSwitchIdentity({
        scope: "stage",
        target: " publish ",
        workspaceId: "default",
      }),
    ).toEqual({ target: "publish", workspaceId: "default" });
    expect(() =>
      normalizeKillSwitchIdentity({ scope: "stage", target: "" }),
    ).toThrow();
  });

  it("matches by scope and ignores released switches", () => {
    const active = killSwitch({
      scope: "workspace",
      target: "default",
      workspaceId: "default",
    });
    expect(resolveKillSwitch([active], { workspaceId: "default" })).toBe(
      active,
    );
    expect(resolveKillSwitch([active], { workspaceId: "other" })).toBeNull();
    expect(
      resolveKillSwitch(
        [
          {
            ...active,
            state: "released",
            releasedBy: "operator",
            releasedAt: at,
          },
        ],
        { workspaceId: "default" },
      ),
    ).toBeNull();
  });

  it("matches agent-source and stage switches only in range", () => {
    const agent = killSwitch({ scope: "agent-source", target: "writer" });
    expect(
      resolveKillSwitch([agent], { workspaceId: "a", agentId: "writer" }),
    ).toBe(agent);
    expect(
      resolveKillSwitch([agent], { workspaceId: "a", agentId: "reviewer" }),
    ).toBeNull();
    expect(
      resolveKillSwitch([agent], { workspaceId: "b", agentId: "writer" }),
    ).toBe(agent);

    const scopedAgent = killSwitch({
      scope: "agent-source",
      target: "writer",
      workspaceId: "a",
    });
    expect(
      resolveKillSwitch([scopedAgent], { workspaceId: "b", agentId: "writer" }),
    ).toBeNull();

    const stage = killSwitch({
      scope: "stage",
      target: "publish",
      workspaceId: "a",
    });
    expect(
      resolveKillSwitch([stage], { workspaceId: "a", stageName: "publish" }),
    ).toBe(stage);
    expect(
      resolveKillSwitch([stage], { workspaceId: "a", stageId: "run:publish" }),
    ).toBeNull();
    expect(
      resolveKillSwitch([stage], { workspaceId: "b", stageName: "publish" }),
    ).toBeNull();
  });

  it("resolves the broadest active switch first", () => {
    const global = killSwitch({ switchId: "g", scope: "global" });
    const workspace = killSwitch({
      switchId: "w",
      scope: "workspace",
      target: "default",
      workspaceId: "default",
      activatedAt: "2026-11-15T00:00:01.000Z",
    });
    const stage = killSwitch({
      switchId: "s",
      scope: "stage",
      target: "publish",
      activatedAt: "2026-11-15T00:00:02.000Z",
    });
    const context = { workspaceId: "default", stageName: "publish" };
    expect(resolveKillSwitch([stage, workspace], context)).toBe(workspace);
    expect(resolveKillSwitch([stage, workspace, global], context)).toBe(global);
  });

  it("enforces activation permissions", () => {
    expect(() =>
      assertKillSwitchPermission("global", "operator"),
    ).not.toThrow();
    expect(() => assertKillSwitchPermission("global", "security")).toThrow();
    expect(() =>
      assertKillSwitchPermission("workspace", "security"),
    ).not.toThrow();
    expect(() => assertKillSwitchPermission("workspace", "agent")).toThrow();
    expect(() => assertKillSwitchPermission("stage", "agent")).not.toThrow();
  });

  it("carries the tripped switch on the error", () => {
    const active = killSwitch({ scope: "stage", target: "publish" });
    const error = new KillSwitchTrippedError(active, "stage");
    expect(isKillSwitchTrippedError(error)).toBe(true);
    expect(error.checkpoint).toBe("stage");
    expect(error.killSwitch.switchId).toBe("kill_1");
    expect(isKillSwitchTrippedError(new Error("other"))).toBe(false);
  });
});
