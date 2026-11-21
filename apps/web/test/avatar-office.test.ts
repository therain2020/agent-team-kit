import { DEFAULT_AVATAR, normalizeAvatar } from "@kit/core/avatar";
import { describe, expect, it } from "vitest";
import type { OfficeAgentView } from "../lib/office";
import { deriveLiveAgents } from "../lib/office-live";

function agent(overrides: Partial<OfficeAgentView> = {}): OfficeAgentView {
  return {
    id: "worker",
    isManager: false,
    description: "Worker",
    model: "deepseek-flash",
    role: "builder",
    tools: [],
    skills: [],
    status: "idle",
    activity: "Waiting for a mission",
    activityKind: "waitingMission",
    ...overrides,
  };
}

describe("office avatar propagation", () => {
  it("carries the persisted avatar through the live projection", () => {
    const [live] = deriveLiveAgents(
      [agent({ avatar: DEFAULT_AVATAR })],
      null,
      [],
    );
    expect(live?.avatar).toEqual(DEFAULT_AVATAR);
  });

  it("keeps agents without an avatar on the generated sprite", () => {
    const [live] = deriveLiveAgents([agent()], null, []);
    expect(live?.avatar).toBeUndefined();
  });
});

describe("invalid stored avatars", () => {
  it("fall back to null instead of throwing on bad data", () => {
    expect(normalizeAvatar(undefined)).toBeNull();
    expect(normalizeAvatar({ ...DEFAULT_AVATAR, width: 32 })).toBeNull();
    expect(
      normalizeAvatar({ ...DEFAULT_AVATAR, pixels: "z".repeat(384) }),
    ).toBeNull();
    expect(normalizeAvatar(DEFAULT_AVATAR)).toEqual(DEFAULT_AVATAR);
  });
});
